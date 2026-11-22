"""Course API backed by the catalog files supplied in database/."""
import csv
import hashlib
import re
from collections import Counter
from pathlib import Path
from typing import Protocol

from contextlib import asynccontextmanager
import httpx
from fastapi import FastAPI, HTTPException, Response
from pydantic import BaseModel, Field

CATALOG_PATH = Path(__file__).resolve().parents[2] / 'database' / 'grinnell_spring_2027_courses.csv'
REQUIRED_COLUMNS = {'course_code', 'course_name', 'department_code', 'description_prerequisite', 'system_requisites', 'catalog_notes', 'credits', 'course_description'}


class Course(BaseModel):
    id: str
    code: str
    title: str
    department: str
    level: int
    credits: float | None = Field(default=None, ge=0, allow_inf_nan=False)
    credit_display: str | None = None
    description: str | None = None
    prerequisites: str | None = None
    system_requisites: str | None = None
    catalog_notes: str | None = None
    source_term: str
    source_file: str


class CourseRepository(Protocol):
    def list(self) -> list[Course]: ...
    def get(self, course_id: str) -> Course | None: ...


class CsvCourseRepository:
    """Read-only adapter. Reload changed files; preserve distinct topic titles."""
    def __init__(self, path: Path, term: str = 'Spring 2027'):
        self.path = path
        self.term = term
        self._signature: tuple[int, int] | None = None
        self._courses: list[Course] = []
        self.list()  # Fail clearly on missing or malformed catalog at startup.

    def list(self) -> list[Course]:
        stat = self.path.stat()
        signature = (stat.st_mtime_ns, stat.st_size)
        if signature == self._signature:
            return self._courses
        with self.path.open(encoding='utf-8-sig', newline='') as source:
            reader = csv.DictReader(source)
            missing = REQUIRED_COLUMNS - set(reader.fieldnames or [])
            if missing:
                raise ValueError(f'{self.path.name}: missing columns: {", ".join(sorted(missing))}')
            rows = list(reader)
        counts = Counter((row.get('course_code') or '').strip().upper() for row in rows)
        courses = []
        identities = Counter(
            (row.get('course_code') or '').strip().upper() + '\0' + ' '.join((row.get('course_name') or '').casefold().split())
            for row in rows
        )
        seen = set()
        for line, row in enumerate(rows, start=2):
            code = (row.get('course_code') or '').strip().upper()
            title = (row.get('course_name') or '').strip()
            department = (row.get('department_code') or '').strip().upper()
            match = re.fullmatch(r'([A-Z]+)-(\d{3})([A-Z]*)', code)
            if not match or not title or department != match[1]:
                raise ValueError(f'{self.path.name}:{line}: invalid course code, title, or department')
            identity = (code, ' '.join(title.casefold().split()))
            seen.add(identity)
            course_id = code.lower()
            # Topic IDs must stay stable when more topics with that code are added.
            if counts[code] > 1 or match[2] in {'195', '295', '395'} or code == 'WIL-101' or identities[code + '\0' + identity[1]] > 1:
                duplicate_index = sum(1 for previous in rows[:line-2] if (previous.get('course_code') or '').strip().upper() == code and ' '.join((previous.get('course_name') or '').casefold().split()) == identity[1])
                digest = hashlib.sha256(identity[1].encode()).hexdigest()[:12]
                course_id += f'-{digest}'
                if identities[code + '\0' + identity[1]] > 1:
                    course_id += f'-{duplicate_index + 1}'
            def value(key: str) -> str | None:
                # Preserve literal "None" from the source; it is not a missing field.
                return (row.get(key) or '').strip() or None
            credit_text = value('credits')
            if credit_text in {None, 'None'}:
                credits, credit_display = None, None
            elif re.fullmatch(r'\d+(?:\.\d+)?', credit_text):
                credits, credit_display = float(credit_text), credit_text
            elif re.fullmatch(r'\d+(?:\.\d+)?-\d+(?:\.\d+)?', credit_text):
                credits, credit_display = None, credit_text
            else:
                raise ValueError(f'{self.path.name}:{line}: invalid credits {credit_text!r}')
            courses.append(Course(
                id=course_id, code=code.replace('-', ' ', 1), title=title,
                department=department, level=int(match[2]) // 100 * 100,
                credits=credits, credit_display=credit_display, description=value('course_description'),
                prerequisites=value('description_prerequisite'),
                system_requisites=value('system_requisites'), catalog_notes=value('catalog_notes'),
                source_term=self.term, source_file=self.path.name,
            ))
        if not courses:
            raise ValueError(f'{self.path.name}: catalog is empty')
        if len({c.id for c in courses}) != len(courses):
            raise ValueError(f'{self.path.name}: course ID collision')
        self._courses, self._signature = courses, signature
        return self._courses

    def get(self, course_id: str) -> Course | None:
        return next((course for course in self.list() if course.id == course_id), None)


repository: CourseRepository = CsvCourseRepository(CATALOG_PATH)

@asynccontextmanager
async def lifespan(app: FastAPI):
    from .advisor.ollama import Ollama
    client = httpx.AsyncClient(trust_env=False, follow_redirects=False)
    app.state.ollama = Ollama(client)
    app.state.catalog_provider = repository
    try:
        yield
    finally:
        await client.aclose()

app = FastAPI(
    title='Fieldnotes course API',
    description='Spring 2027 catalog supplied in database/. Fixed credits are numeric; credit ranges are preserved as display text. Prerequisite text is displayed, not enforced.',
    version='1.1.0',
    lifespan=lifespan,
)


@app.get('/api/health')
def health():
    return {'status': 'ok', 'data_source': 'csv', 'source_file': CATALOG_PATH.name, 'course_count': len(repository.list())}


@app.get('/api/courses', response_model=list[Course])
def courses(response: Response):
    from .advisor.rules import catalog_revision
    rows = repository.list()
    response.headers['X-Catalog-Revision'] = catalog_revision(rows)
    return rows


@app.get('/api/courses/{course_id}', response_model=Course)
def course(course_id: str):
    result = repository.get(course_id)
    if result is None:
        raise HTTPException(status_code=404, detail='Course not found')
    return result

from .advisor.routes import router as advisor_router
app.include_router(advisor_router)

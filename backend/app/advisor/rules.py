"""Deterministic catalog snapshots, term math, requisite checks and simulation."""
from collections import defaultdict
from decimal import Decimal
import hashlib, json, re
from functools import lru_cache
from .requisites import CODE, course_requirements

SEMESTERS = [f"semester-{i}" for i in range(8)]

def course_identity(course):
    # Both listings of a cross-listed course may have distinct catalog IDs.
    if re.match(r"^(?:also listed as|see)\s+", course.description or "", re.I):
        return (course.code.split()[-1], course.title.casefold())
    return (course.code,)

def catalog_revision(courses):
    rows = [c.model_dump(mode="json") for c in courses]
    rows.sort(key=lambda x: x["id"])
    payload = json.dumps(rows, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return hashlib.sha256(payload.encode()).hexdigest()

def term_label(semester_id, start_year):
    i = int(semester_id.split("-")[1])
    return f"{'Fall' if i % 2 == 0 else 'Spring'} {start_year + i // 2 + (i % 2)}"

def snapshot(courses):
    return {"by_id": {c.id: c for c in courses}, "by_code": defaultdict(list)} | _code_map(courses)

def _code_map(courses):
    result = defaultdict(list)
    for course in courses:
        result[course.code.upper().replace(" ", "-")].append(course)
    return {"by_code": result}

def totals(plan, courses):
    by_id = {c.id: c for c in courses}
    result = {}
    for sid in SEMESTERS:
        rows = [e for e in plan.entries if e.semester_id == sid]
        total = Decimal("0")
        for row in rows:
            course = by_id.get(row.course_id)
            if course is None or course.credits is None:
                total = None
                break
            total += Decimal(str(course.credits))
        result[sid] = (len(rows), float(total) if total is not None else None)
    return result

def evidence(course, field):
    value = getattr(course, field, None)
    if not value:
        return None
    text = " ".join(str(value).split())[:240]
    from .schemas import Evidence
    return Evidence(courseId=course.id, field=field, excerpt=text)

def requisite_status(course, plan, courses, *, by_id=None):
    rules, review = course_requirements(course)
    if not rules and not review:
        return "no_issue_in_plan", [], []
    ev = [item for field in ("prerequisites", "system_requisites", "catalog_notes")
          if (item := evidence(course, field)) is not None]
    current = next((SEMESTERS.index(e.semester_id) for e in plan.entries if e.course_id == course.id), None)
    if rules and current is None:
        return "needs_review", ev, []
    if not rules:
        return "needs_review", ev, []

    by_id = by_id if by_id is not None else {c.id: c for c in courses}
    placements = defaultdict(list)
    for entry in plan.entries:
        if entry.course_id == course.id:
            continue
        planned = by_id.get(entry.course_id)
        if planned:
            code = planned.code
        elif match := CODE.fullmatch(entry.course_id):
            code = f"{match[1]} {match[2]}".upper()
        else:
            continue
        placements[code].append(SEMESTERS.index(entry.semester_id))

    eligible = {"prior": lambda term: term < current, "same": lambda term: term == current,
                "concurrent": lambda term: term <= current}
    missing = []
    for timing, codes, review_codes in rules:
        if not any(eligible[timing](term) for code in codes for term in placements[code]):
            if any(eligible[timing](term) for code in review_codes for term in placements[code]):
                review = True
            else:
                missing.append(" or ".join(codes + review_codes))
    if missing:
        return "sequence_gap", ev, missing
    return ("needs_review" if review else "no_issue_in_plan"), ev, []

def status_map(plan, courses):
    result = {}
    for course in courses:
        if any(e.course_id == course.id for e in plan.entries):
            result[course.id] = requisite_status(course, plan, courses)
    return result

def availability(course, semester_id, start_year):
    from .schemas import Placement
    term = term_label(semester_id, start_year)
    return "listed_in_source_term" if term == course.source_term else "term_unverified"

def fixed_credit(course):
    return None if course.credits is None else Decimal(str(course.credits))


GOAL_STOP_WORDS = {"and", "are", "can", "class", "classes", "course", "courses", "focus", "for", "from", "have",
                   "interested", "into", "like", "more", "plan", "some", "take", "that", "the", "want", "with", "would"}


@lru_cache(maxsize=128)
def _goal_tokens(goals):
    return frozenset(re.findall(r"\b[a-z]{3,}\b", goals.lower())) - GOAL_STOP_WORDS


def goal_score(course, goals):
    if not goals:
        return 0
    department, number = course.code.split(maxsplit=1)
    if re.search(rf"\b{re.escape(department)}[-\s]+{re.escape(number)}\b", goals, re.I):
        return 5
    tokens = _goal_tokens(goals)
    title_words = set(re.findall(r"\b[a-z]{3,}\b", course.title.lower())) | {department.lower()}
    subject_words = set(re.findall(r"\b[a-z]{3,}\b", (course.description or "").lower()))
    return min(5, 2 * len(tokens & title_words) + len(tokens & (subject_words - title_words)))

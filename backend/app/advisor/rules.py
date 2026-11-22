"""Deterministic catalog snapshots, term math, requisite checks and simulation."""
from collections import defaultdict
from decimal import Decimal
import hashlib, json, re

SEMESTERS = [f"semester-{i}" for i in range(8)]
SUPPORTED = {
    "csc-161": ("Computer Science 151", "CSC-151 - Must be completed prior to taking this course."),
    "csc-207": ("Computer Science 151 and 161", "CSC-151 and CSC-161 - Must be completed prior to taking this course."),
    "mat-133": ("Mathematics 124 or 131", "MAT-124 or MAT-131 - Must be completed prior to taking this course."),
    "mat-215": ("Mathematics 133", "MAT-133 - Must be completed prior to taking this course."),
    "chm-129": ("None", "Take CHM-129L - Must be taken at the same time as this course."),
}

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

def requisite_status(course, plan, courses):
    if course.id not in SUPPORTED:
        values = [course.prerequisites, course.system_requisites, course.catalog_notes]
        if values == ["None", "None", None]:
            return "no_issue_in_plan", [], []
        fields = ["prerequisites", "system_requisites", "catalog_notes"]
        ev = [evidence(course, f) for f in fields]
        return "needs_review", [x for x in ev if x], []
    expected = SUPPORTED[course.id]
    if (course.prerequisites, course.system_requisites) != expected or course.catalog_notes:
        ev = [evidence(course, f) for f in ("prerequisites", "system_requisites", "catalog_notes")]
        return "needs_review", [x for x in ev if x], []
    placements = defaultdict(list)
    by_id = {c.id: c for c in courses}
    for e in plan.entries:
        placements[e.course_id].append(SEMESTERS.index(e.semester_id))
    idx = {e.course_id: SEMESTERS.index(e.semester_id) for e in plan.entries}
    current = idx.get(course.id)
    if course.id == "csc-161":
        clauses = [("csc-151", lambda p: current is not None and p < current)]
    elif course.id == "csc-207":
        clauses = [("csc-151", lambda p: current is not None and p < current), ("csc-161", lambda p: current is not None and p < current)]
    elif course.id == "mat-133":
        alternatives = [c.id for c in courses if c.code.upper() in {"MAT 124", "MAT 131"}]
        clauses = [(alternatives, lambda p: current is not None and p < current)]
    elif course.id == "mat-215":
        clauses = [("mat-133", lambda p: current is not None and p < current)]
    else:
        lab_terms = [idx[x] for x in idx if x == "chm-129l"]
        good = current is not None and current in lab_terms
        return ("no_issue_in_plan" if good else "sequence_gap"), [evidence(course, "system_requisites")], ([] if good else ["chm-129l"])
    missing = []
    good_all = True
    for need, predicate in clauses:
        ids = need if isinstance(need, list) else [need]
        match = any(any(predicate(p) for p in placements.get(cid, [])) for cid in ids)
        if not match:
            good_all = False
            missing.extend(ids)
    return ("no_issue_in_plan" if good_all else "sequence_gap"), [evidence(course, "prerequisites"), evidence(course, "system_requisites")], missing

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

def goal_score(course, goals):
    tokens = {t.lower() for t in re.split(r"[^a-zA-Z0-9]+", goals) if len(t) >= 3}
    text = f"{course.code} {course.title} {course.description or ''}".lower()
    return min(5, sum(1 for t in tokens if re.search(rf"\b{re.escape(t)}\b", text)))

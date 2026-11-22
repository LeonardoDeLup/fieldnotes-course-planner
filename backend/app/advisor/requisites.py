"""Interpret explicit course requirements in the local catalog snapshot."""

from functools import lru_cache
import re
from typing import NamedTuple


class Requisite(NamedTuple):
    timing: str
    codes: tuple[str, ...]
    review_codes: tuple[str, ...] = ()


PRIOR = "Must be completed prior to taking this course."
SAME = "Must be taken at the same time as this course."
CONCURRENT = "Must be taken either prior to or at the same time as this course."
RECOMMENDED = "Recommended to be taken either prior to or at the same time as this course, but is not required."
TIMINGS = {PRIOR.lower(): "prior", SAME.lower(): "same", CONCURRENT.lower(): "concurrent"}
MARKER = re.compile(r"\s+-\s+(" + "|".join(map(re.escape, (*TIMINGS, RECOMMENDED))) + ")", re.I)
CODE = re.compile(r"([A-Z]+(?:/[A-Z]+)*)[-\s]+(\d{3}[A-Z]*)", re.I)
NUMBER = re.compile(r"\b\d{3}[A-Z]*\b", re.I)
GRADE = re.compile(r"[,;]?\s+with grades? S,\s*C,\s*or better\.?$", re.I)
# These descriptions list an extra alternative. The overlapping alternatives
# are supported by both fields and can be used to construct a draft.
AGREED_ALTERNATIVES = {
    ("Mathematics 218, 222 or 246", f"MAT 218 or 222 - {PRIOR}"): ("MAT 246",),
    ("Statistics 209, Mathematics 209, or Mathematics/Statistics 336", f"STA-209, or MAT/STA-336 - {PRIOR}"): ("MAT 209",),
}


def _course_groups(text):
    text = re.sub(r"^(?:take\s+|(?:previous )?completion of or concurrent (?:registration|enrollment) in\s+|concurrent (?:registration|enrollment) in\s+)", "", text.strip(), flags=re.I)
    text = re.sub(r"^([A-Z]+[- ]\d{3}[A-Z]*)[.,]\s+[^.,;]+ recommended\.?$", r"\1", text, flags=re.I)
    text = text.rstrip(".;")
    department = ""
    groups = []
    for group in re.split(r",?\s+and\s+(?:either\s+)?", text, flags=re.I):
        if "," in group and not re.search(r"\s+or\s+", group, re.I):
            return None
        options = []
        for token in re.split(r",?\s+or\s+|,\s*", group, flags=re.I):
            token = token.strip()
            match = CODE.fullmatch(token)
            if match:
                department, number = match.groups()
            elif department and "/" not in department and NUMBER.fullmatch(token):
                number = token
            else:
                return None
            options.extend(f"{prefix} {number}".upper() for prefix in department.split("/"))
        groups.append(tuple(options))
    return groups


@lru_cache(maxsize=1024)
def parse_requisites(description, system, notes):
    """Return known requirements and whether additional eligibility needs review."""
    if (description, system, notes) == ("None", "None", None):
        return (), False
    if not system or notes:
        return (), True

    review_codes = AGREED_ALTERNATIVES.get((description, system), ())
    if not review_codes and (
        set(NUMBER.findall((description or "").upper())) - set(NUMBER.findall(system.upper()))
        or re.search(r"\bor\b[^.;]*(?:placement|permission|consent|equivalent)", description or "", re.I)
    ):
        return (), True

    # This source repeats CSC 161 in prose and in its explicit concurrent group.
    if system == f"CSC-151 and either MAT-124 or MAT-131 and completion of or concurrent registration in CSC-161. - {PRIOR} CSC-161 or CSC-161PL - {CONCURRENT}":
        system = f"CSC-151 and either MAT-124 or MAT-131 - {PRIOR} CSC-161 or CSC-161PL - {CONCURRENT}"

    parts = MARKER.split(system)
    if len(parts) == 1:
        return (), True
    requirements = []
    review = bool(parts[-1].strip()) or bool(re.search(r"\b(?:grades?|consent|permission|placement)\b", description or "", re.I))
    unknown_concurrent = False
    for text, phrase in zip(parts[0::2], parts[1::2]):
        timing = TIMINGS.get(phrase.lower())
        if not timing:
            continue
        cleaned, grade_check = GRADE.subn("", text.strip())
        groups = _course_groups(cleaned)
        if groups is None:
            review = True
            unknown_concurrent |= timing != "prior"
            continue
        review |= bool(grade_check)
        requirements.extend(Requisite(timing, group, review_codes) for group in groups)

    concurrent = {code for rule in requirements if rule.timing != "prior" for code in rule.codes}
    return tuple(rule for rule in requirements if rule.timing != "prior" or
                 not unknown_concurrent and concurrent.isdisjoint(rule.codes)), review


def course_requirements(course):
    return parse_requisites(course.prerequisites, course.system_requisites, course.catalog_notes)

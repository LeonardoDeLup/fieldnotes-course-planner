from typing import Annotated, Literal
import re
from pydantic import BaseModel, ConfigDict, Field, StringConstraints, model_serializer, model_validator

SemesterId = Annotated[str, StringConstraints(pattern=r"^semester-[0-7]$")]
CourseId = Annotated[str, StringConstraints(min_length=1, max_length=120)]
MAX_PLAN_ENTRIES = 128

class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)

class Entry(StrictModel):
    course_id: CourseId = Field(alias="courseId")
    semester_id: SemesterId = Field(alias="semesterId")

class Plan(StrictModel):
    version: Literal[1]
    start_year: int = Field(alias="startYear", ge=2000, le=2100)
    entries: list[Entry] = Field(max_length=MAX_PLAN_ENTRIES)

    @model_validator(mode="after")
    def unique_courses(self):
        ids = [entry.course_id for entry in self.entries]
        if len(ids) != len(set(ids)):
            raise ValueError("duplicate course IDs are not allowed")
        return self

class CommonOptions(StrictModel):
    target_credits: float = Field(default=16, alias="targetCredits", ge=1, le=24)
    focus_departments: list[str] = Field(default_factory=list, alias="focusDepartments", max_length=5)
    goals: str = Field(default="", max_length=400)

    @model_validator(mode="after")
    def valid_common_options(self):
        if self.target_credits * 2 % 1 or len(set(self.focus_departments)) != len(self.focus_departments):
            raise ValueError("target credits must use half-credit increments and focus departments must be distinct")
        if self.goals != self.goals.strip():
            raise ValueError("goals must be trimmed")
        if any(not re.fullmatch(r"[A-Za-z]{2,8}", d) for d in self.focus_departments):
            raise ValueError("focus departments must be department codes")
        return self

class PlanGenerationOptions(CommonOptions):
    allow_requisite_review: bool = Field(default=False, alias="allowRequisiteReview")

class GenerateOptions(PlanGenerationOptions):
    semester_id: SemesterId = Field(alias="semesterId")

class CritiqueOptions(CommonOptions):
    pass

class CourseOptions(CommonOptions):
    course_id: CourseId = Field(alias="courseId")
    semester_id: SemesterId | None = Field(default=None, alias="semesterId")

class DiscoverOptions(CommonOptions):
    semester_id: SemesterId | None = Field(default=None, alias="semesterId")

class RoadmapOptions(CommonOptions):
    course_id: CourseId = Field(alias="courseId")
    semester_id: SemesterId | None = Field(default=None, alias="semesterId")

class GenerateRequest(StrictModel):
    action: Literal["generate_semester"]
    catalog_revision: str = Field(alias="catalogRevision", pattern=r"^[a-f0-9]{64}$")
    plan: Plan
    options: GenerateOptions

class GeneratePlanRequest(StrictModel):
    action: Literal["generate_full_plan"]
    catalog_revision: str = Field(alias="catalogRevision", pattern=r"^[a-f0-9]{64}$")
    plan: Plan
    options: PlanGenerationOptions

class CritiqueRequest(StrictModel):
    action: Literal["critique_plan"]
    catalog_revision: str = Field(alias="catalogRevision", pattern=r"^[a-f0-9]{64}$")
    plan: Plan
    options: CritiqueOptions

class CourseRequest(StrictModel):
    action: Literal["find_alternatives", "prerequisite_roadmap"]
    catalog_revision: str = Field(alias="catalogRevision", pattern=r"^[a-f0-9]{64}$")
    plan: Plan
    options: CourseOptions | RoadmapOptions

class DiscoverRequest(StrictModel):
    action: Literal["discover_courses"]
    catalog_revision: str = Field(alias="catalogRevision", pattern=r"^[a-f0-9]{64}$")
    plan: Plan
    options: DiscoverOptions

class BriefRequest(StrictModel):
    action: Literal["advisor_brief"]
    catalog_revision: str = Field(alias="catalogRevision", pattern=r"^[a-f0-9]{64}$")
    plan: Plan
    options: CritiqueOptions

AdviceRequest = Annotated[GenerateRequest | GeneratePlanRequest | CritiqueRequest | CourseRequest | DiscoverRequest | BriefRequest, Field(discriminator="action")]

class Evidence(StrictModel):
    course_id: str = Field(alias="courseId")
    field: Literal["prerequisites", "system_requisites", "catalog_notes", "description"]
    excerpt: str

class Action(StrictModel):
    kind: Literal["add", "move", "replace"]
    course_id: str = Field(alias="courseId")
    semester_id: SemesterId = Field(alias="semesterId")
    from_semester_id: SemesterId | None = Field(default=None, alias="fromSemesterId")
    replacement_course_id: str | None = Field(default=None, alias="replacementCourseId")

    @model_serializer(mode="wrap")
    def serialize_action(self, handler):
        data=handler(self)
        if self.kind!="move": data.pop("fromSemesterId",None)
        if self.kind!="replace": data.pop("replacementCourseId",None)
        return data

class Total(StrictModel):
    semester_id: SemesterId = Field(alias="semesterId")
    before: float | None
    after: float | None

class Placement(StrictModel):
    course_id: str = Field(alias="courseId")
    semester_id: SemesterId = Field(alias="semesterId")
    availability: Literal["listed_in_source_term", "term_unverified"]
    requisite_status: Literal["no_issue_in_plan", "needs_review"] = Field(alias="requisiteStatus")
    evidence: list[Evidence]

class Proposal(StrictModel):
    id: str
    label: str
    rationale: str
    actions: list[Action]
    totals: list[Total]
    placements: list[Placement]
    notices: list[str]

class Finding(StrictModel):
    id: str
    code: str
    severity: Literal["attention", "review", "info"]
    semester_id: SemesterId | None = Field(alias="semesterId")
    course_ids: list[str] = Field(alias="courseIds")
    title: str
    detail: str
    next_step: str = Field(alias="nextStep")
    evidence: list[Evidence]
    proposal_id: str | None = Field(alias="proposalId")

class Suggestion(StrictModel):
    course_id: str = Field(alias="courseId")
    reason: str
    availability: Literal["listed_in_source_term", "term_unverified"] | None
    requisite_status: Literal["no_issue_in_plan", "sequence_gap", "needs_review"] | None = Field(alias="requisiteStatus")
    evidence: list[Evidence]
    proposal_id: str | None = Field(alias="proposalId")

class SemesterStat(StrictModel):
    semester_id: SemesterId = Field(alias="semesterId")
    course_count: int = Field(alias="courseCount")
    credits: float | None

class Advice(StrictModel):
    action: str
    catalog_revision: str = Field(alias="catalogRevision")
    source_terms: list[str] = Field(alias="sourceTerms")
    mode: Literal["model", "rules"]
    reason: Literal["model_unavailable", "model_timeout", "model_busy", "invalid_model_output", "model_disabled", "model_not_needed"] | None
    summary: str
    proposals: list[Proposal]
    findings: list[Finding]
    suggestions: list[Suggestion]
    semester_stats: list[SemesterStat] = Field(alias="semesterStats")

class Ranking(StrictModel):
    ordered_ids: list[str] = Field(alias="orderedIds", max_length=12)

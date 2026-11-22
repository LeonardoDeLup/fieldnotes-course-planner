import { semesters } from "./plan";
import type { Course, Plan } from "./plan";

type Timing = "earlier" | "same" | "earlier-or-same";
type Requisite = { codes: string[]; timing: Timing };

const timingByPhrase = new Map<string, Timing>([
  ["must be completed prior to taking this course", "earlier"],
  ["must be taken at the same time as this course", "same"],
  ["must be taken either prior to or at the same time as this course", "earlier-or-same"],
]);
const timingMarker = /\s+-\s+(must be completed prior to taking this course|must be taken at the same time as this course|must be taken either prior to or at the same time as this course|recommended to be taken either prior to or at the same time as this course, but is not required)\./i;
const courseCode = /^([a-z]+(?:\/[a-z]+)*)[-\s]+(\d{3}[a-z]*)$/i;
const courseNumber = /^\d{3}[a-z]*$/i;
const courseNumbersInText = /\b\d{3}[A-Z]*\b/g;
const alternatives = new Intl.ListFormat("en", { type: "disjunction" });

function parseCourseGroups(text: string, allowAbbreviations: boolean): string[][] | null {
  const expression = text.trim()
    .replace(/^(?:take |(?:previous )?completion of or concurrent (?:registration|enrollment) in |concurrent (?:registration|enrollment) in )/i, "")
    .replace(/[,;]?\s+with grades? S,\s*C,\s*or better\.?$/i, "")
    .replace(/[.;]$/, "");
  const groups: string[][] = [];
  let departments = "";
  for (const group of expression.split(/,?\s+and\s+(?:either\s+)?/i)) {
    // A comma list is ambiguous unless the catalog explicitly ends it with “or”.
    if (group.includes(",") && !/\s+or\s+/i.test(group)) return null;
    const codes: string[] = [];
    for (const part of group.split(/,?\s+or\s+|,\s*/i)) {
      const option = part.trim();
      const match = courseCode.exec(option);
      if (match) departments = match[1];
      else if (!allowAbbreviations || !departments || departments.includes("/") || !courseNumber.test(option)) return null;
      const number = match?.[2] ?? option;
      codes.push(...departments.split("/").map((dept) => `${dept} ${number}`.toUpperCase()));
    }
    groups.push(codes);
  }
  return groups;
}

function catalogRequisites(course: Course): Requisite[] {
  if (!course.system_requisites || course.catalog_notes) return [];
  const parts = course.system_requisites.split(timingMarker);
  const rules: Requisite[] = [];
  // If the description names an extra course, the abbreviated list may omit a valid option.
  const systemNumbers = new Set(course.system_requisites.toUpperCase().match(courseNumbersInText));
  const descriptionNumbers = course.prerequisites?.toUpperCase().match(courseNumbersInText) ?? [];
  const allowAbbreviations = descriptionNumbers.every((number) => systemNumbers.has(number));
  // Some rows repeat a concurrent requisite inside the prior-course text.
  // Keep the explicitly concurrent timing for any overlapping course group.
  let unknownConcurrentRule = false;
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const timing = timingByPhrase.get(parts[i + 1].toLowerCase());
    if (!timing) continue;
    if (timing === "earlier" && /\bor\b[^.;]*(?:placement|permission|consent|equivalent)/i.test(course.prerequisites ?? "")) continue;
    const groups = parseCourseGroups(parts[i], allowAbbreviations);
    if (groups) rules.push(...groups.map((codes) => ({ codes, timing })));
    else if (timing !== "earlier") unknownConcurrentRule = true;
  }
  const concurrentCodes = new Set(rules.filter(({ timing }) => timing !== "earlier").flatMap(({ codes }) => codes));
  return rules.filter(({ timing, codes }) =>
    timing !== "earlier" || (!unknownConcurrentRule && codes.every((code) => !concurrentCodes.has(code))),
  );
}

const timingText: Record<Timing, string> = {
  earlier: "in an earlier semester",
  same: "in the same semester",
  "earlier-or-same": "in the same or an earlier semester",
};

export function planRequisiteWarnings(plan: Plan, courses: Course[]): Map<string, string[]> {
  const byId = new Map(courses.map((course) => [course.id, course]));
  const termsByCode = new Map<string, number[]>();
  for (const entry of plan.entries) {
    // Older plans may contain a plain course ID omitted from the current CSV.
    const match = courseCode.exec(byId.get(entry.courseId)?.code ?? entry.courseId);
    if (!match) continue;
    const code = `${match[1]} ${match[2]}`.toUpperCase();
    const term = semesters.indexOf(entry.semesterId);
    const terms = termsByCode.get(code);
    if (terms) terms.push(term);
    else termsByCode.set(code, [term]);
  }

  const warnings = new Map<string, string[]>();
  for (const entry of plan.entries) {
    const course = byId.get(entry.courseId);
    if (!course) continue;
    const term = semesters.indexOf(entry.semesterId);
    const missing = catalogRequisites(course).filter(({ codes, timing }) =>
      !codes.some((code) => termsByCode.get(code)?.some((placed) => {
        if (timing === "same") return placed === term;
        if (timing === "earlier") return placed < term;
        return placed <= term;
      })),
    );
    if (missing.length) {
      warnings.set(course.id, missing.map(({ codes, timing }) => `${alternatives.format(codes)} ${timingText[timing]}`));
    }
  }
  return warnings;
}

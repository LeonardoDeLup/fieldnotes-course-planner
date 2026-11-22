export interface Course {
  id: string;
  code: string;
  title: string;
  department: string;
  level: number;
  credits: number | null;
  credit_display?: string | null;
  description: string | null;
  prerequisites?: string | null;
  system_requisites?: string | null;
  catalog_notes?: string | null;
  source_term?: string;
  source_file?: string;
}
export interface Entry {
  id: string;
  courseId: string;
  semesterId: string;
}
export interface Plan {
  version: 1;
  startYear: number;
  entries: Entry[];
}
export const semesters = Array.from({ length: 8 }, (_, i) => `semester-${i}`);
export const emptyPlan = (): Plan => ({
  version: 1,
  startYear: 2026,
  entries: [],
});
export function semesterLabel(id: string, year: number) {
  const i = semesters.indexOf(id);
  return `${i % 2 === 0 ? "Fall" : "Spring"} ${year + Math.floor(i / 2) + (i % 2)}`;
}
export function place(
  plan: Plan,
  courseId: string,
  semesterId: string,
  beforeId?: string,
): Plan {
  if (!semesters.includes(semesterId)) return plan;
  const current = plan.entries.find((e) => e.courseId === courseId);
  if (current && current.id === beforeId) return plan;
  const entry: Entry = current
    ? { ...current, semesterId }
    : { id: crypto.randomUUID(), courseId, semesterId };
  const entries = plan.entries.filter((e) => e.courseId !== courseId);
  const before = entries.findIndex(
    (e) => e.id === beforeId && e.semesterId === semesterId,
  );
  entries.splice(before < 0 ? entries.length : before, 0, entry);
  return { ...plan, entries };
}
export function totalCredits(entries: Entry[], courses: Course[]): number | null {
  let total = 0;
  for (const entry of entries) {
    const course = courses.find(c => c.id === entry.courseId);
    if (course?.credits == null) return null;
    total += course.credits;
  }
  return total;
}
export function parsePlan(raw: string): Plan {
  const p = JSON.parse(raw);
  if (
    p.version !== 1 ||
    !Number.isInteger(p.startYear) ||
    p.startYear < 2000 ||
    p.startYear > 2100 ||
    !Array.isArray(p.entries)
  )
    throw Error("Invalid saved plan");
  const ids = new Set<string>(),
    courses = new Set<string>();
  for (const e of p.entries) {
    if (
      !e ||
      typeof e.id !== "string" ||
      typeof e.courseId !== "string" ||
      !semesters.includes(e.semesterId) ||
      ids.has(e.id) ||
      courses.has(e.courseId)
    )
      throw Error("Invalid entry");
    ids.add(e.id);
    courses.add(e.courseId);
  }
  return p;
}
const exampleTerms = [
  ["bio-150-cb736b1ae340-1", "csc-151", "mat-131", "eng-120-33fd7effb9ef-1"],
  ["csc-161", "mat-133", "phi-101", "art-111"],
  ["csc-207", "sta-209", "ecn-111", "art-155"],
  ["csc-208", "mat-215", "mus-116", "soc-111"],
  ["csc-211", "mat-220", "ecn-233", "rel-106"],
  ["csc-301", "sta-230", "pol-101", "eng-205"],
  ["csc-324", "mat-306", "psy-113", "mus-112"],
  ["csc-341", "sta-309", "soc-350", "phi-254"],
];

export function examplePlan(startYear: number, courses: Course[]): Plan | null {
  const catalogIds = new Set(courses.map(course => course.id));
  const entries = exampleTerms.flatMap((courseIds, termIndex) =>
    courseIds.map(courseId => ({
      id: `example-${courseId}`,
      courseId,
      semesterId: semesters[termIndex],
    })),
  );
  if (entries.some(entry => !catalogIds.has(entry.courseId))) return null;
  return { version: 1, startYear, entries };
}

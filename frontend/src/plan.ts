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
export function examplePlan(startYear: number, courses: Course[]): Plan {
  return {
    version: 1,
    startYear,
    entries: [
      ["bio-150", 0],
      ["csc-151", 0],
      ["mat-131", 0],
      ["eng-120", 0],
      ["csc-161", 1],
      ["mat-133", 1],
      ["phi-101", 1],
      ["art-111", 1],
      ["csc-207", 2],
      ["sta-209", 2],
      ["spn-106", 2],
      ["csc-208", 3],
      ["mat-215", 3],
      ["mus-101", 3],
    ].filter(([courseId]) => courses.some(c => c.id === courseId)).map(([courseId, i], n) => ({
      id: `example-${n}`,
      courseId: String(courseId),
      semesterId: `semester-${i}`,
    })),
  };
}

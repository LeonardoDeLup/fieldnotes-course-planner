import { describe, expect, it } from "vitest";
import { emptyPlan, place } from "./plan";
import type { Course } from "./plan";
import { planRequisiteWarnings } from "./requisites";

const earlier = " - Must be completed prior to taking this course.";
const concurrent = " - Must be taken either prior to or at the same time as this course.";
const same = " - Must be taken at the same time as this course.";

function course(code: string, system_requisites?: string): Course {
  return {
    id: code.toLowerCase().replace(" ", "-"),
    code,
    title: code,
    department: code.split(" ")[0],
    level: 100,
    credits: 4,
    description: null,
    system_requisites,
  };
}

describe("plan requisite warnings", () => {
  it("requires each group and accepts any earlier alternative, including saved courses absent from the catalog", () => {
    const courses = [
      course("CSC 207"),
      course("MAT 208"),
      course("CSC 301", `CSC-207 and either MAT-218 or CSC/MAT-208${earlier}`),
    ];
    let plan = place(emptyPlan(), "csc-301", "semester-2");
    plan = place(plan, "csc-207", "semester-2");
    plan = place(plan, "mat-208", "semester-3");
    expect(planRequisiteWarnings(plan, courses).get("csc-301")).toEqual([
      "CSC 207 in an earlier semester",
      "MAT 218, CSC 208, or MAT 208 in an earlier semester",
    ]);

    plan = place(plan, "csc-207", "semester-0");
    plan = place(plan, "mat-218", "semester-1");
    expect(planRequisiteWarnings(plan, courses).size).toBe(0);
  });

  it("checks corequisite timing and accepts a concurrently scheduled alternative", () => {
    const courses = [
      course("MAT 131"),
      course("PHY 131L"),
      course("PHY 131", `Completion of or concurrent enrollment in MAT-124 or MAT-131${earlier} PHY-131L${same} Take MAT-124 or MAT-131${concurrent}`),
    ];
    let plan = place(emptyPlan(), "phy-131", "semester-1");
    plan = place(plan, "phy-131l", "semester-0");
    plan = place(plan, "mat-131", "semester-1");
    expect(planRequisiteWarnings(plan, courses).get("phy-131")).toEqual([
      "PHY 131L in the same semester",
    ]);
    expect(planRequisiteWarnings(place(plan, "phy-131l", "semester-1"), courses).size).toBe(0);
  });

  it("leaves permission, placement alternatives, and ambiguous lists for manual review", () => {
    const courses = [
      course("ENG 205", `Permission of the instructor${earlier}`),
      { ...course("ARB 102", `ARB-101${earlier}`), prerequisites: "Arabic 101 or by placement" },
      course("BIO 295", `BIO-150, CHM-129${earlier}`),
    ];
    const plan = courses.reduce((next, { id }) => place(next, id, "semester-1"), emptyPlan());
    expect(planRequisiteWarnings(plan, courses).size).toBe(0);
  });
});

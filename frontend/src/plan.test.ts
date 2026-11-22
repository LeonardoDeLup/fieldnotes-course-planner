import { describe, it, expect } from "vitest";
import {
  emptyPlan,
  place,
  parsePlan,
  totalCredits,
  examplePlan,
  semesterLabel,
} from "./plan";
import type { Course } from "./plan";
describe("plan operations", () => {
  it("adds, moves without duplication, and rejects invalid destinations", () => {
    const p = place(emptyPlan(), "csc-151", "semester-0");
    const moved = place(p, "csc-151", "semester-3");
    expect(moved.entries).toHaveLength(1);
    expect(moved.entries[0].id).toBe(p.entries[0].id);
    expect(moved.entries[0].semesterId).toBe("semester-3");
    expect(place(moved, "x", "missing")).toEqual(moved);
    expect(p.entries[0].semesterId).toBe("semester-0");
  });
  it("reorders courses and preserves other semesters", () => {
    let p = place(emptyPlan(), "a", "semester-0");
    p = place(p, "b", "semester-0");
    p = place(p, "c", "semester-1");
    p = place(p, "b", "semester-0", p.entries[0].id);
    expect(p.entries.map((e) => e.courseId)).toEqual(["b", "a", "c"]);
  });
  it("calculates credits including fractional values and missing catalog entries", () => {
    const p = place(place(emptyPlan(), "a", "semester-0"), "b", "semester-1");
    expect(
      totalCredits(p.entries, [{ id: "a", credits: 1.5 }] as Course[]),
    ).toBeNull();
    expect(totalCredits(p.entries, [{id:"a",credits:1.5},{id:"b",credits:0}] as Course[])).toBe(1.5);
    expect(totalCredits(p.entries, [{id:"a",credits:1.5},{id:"b",credits:null}] as Course[])).toBeNull();
    expect(totalCredits([], [])).toBe(0);
  });
  it("round trips saved plans and rejects malformed or duplicate entries", () => {
    const p = place(emptyPlan(), "csc-151", "semester-0");
    expect(parsePlan(JSON.stringify(p))).toEqual(p);
    expect(() => parsePlan("{")).toThrow();
    expect(() =>
      parsePlan(
        JSON.stringify({ ...p, entries: [p.entries[0], p.entries[0]] }),
      ),
    ).toThrow();
    expect(() => parsePlan(JSON.stringify({ ...p, startYear: 0 }))).toThrow();
  });
  it("does not build a partial example from an incomplete catalog", () => {
    expect(examplePlan(2026, [{ id: "csc-151" }] as Course[])).toBeNull();
  });
  it("fills all eight semesters in the example plan", () => {
    const ids = [
      "bio-150-cb736b1ae340-1", "csc-151", "mat-131", "eng-120-33fd7effb9ef-1",
      "csc-161", "mat-133", "phi-101", "art-111",
      "csc-207", "sta-209", "ecn-111", "art-155",
      "csc-208", "mat-215", "mus-116", "soc-111",
      "csc-211", "mat-220", "ecn-233", "rel-106",
      "csc-301", "sta-230", "pol-101", "eng-205",
      "csc-324", "mat-306", "psy-113", "mus-112",
      "csc-341", "sta-309", "soc-350", "phi-254",
    ];
    const plan = examplePlan(2026, ids.map(id => ({ id })) as Course[]);
    expect(plan?.entries).toHaveLength(32);
    expect(new Set(plan?.entries.map(entry => entry.semesterId))).toEqual(
      new Set(Array.from({ length: 8 }, (_, i) => `semester-${i}`)),
    );
  });
  it("labels spring in the following calendar year", () => {
    expect(semesterLabel("semester-1", 2026)).toBe("Spring 2027");
    expect(semesterLabel("semester-7", 2026)).toBe("Spring 2030");
  });
});

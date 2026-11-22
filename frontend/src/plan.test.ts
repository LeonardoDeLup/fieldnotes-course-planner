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
    const p = examplePlan(2026, [{id:"csc-151"}] as Course[]);
    expect(p.entries.map(e=>e.courseId)).toEqual(["csc-151"]);
    expect(parsePlan(JSON.stringify(p))).toEqual(p);
    expect(() => parsePlan("{")).toThrow();
    expect(() =>
      parsePlan(
        JSON.stringify({ ...p, entries: [p.entries[0], p.entries[0]] }),
      ),
    ).toThrow();
    expect(() => parsePlan(JSON.stringify({ ...p, startYear: 0 }))).toThrow();
  });
  it("labels spring in the following calendar year", () => {
    expect(semesterLabel("semester-1", 2026)).toBe("Spring 2027");
    expect(semesterLabel("semester-7", 2026)).toBe("Spring 2030");
  });
});

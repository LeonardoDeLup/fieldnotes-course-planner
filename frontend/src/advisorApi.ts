import { semesters, type Course, type Plan } from "./plan";

export type SemesterId = `semester-${0|1|2|3|4|5|6|7}`;
const adviceActions = ["generate_semester", "generate_full_plan", "critique_plan", "find_alternatives", "discover_courses", "prerequisite_roadmap", "advisor_brief"] as const;
export type AdviceAction = (typeof adviceActions)[number];
export interface Evidence { courseId: string; field: string; excerpt: string }
export interface Proposal {
  id: string; label: string; rationale: string;
  actions: { kind: "add"|"move"|"replace"; courseId: string; semesterId: SemesterId; fromSemesterId?: SemesterId; replacementCourseId?: string }[];
  totals: { semesterId: SemesterId; before: number|null; after: number|null }[];
  placements: { courseId: string; semesterId: SemesterId; availability: string; requisiteStatus: string; evidence: Evidence[] }[];
  notices: string[];
}
export interface Finding { id: string; code: string; severity: string; semesterId: SemesterId|null; courseIds: string[]; title: string; detail: string; nextStep: string; evidence: Evidence[]; proposalId: string|null }
export interface Advice {
  action: AdviceAction; catalogRevision: string; sourceTerms: string[]; mode: "model"|"rules"; reason: string|null; summary: string;
  proposals: Proposal[]; findings: Finding[]; suggestions: {courseId:string;reason:string;availability:string|null;requisiteStatus:string|null;evidence:Evidence[];proposalId:string|null}[];
  semesterStats: {semesterId:SemesterId;courseCount:number;credits:number|null}[];
}
export interface AdviceOptions { semesterId?: string; targetCredits?: number; focusDepartments: string[]; goals: string; allowRequisiteReview?: boolean; courseId?: string }
export interface AdvisorPlan { version: 1; startYear: number; entries: {courseId:string;semesterId:string}[] }

export function projectPlan(plan: Plan): AdvisorPlan {
  return {version:1,startYear:plan.startYear,entries:plan.entries.map(({courseId,semesterId})=>({courseId,semesterId}))};
}

function validAdvice(value: unknown): value is Advice {
  if (!value || typeof value !== "object") return false;
  const x=value as Record<string,unknown>;
  if (!adviceActions.some(action => action === x.action) || typeof x.catalogRevision!=="string" || !/^[a-f0-9]{64}$/.test(x.catalogRevision) || !Array.isArray(x.sourceTerms) || !(x.sourceTerms as unknown[]).every(t=>typeof t==="string") || !["model","rules"].includes(String(x.mode)) || !(x.reason===null||["model_unavailable","model_timeout","model_busy","invalid_model_output","model_disabled","model_not_needed"].includes(String(x.reason))) || typeof x.summary!=="string" || !Array.isArray(x.proposals) || !Array.isArray(x.findings) || !Array.isArray(x.suggestions) || !Array.isArray(x.semesterStats)) return false;
  const ids=new Set<string>();
  for (const p of x.proposals as Proposal[]) {
    if (!p || typeof p.id!=="string" || ids.has(p.id) || !Array.isArray(p.actions) || !Array.isArray(p.totals) || !Array.isArray(p.placements) || !Array.isArray(p.notices)) return false;
    ids.add(p.id);
    if (p.actions.some(a=>!a || !["add","move","replace"].includes(a.kind) || typeof a.courseId!=="string" || !/^semester-[0-7]$/.test(a.semesterId) || (a.kind==="move"&&!/^semester-[0-7]$/.test(a.fromSemesterId??"")) || (a.kind==="replace"&&typeof a.replacementCourseId!=="string"))) return false;
    if(p.totals.some(t=>!t||!/^semester-[0-7]$/.test(t.semesterId)||!(t.before===null||typeof t.before==="number")||!(t.after===null||typeof t.after==="number")))return false;
    if(p.placements.some(v=>!v||typeof v.courseId!=="string"||!/^semester-[0-7]$/.test(v.semesterId)||!Array.isArray(v.evidence)||!['listed_in_source_term','term_unverified'].includes(v.availability)||!['no_issue_in_plan','needs_review'].includes(v.requisiteStatus)))return false;
    if (x.action === "generate_full_plan" && (
      p.totals.length !== semesters.length ||
      !semesters.every(sid => p.totals.some(total => total.semesterId === sid)) ||
      !p.actions.length || p.actions.length !== p.placements.length ||
      p.actions.some(a => a.kind !== "add" || !p.placements.some(v => v.courseId === a.courseId && v.semesterId === a.semesterId))
    )) return false;
  }
  if((x.findings as Finding[]).some(f=>!f||typeof f.id!=="string"||typeof f.title!=="string"||typeof f.detail!=="string"||typeof f.nextStep!=="string"||!Array.isArray(f.evidence)||!Array.isArray(f.courseIds)))return false;
  if((x.suggestions as Advice["suggestions"]).some(s=>!s||typeof s.courseId!=="string"||typeof s.reason!=="string"||!Array.isArray(s.evidence)||!(s.availability===null||['listed_in_source_term','term_unverified'].includes(s.availability))||!(s.requisiteStatus===null||['no_issue_in_plan','sequence_gap','needs_review'].includes(s.requisiteStatus))))return false;
  if((x.semesterStats as Advice["semesterStats"]).length!==8||(x.semesterStats as Advice["semesterStats"]).some(s=>!s||!/^semester-[0-7]$/.test(s.semesterId)||typeof s.courseCount!=="number"||!(s.credits===null||typeof s.credits==="number")))return false;
  if((x.findings as Finding[]).some(f=>f.proposalId!==null&&!ids.has(f.proposalId)))return false;
  return true;
}

export async function fetchAdvice(action: AdviceAction, revision: string, plan: Plan, options: AdviceOptions, signal: AbortSignal): Promise<Advice> {
  const response=await fetch("/api/ai/advice",{method:"POST",headers:{"Content-Type":"application/json"},signal,body:JSON.stringify({action,catalogRevision:revision,plan:projectPlan(plan),options})});
  if (!response.ok) {
    const body=await response.json().catch(()=>null);
    const detail = body?.detail;
    const message = response.status === 422
      ? typeof detail === "string" ? detail : "The advisor rejected this request. Check your plan and advisor settings."
      : detail?.code ?? `Advisor request failed (${response.status})`;
    const error = new Error(message);
    (error as Error & {status?:number}).status=response.status;
    throw error;
  }
  const value=await response.json();
  if (!validAdvice(value) || value.action!==action || value.catalogRevision!==revision) throw new Error("The advisor response could not be verified.");
  return value;
}

export async function fetchCatalog(signal?: AbortSignal): Promise<{courses:Course[];revision:string}> {
  const response=await fetch("/api/courses",{cache:"no-store",signal});
  if(!response.ok) throw new Error("The catalog could not be refreshed.");
  const revision=response.headers.get("X-Catalog-Revision");
  if(!revision || !/^[a-f0-9]{64}$/.test(revision)) throw new Error("The catalog revision could not be verified.");
  return {courses:await response.json(),revision};
}

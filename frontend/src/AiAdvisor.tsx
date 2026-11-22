import { useEffect, useRef, useState } from "react";
import { BookOpen, Sparkles, ArrowUpRight, RefreshCw } from "lucide-react";
import type { Plan, Course } from "./plan";
import { semesters, semesterLabel, totalCredits } from "./plan";
import { fetchAdvice, fetchCatalog, type Advice, type AdviceAction, type AdviceOptions, type Proposal } from "./advisorApi";

type Props={plan:Plan;courses:Course[];revision:string;catalogLoadFailed:boolean;onCatalogRetry:()=>void;initialSemester?:string;initialAction?:AdviceAction;initialCourseId?:string;onApply:(proposal:Proposal,basis:Plan,target:number,signal:AbortSignal)=>Promise<string>;onOpenCourse?:(course:Course)=>void;onClose:()=>void;onCatalogRefresh:(courses:Course[],revision:string)=>void};
const workflows: {id:AdviceAction;label:string}[]=[
  {id:"generate_semester",label:"Generate semester"},{id:"generate_full_plan",label:"Generate 4-year plan"},
  {id:"critique_plan",label:"Critique plan"},
  {id:"find_alternatives",label:"Find alternatives"},{id:"discover_courses",label:"Discover courses"},
  {id:"prerequisite_roadmap",label:"Explore prerequisites"},{id:"advisor_brief",label:"Prepare for advising"},
];

function FullPlanPreview({draft, plan, courses, target}: {draft:Proposal;plan:Plan;courses:Course[];target:number}) {
  const catalog=new Map(courses.map(course=>[course.id,course]));
  return <div className="full-plan-terms">
    {draft.totals.map(total=>{
      const term=semesterLabel(total.semesterId,plan.startYear);
      const existing=plan.entries.filter(entry=>entry.semesterId===total.semesterId);
      const additions=draft.placements.filter(placement=>placement.semesterId===total.semesterId);
      const creditSummary=total.after===null?"Credits unavailable":
        total.before===total.after?`${total.after} credits`:`${total.before} → ${total.after} credits`;
      return <details key={total.semesterId}>
        <summary><strong>{term}</strong> <span>{creditSummary}</span></summary>
        {total.after!==null&&total.after<target&&<p className="form-hint">{target-total.after} credits open toward your target.</p>}
        {!existing.length&&!additions.length?<p className="form-hint">No courses in this semester.</p>:
          <ul>{existing.map(entry=>{
            const course=catalog.get(entry.courseId);
            return <li key={entry.id}><strong>{course?.code??entry.courseId}</strong> {course?.title}
              <small>{course?"Already planned":"Already planned · Course unavailable in catalog"}</small>
            </li>;
          })}{additions.map(placement=>{
            const course=catalog.get(placement.courseId);
            return <li key={placement.courseId}><strong>{course?.code??placement.courseId}</strong> {course?.title}
              <small>Proposed · {placement.availability==="listed_in_source_term"?`Listed in ${course?.source_term}`:"Offering unverified"}</small>
              {placement.requisiteStatus==="needs_review"&&<small>Requisites to verify{placement.evidence.length===0?".":""}</small>}
              {placement.requisiteStatus==="needs_review"&&placement.evidence.map((item,i)=><small key={i}>{item.excerpt}</small>)}
            </li>;
          })}</ul>}
      </details>;
    })}
  </div>;
}

export function AiAdvisor({plan,courses,revision,catalogLoadFailed,onCatalogRetry,initialSemester,initialAction,initialCourseId,onApply,onOpenCourse,onClose,onCatalogRefresh}:Props){
  const [action,setAction]=useState<AdviceAction>(initialAction??(initialSemester?"generate_semester":"critique_plan"));
  const [semester,setSemester]=useState(initialSemester??semesters.find(s=>!plan.entries.some(e=>e.semesterId===s))??"semester-0");
  const [target,setTarget]=useState(16); const [goals,setGoals]=useState(""); const [focus,setFocus]=useState("");
  const [allowReview,setAllowReview]=useState(false); const [courseId,setCourseId]=useState(initialCourseId??"");
  const [result,setResult]=useState<Advice|null>(null); const [state,setState]=useState<"idle"|"loading"|"success"|"empty"|"error">("idle");
  const [message,setMessage]=useState(""); const [status,setStatus]=useState("Checking local AI…"); const [ack,setAck]=useState(false);
  const [statusCheck,setStatusCheck]=useState(0);
  const [expanded,setExpanded]=useState(false); const controller=useRef<AbortController|null>(null); const requestToken=useRef(0);
  const [previewId,setPreviewId]=useState("");
  const [compareId,setCompareId]=useState("");
  const observedRevision=useRef(revision);
  const [copyFallback,setCopyFallback]=useState(false);
  const reset=()=>{controller.current?.abort();requestToken.current++;setResult(null);setState("idle");setMessage("");setAck(false);setPreviewId("");};
  useEffect(() => {
    const request = new AbortController();
    const path = statusCheck ? "/api/ai/status?refresh=true" : "/api/ai/status";
    setStatus("Checking local AI…");
    fetch(path, { signal: request.signal })
      .then(response => {
        if (!response.ok) throw new Error("Advisor status unavailable");
        return response.json();
      })
      .then(({ state, model }) => {
        if (request.signal.aborted) return;
        switch (state) {
          case "ready": setStatus(`Local AI ready · ${model}`); break;
          case "disabled": setStatus("Local AI disabled"); break;
          case "model_missing": setStatus(`Install ${model} to enable local AI`); break;
          case "offline": setStatus("Ollama is unreachable"); break;
          default: setStatus("Advisor service unavailable");
        }
      })
      .catch(() => {
        if (!request.signal.aborted) setStatus("Advisor service unavailable");
      });
    return () => request.abort();
  }, [statusCheck]);
  useEffect(() => () => controller.current?.abort(), []);
  useEffect(()=>{controller.current?.abort();requestToken.current++;setResult(null);setState("idle");setMessage("");setAck(false)},[plan]);
  useEffect(() => {
    const previous = observedRevision.current;
    observedRevision.current = revision;
    if (previous && previous !== revision) {
      controller.current?.abort();
      requestToken.current++;
      setResult(null);
      setAck(false);
      setState("error");
      setMessage("Catalog changed. Run again with the refreshed catalog.");
    }
  }, [revision]);
  const fullPlan=action==="generate_full_plan";
  const generation=action==="generate_semester"||fullPlan;
  const run=async()=>{
    reset(); const token=requestToken.current; const ctl=new AbortController();controller.current=ctl;setState("loading");setMessage("");
    const deadline=window.setTimeout(()=>ctl.abort("timeout"),fullPlan?110_000:95_000);
    const options:AdviceOptions={targetCredits:target,focusDepartments:[...new Set(focus.split(/[ ,]+/).map(x=>x.toUpperCase()).filter(Boolean))].slice(0,5),goals:goals.trim()};
    if(["generate_semester","discover_courses","find_alternatives","prerequisite_roadmap"].includes(action)) options.semesterId=semester;
    if(generation) options.allowRequisiteReview=allowReview;
    if(action==="find_alternatives"||action==="prerequisite_roadmap")options.courseId=courseId;
    try{const data=await fetchAdvice(action,revision,plan,options,ctl.signal);if(token!==requestToken.current)return;const known=new Set(courses.map(c=>c.id));if(data.proposals.some(p=>p.actions.some(a=>!known.has(a.courseId)||(a.kind==="replace"&&!known.has(a.replacementCourseId??"")))||p.placements.some(v=>!known.has(v.courseId)))||data.suggestions.some(s=>!known.has(s.courseId)))throw new Error("The advisor returned a course that is not in this catalog.");setResult(data);setState(data.proposals.length||data.findings.length||data.suggestions.length?"success":"empty");setMessage(data.summary)}
    catch(e){if(token!==requestToken.current)return;if(ctl.signal.aborted){if(ctl.signal.reason==="timeout"){setState("error");setMessage("The advisor took too long to respond. Retry or use catalog-based advice when the local model is unavailable.")}return}const error=e as Error & {status?:number};if(error.status===409){try{const fresh=await fetchCatalog();onCatalogRefresh(fresh.courses,fresh.revision);setState("error");setMessage("Catalog changed. Run again with the refreshed catalog.")}catch{setState("error");setMessage("Catalog changed, but the catalog could not be refreshed. Retry.")}}else{setState("error");setMessage("Advisor request failed. Check the Python service, then retry.")}}
    finally{window.clearTimeout(deadline)}
  };
  const choose=(next:AdviceAction)=>{reset();setAction(next)};
  const apply=async(p:Proposal)=>{
    const request=new AbortController();
    controller.current=request;
    const token=++requestToken.current;
    setState("loading");
    setMessage("Checking this draft against the current catalog…");
    const outcome=await onApply(p,plan,target,request.signal);
    if(request.signal.aborted||token!==requestToken.current) return;
    if(outcome==="applied"){
      onClose();
    }else{
      setResult(null);setState("error");setMessage(outcome);
    }
  };
  const current=totalCredits(plan.entries.filter(e=>e.semesterId===semester),courses);
  const courseName=(id:string)=>courses.find(c=>c.id===id)?.code??id;
  const focusChange=(value:string)=>{reset();setFocus(value)};
  const briefText=result?`${result.summary}\n\n${result.findings.map(f=>`${f.title}: ${f.detail}\nAsk: ${f.nextStep}${f.evidence.map(e=>`\nSource: ${e.excerpt}`).join("")}`).join("\n\n")}`:"";
  const copyBrief=async()=>{try{if(!navigator.clipboard?.writeText)throw new Error("Clipboard unavailable");await navigator.clipboard.writeText(briefText);setCopyFallback(false);setMessage("Brief copied to the clipboard.")}catch{setCopyFallback(true)}};
  const termControl=<label>Semester<select autoFocus={!!initialSemester} value={semester} onChange={e=>{reset();setSemester(e.target.value)}}>{semesters.map(s=><option key={s} value={s}>{semesterLabel(s,plan.startYear)}</option>)}</select></label>;
  const draftA=result?.proposals.find(p=>p.id===previewId)||result?.proposals[0];
  const draftB=result?.proposals.find(p=>p.id===compareId&&p.id!==draftA?.id)||result?.proposals.find(p=>p.id!==draftA?.id);
  const fullPlanNeedsReview=fullPlan&&draftA?.placements.some(placement=>placement.requisiteStatus==="needs_review");
  const showTerm=["generate_semester","discover_courses","find_alternatives","prerequisite_roadmap"].includes(action);
  const showTarget=generation||action==="critique_plan"||action==="advisor_brief";
  const validTarget=target>=1&&target<=24&&Number.isInteger(target*2);
  return <div className="ai-content">
    <div className="ai-symbol"><Sparkles size={31}/></div>
    <h2 id="drawer-title">A fresh perspective<br/>on your path.</h2>
    <p className="advisor-status" role="status">{status} <button className="text-button" onClick={() => setStatusCheck(check => check + 1)}>Check connection</button></p>
    <div className="advisor-form">
      <label>Planning workflow<select aria-label="Planning workflow" value={action} onChange={e=>choose(e.target.value as AdviceAction)}>{workflows.map(x=><option key={x.id} value={x.id}>{x.label}</option>)}</select></label>
      {showTerm&&termControl}
      {(action==="find_alternatives"||action==="prerequisite_roadmap")&&<label>Course<select value={courseId} onChange={e=>{reset();setCourseId(e.target.value)}}><option value="">Choose a course</option>{courses.filter(c=>plan.entries.some(e=>e.courseId===c.id)).map(c=><option key={c.id} value={c.id}>{c.code} · {c.title}</option>)}</select></label>}
      {showTarget&&<label>{fullPlan?"Credits per semester":"Reference credit target"}<input type="number" min="1" max="24" step="0.5" value={target} onChange={e=>{reset();setTarget(Number(e.target.value))}}/></label>}
      {action==="generate_semester"&&<p className="form-hint">Fills open credits and uses all eight terms as context. Current semester total: {current==null?"Credits unavailable":`${current} credits`}.</p>}
      {fullPlan&&<p className="form-hint">Fill open credits across all eight semesters while keeping courses you’ve already placed. The catalog covers one term, so verify future offerings and degree requirements.</p>}
      <label>Focus departments (up to five)<input value={focus} placeholder="CSC, MAT" onChange={e=>focusChange(e.target.value)}/></label>
      <label>Your goals<textarea maxLength={400} rows={3} value={goals} placeholder="What would you like this plan to make room for?" onChange={e=>{reset();setGoals(e.target.value)}}/></label>
      {generation&&<label className="check-label"><input type="checkbox" checked={allowReview} onChange={e=>{reset();setAllowReview(e.target.checked)}}/>Include courses with prerequisites to verify</label>}
      {action==="discover_courses"&&!goals.trim()&&!focus.trim()&&<p className="form-hint">Add a goal or one focus department to discover matching courses.</p>}
      <div className="advisor-actions">{state==="loading"?<button className="primary-button" onClick={()=>{controller.current?.abort();requestToken.current++;setState("idle");setMessage("Request canceled.")}}>Cancel</button>:<button className="primary-button" disabled={!revision||(showTarget&&!validTarget)||((action==="find_alternatives"||action==="prerequisite_roadmap")&&!courseId)||(action==="discover_courses"&&!goals.trim()&&!focus.trim())} onClick={run}>{fullPlan?"Generate 4-year plan":action==="generate_semester"?"Generate drafts":action==="critique_plan"?"Review plan":"Get advice"}</button>}</div>
    </div>
    <div className="ai-context"><BookOpen size={18}/><span>Your plan has {plan.entries.length} {plan.entries.length===1?"course":"courses"} across {new Set(plan.entries.map(e=>e.semesterId)).size} semesters. Catalog: {result?.sourceTerms.join(", ")??courses[0]?.source_term??(catalogLoadFailed?"unavailable":"loading")}. {catalogLoadFailed&&<button className="text-button" onClick={onCatalogRetry}>Retry catalog</button>}</span></div>
    {state==="loading"&&<p className="advisor-live" role="status">Reviewing your plan…</p>}
    {message&&<p className={state==="error"?"advisor-error":"advisor-summary"} role={state==="error"?"alert":"status"}>{message} {state==="error"&&<button className="text-button" onClick={run}><RefreshCw size={14}/>{message.toLowerCase().includes("catalog changed")?"Run again":"Retry"}</button>}</p>}
    {result?.mode==="rules"&&result.reason!=="model_not_needed"&&<p className="form-hint">Using catalog-based advice.</p>}
    {action==="generate_semester"&&result&&result.proposals.length>1&&draftA&&draftB&&<section className="advisor-card"><h3>Compare drafts</h3><label>First draft<select value={draftA.id} onChange={e=>setPreviewId(e.target.value)}>{result.proposals.map(p=><option key={p.id} value={p.id}>{p.label} · {p.id}</option>)}</select></label><label>Second draft<select value={draftB.id} onChange={e=>setCompareId(e.target.value)}>{result.proposals.filter(p=>p.id!==draftA.id).map(p=><option key={p.id} value={p.id}>{p.label} · {p.id}</option>)}</select></label><p>Only in first: {draftA.actions.map(a=>a.courseId).filter(id=>!draftB.actions.some(b=>b.courseId===id)).map(courseName).join(", ")||"None"}</p><p>Only in second: {draftB.actions.map(a=>a.courseId).filter(id=>!draftA.actions.some(b=>b.courseId===id)).map(courseName).join(", ")||"None"}</p><p>Shared: {draftA.actions.map(a=>a.courseId).filter(id=>draftB.actions.some(b=>b.courseId===id)).map(courseName).join(", ")||"None"}</p><p>Projected credits: {draftA.totals[0]?.after??"unavailable"} vs {draftB.totals[0]?.after??"unavailable"} · Review checks: {draftA.placements.filter(p=>p.requisiteStatus==="needs_review").length} vs {draftB.placements.filter(p=>p.requisiteStatus==="needs_review").length}</p><p>Focus departments: {focus||"None selected"}</p></section>}
    {fullPlan&&draftA&&<section className="advisor-results full-plan-result">
      <h3>4-year plan preview</h3>
      {draftB&&<label>Draft style<select disabled={state==="loading"} value={draftA.id} onChange={e=>{setPreviewId(e.target.value);setAck(false)}}>{result?.proposals.map(p=><option key={p.id} value={p.id}>{p.label}</option>)}</select></label>}
      <p className="form-hint">{draftA.rationale}</p>
      <FullPlanPreview key={draftA.id} draft={draftA} plan={plan} courses={courses} target={target}/>
      {draftA.notices.map(notice=><p className="form-hint" key={notice}>{notice}</p>)}
      {fullPlanNeedsReview&&<label className="check-label"><input type="checkbox" checked={ack} onChange={e=>setAck(e.target.checked)}/>I’ll verify the listed requisites before using this draft.</label>}
      <div className="advisor-actions"><button className="primary-button" disabled={state==="loading"||!!(fullPlanNeedsReview&&!ack)} onClick={()=>apply(draftA)}>Apply 4-year draft</button></div>
    </section>}
    {result && result.semesterStats.length>0&&(action==="critique_plan"||(fullPlan&&!draftA))&&<div className="stats-list"><h3>Eight-semester overview</h3>{result.semesterStats.map(s=><p key={s.semesterId}>{semesterLabel(s.semesterId,plan.startYear)} · {s.courseCount} courses · {s.credits==null?"Credits unavailable":`${s.credits} credits`}</p>)}</div>}
    {!fullPlan&&!!result?.proposals.length&&<div className="advisor-results"><h3>{action==="critique_plan"?"Proposed fixes":action==="find_alternatives"?"Replacement previews":"Drafts"}</h3>{result.proposals.slice(0,action==="critique_plan"?5:action==="find_alternatives"?5:3).map(p=>{const needsReview=p.placements.some(x=>x.requisiteStatus==="needs_review");const move=p.actions.some(a=>a.kind==="move");const replace=p.actions.some(a=>a.kind==="replace");const previewable=move||replace;return <article className="advisor-card" key={p.id}><span className="coming-soon">{p.label}</span><h4>{p.rationale}</h4><p>{p.actions.map(a=>`${a.kind} ${courseName(a.courseId)}${a.kind==="replace"&&a.replacementCourseId?` with ${courseName(a.replacementCourseId)}`:""} in ${semesterLabel(a.semesterId,plan.startYear)}`).join(" · ")}</p>{p.totals.map(t=><p key={t.semesterId}>{semesterLabel(t.semesterId,plan.startYear)} credits: {t.before??"unavailable"} → {t.after??"unavailable"}</p>)}{p.placements.map(x=><div className="evidence-row" key={x.courseId}><strong>{courseName(x.courseId)}</strong><span>{x.availability==="listed_in_source_term"?`Listed in ${courses.find(c=>c.id===x.courseId)?.source_term} catalog`:`Offering unverified for ${semesterLabel(x.semesterId,plan.startYear)}`}</span>{x.evidence.map((ev,i)=><small key={i}>{ev.excerpt}</small>)}</div>)}{p.notices.map((n,i)=><p className="form-hint" key={i}>{n}</p>)}{needsReview&&<label className="check-label"><input type="checkbox" checked={ack} onChange={e=>setAck(e.target.checked)}/>I’ll verify the listed requisites before using this draft.</label>}{previewable&&previewId!==p.id?<button className="primary-button" onClick={()=>setPreviewId(p.id)}>Preview {move?"move":"replacement"}</button>:<button className="primary-button" disabled={state==="loading"||!!(needsReview&&!ack)} onClick={()=>apply(p)}>{move?"Apply move":replace?"Apply replacement":"Add courses"}</button>}</article>})}</div>}
    {!!result?.findings.length&&<div className="advisor-results"><h3>Findings</h3>{result.findings.slice(0,expanded?result.findings.length:6).map(f=><article className="advisor-card" key={f.id}><span className={`severity ${f.severity}`}>{f.severity}</span><h4>{f.title}{f.semesterId?` · ${semesterLabel(f.semesterId,plan.startYear)}`:""}</h4><p>{f.detail}</p>{f.courseIds.map(id=><strong key={id}>{courseName(id)} </strong>)}{f.evidence.map((ev,i)=><blockquote key={i}>{ev.excerpt}</blockquote>)}<p className="form-hint">Next step: {f.nextStep}</p></article>)}{result.findings.length>6&&<button className="text-button" onClick={()=>setExpanded(!expanded)}>{expanded?"Show fewer":"Show all findings"}</button>}</div>}
    {!!result?.suggestions.length&&<div className="advisor-results"><h3>Course suggestions</h3>{result.suggestions.slice(0,5).map(s=>{const c=courses.find(x=>x.id===s.courseId);return <article className="advisor-card" key={s.courseId}><h4>{c?.code} · {c?.title}</h4><p>{s.reason}</p>{c?.description&&<p>{c.description}</p>}{s.availability&&<p className="form-hint">{s.availability==="listed_in_source_term"?`Listed in ${c?.source_term} catalog`:`Offering unverified for ${semesterLabel(semester,plan.startYear)}`}</p>}{onOpenCourse&&c&&<button className="text-button" onClick={()=>onOpenCourse(c)}>Open course details <ArrowUpRight size={14}/></button>}</article>})}</div>}
    {action==="advisor_brief"&&result&&<><button className="primary-button" onClick={copyBrief}>Copy advising brief</button>{copyFallback&&<label>Copy this brief<textarea rows={8} readOnly value={briefText} onFocus={e=>e.currentTarget.select()}/></label>}</>}
    {plan.entries.length===0&&action==="critique_plan"&&<p className="form-hint">Your plan is empty. Generate a semester or a 4-year plan to get started.</p>}
  </div>;
}

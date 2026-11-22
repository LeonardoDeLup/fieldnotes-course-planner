from contextlib import asynccontextmanager
import httpx
from fastapi import APIRouter, Body, HTTPException, Request, Response
from starlette.concurrency import run_in_threadpool
from .schemas import AdviceRequest
from .rules import catalog_revision
from .rules import SEMESTERS, term_label
from . import workflows

router=APIRouter(prefix="/api/ai", tags=["advisor"])

@router.get("/status")
async def status(request: Request, refresh: bool=False):
    return await request.app.state.ollama.status(refresh)

@router.post("/advice")
async def advice(request: Request, response: Response, body: AdviceRequest = Body(...)):
    try:
        courses=request.app.state.catalog_provider.list()
    except Exception as exc:
        raise HTTPException(status_code=503,detail={"code":"catalog_unavailable"}) from exc
    revision=catalog_revision(courses)
    if revision!=body.catalog_revision:
        raise HTTPException(status_code=409,detail={"code":"catalog_changed"})
    options=body.options.model_dump(by_alias=True)
    action=body.action
    departments={c.department for c in courses}
    if any(d not in departments for d in options.get("focusDepartments",[])):
        raise HTTPException(status_code=422,detail="Unknown focus department")
    if action in {"find_alternatives","prerequisite_roadmap"} and options.get("courseId") not in {c.id for c in courses}:
        raise HTTPException(status_code=422,detail="Unknown course ID")
    if action=="find_alternatives" and not any(e.course_id==options.get("courseId") and e.semester_id==options.get("semesterId") for e in body.plan.entries):
        raise HTTPException(status_code=422,detail="Select the course in its current planned semester")
    if action=="discover_courses" and not options.get("goals") and not options.get("focusDepartments"):
        raise HTTPException(status_code=422,detail="Add a goal or focus department")
    if action=="generate_semester": result=workflows.generate(revision,courses,body.plan,options)
    elif action=="generate_full_plan":
        result=await run_in_threadpool(workflows.generate_full_plan,revision,courses,body.plan,options)
    elif action=="critique_plan": result=workflows.critique(revision,courses,body.plan,options)
    else: result=workflows.other_workflow(action,revision,courses,body.plan,options)
    response.headers["X-Catalog-Revision"]=revision
    # The model may only change the order of already validated deterministic IDs.
    try:
        if action=="critique_plan" or action in {"prerequisite_roadmap","advisor_brief"}:
            all_choices=[f.id for f in result.findings]
        elif action in {"discover_courses"}:
            all_choices=[s.course_id for s in result.suggestions]
        else:
            all_choices=[p.id for p in result.proposals] or [s.course_id for s in result.suggestions] or [f.id for f in result.findings]
        choices=all_choices[:4]
        if len(choices)>1:
            by_id={c.id:c for c in courses}
            grouped=[]
            for sid in SEMESTERS:
                rows=[e for e in body.plan.entries if e.semester_id==sid]
                compact_rows=[{"id":e.course_id,"code":by_id[e.course_id].code if e.course_id in by_id else "Unavailable"} for e in rows[:4]]
                if len(rows)>4: compact_rows.append({"omittedRows":len(rows)-4})
                grouped.append({"term":term_label(sid,body.plan.start_year),"semesterId":sid,"courses":compact_rows})
            proposal_by_id={p.id:p for p in result.proposals};finding_by_id={f.id:f for f in result.findings};suggestion_by_id={s.course_id:s for s in result.suggestions}
            choice_context=[]
            for choice_id in choices:
                if choice_id in proposal_by_id:
                    item=proposal_by_id[choice_id]
                    if action=="generate_full_plan":
                        semesters=[]
                        review_ids={p.course_id for p in item.placements if p.requisite_status=="needs_review"}
                        for total in item.totals:
                            additions=[by_id[a.course_id] for a in item.actions if a.semester_id==total.semester_id]
                            semesters.append({
                                "term":term_label(total.semester_id,body.plan.start_year),
                                "credits":total.after,
                                "additions":[{"code":c.code,"title":c.title[:64],"needsRequisiteReview":c.id in review_ids} for c in additions],
                            })
                        choice_context.append({"id":choice_id,"tradeoffs":item.rationale,"semesters":semesters})
                        continue
                    ids=[a.course_id for a in item.actions]
                    facts=[{"id":cid,"code":by_id[cid].code,"title":by_id[cid].title[:100],"credits":by_id[cid].credit_display or by_id[cid].credits,"department":by_id[cid].department,"requisites":(by_id[cid].prerequisites or "")[:120],"description":(by_id[cid].description or "")[:120]} for cid in ids if cid in by_id]
                    choice_context.append({"id":choice_id,"tradeoffs":item.rationale,"notices":item.notices,"courses":facts})
                elif choice_id in finding_by_id:
                    item=finding_by_id[choice_id]; choice_context.append({"id":choice_id,"severity":item.severity,"title":item.title,"tradeoff":item.detail[:240],"evidence":[x.excerpt[:120] for x in item.evidence[:2]]})
                elif choice_id in suggestion_by_id:
                    item=suggestion_by_id[choice_id]; course=by_id.get(choice_id); choice_context.append({"id":choice_id,"reason":item.reason,"code":course.code if course else "Unavailable","title":course.title[:100] if course else "Unavailable","department":course.department if course else ""})
            context={"goals":options.get("goals",""),"targetCredits":options.get("targetCredits",16),"focusDepartments":options.get("focusDepartments",[]),"semesterStats":[{"term":term_label(s.semester_id,body.plan.start_year),"courseCount":s.course_count,"credits":s.credits} for s in result.semester_stats],"plan":grouped,"choices":choice_context}
            order,reason=await request.app.state.ollama.rank(action,context,choices)
            order += [x for x in all_choices if x not in order]
            if result.proposals:
                target=options.get("targetCredits",16)
                if action=="generate_full_plan":
                    result.proposals.sort(key=lambda x:(workflows.full_plan_shortfall(x,target),order.index(x.id)))
                else:
                    result.proposals.sort(key=lambda x:(0 if action=="generate_semester" and x.totals and x.totals[0].after==target else 1,order.index(x.id) if x.id in order else 999))
            elif result.findings:
                ranks={x:i for i,x in enumerate(order)}
                # Preserve severity groups while allowing within-group prioritization.
                result.findings.sort(key=lambda x:({"attention":0,"review":1,"info":2}[x.severity],ranks.get(x.id,999)))
            elif result.suggestions: result.suggestions.sort(key=lambda x:order.index(x.course_id))
            result.mode="model" if reason is None else "rules"
            result.reason=reason
    except Exception:
        result.mode="rules"; result.reason="invalid_model_output"
    return result.model_dump(by_alias=True)

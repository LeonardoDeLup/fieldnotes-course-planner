"""Build advice from the current plan and catalog; model output only ranks IDs."""
from collections import defaultdict
from decimal import Decimal
from .schemas import Advice, Finding, Proposal, Action, Total, Placement, Suggestion, Entry, MAX_PLAN_ENTRIES
from .requisites import course_requirements
from .rules import (SEMESTERS, availability, course_identity, evidence, fixed_credit, goal_score,
                    requisite_status, term_label, totals)

def _stats(plan, courses):
    return [{"semesterId": sid, "courseCount": n, "credits": value}
            for sid, (n, value) in totals(plan, courses).items()]

def _base(action, revision, courses, plan, summary):
    return dict(action=action, catalogRevision=revision,
                sourceTerms=sorted({c.source_term for c in courses}), mode="rules",
                reason="model_not_needed", summary=summary, proposals=[], findings=[],
                suggestions=[], semesterStats=_stats(plan, courses))

def critique(revision, courses, plan, options):
    out = _base("critique_plan", revision, courses, plan, "Catalog-based review of all eight planned semesters.")
    by_id = {c.id: c for c in courses}; entries = plan.entries
    index = {e.course_id: SEMESTERS.index(e.semester_id) for e in entries}
    grouped = defaultdict(list)
    for e in entries:
        course = by_id.get(e.course_id)
        if course is None:
            grouped[("unavailable_course", e.semester_id)].append(e.course_id); continue
        if course.credits is None:
            grouped[("unknown_credits", e.semester_id)].append(e.course_id)
        status, ev, missing = requisite_status(course, plan, courses)
        if status == "sequence_gap":
            key = ("corequisite_gap" if course.id == "chm-129" else "sequence_gap", e.semester_id)
            grouped[(*key, course.id)].append((course, ev, missing))
        elif status == "needs_review":
            grouped[("requisite_review", e.semester_id, course.id)].append((course, ev, []))
        if course.source_term != term_label(e.semester_id, plan.start_year):
            grouped[("offering_unverified", e.semester_id)].append(course)
    stats = totals(plan, courses); target = options.get("targetCredits", 16)
    populated = [SEMESTERS.index(s) for s,(n,_) in stats.items() if n]
    if populated:
        for i in range(min(populated), max(populated)+1):
            sid=SEMESTERS[i]
            if not stats[sid][0]: grouped[("empty_between_terms",sid)].append(sid)
        for sid,(count,credit) in stats.items():
            if count and credit is not None:
                delta=credit-float(target)
                if delta <= -2: grouped[("credit_below_target",sid)].append((credit,float(target)))
                elif delta >= 2: grouped[("credit_above_target",sid)].append((credit,float(target)))
    severity={"sequence_gap":"attention","corequisite_gap":"attention","unavailable_course":"review","unknown_credits":"review","requisite_review":"review","offering_unverified":"info","empty_between_terms":"info","credit_below_target":"info","credit_above_target":"info"}
    for key, values in grouped.items():
        code, sid = key[:2]
        if code in {"sequence_gap","corequisite_gap","requisite_review"}:
            c,ev,missing=values[0]
            if code == "corequisite_gap":
                detail=f"{c.code} requires CHM 129L in the same term."
                step="Place CHM 129 and CHM 129L together, or verify the requirement with an adviser."
            elif code == "sequence_gap":
                detail=f"Check the catalog timing for {', '.join(missing)} in this plan."
                step="Check completed or transfer work and place each required course in a term that meets the catalog timing."
            else:
                detail="The catalog text is not fully covered by a deterministic rule."
                step="Verify the current requisite text with the department or an adviser."
            ids=[c.id]
            out["findings"].append(Finding(id=f"f-{len(out['findings'])+1}",code=code,severity=severity[code],semesterId=sid,courseIds=ids,title=f"{c.code} requisite needs attention",detail=detail,nextStep=step,evidence=ev,proposalId=None))
        elif code in {"unavailable_course","unknown_credits"}:
            ids=values
            out["findings"].append(Finding(id=f"f-{len(out['findings'])+1}",code=code,severity=severity[code],semesterId=sid,courseIds=ids,title="Catalog information unavailable",detail="One or more saved courses are unavailable in this catalog; the semester credit total cannot be confirmed.",nextStep="Keep the saved row and verify its credits against the current catalog.",evidence=[],proposalId=None))
        else:
            details={"offering_unverified":"The placement term differs from this catalog snapshot.","empty_between_terms":"An empty semester falls between populated terms.","credit_below_target":"The known course total is at least two credits below the reference target.","credit_above_target":"The known course total is at least two credits above the reference target."}
            ids=[c.id for c in values if hasattr(c,"id")] if code=="offering_unverified" else []
            detail=details[code]
            if code=="offering_unverified":
                detail="; ".join(f"{c.code} is listed in {c.source_term}, while this plan places it in {term_label(sid,plan.start_year)}." for c in values)
            elif code.startswith("credit_"): detail=f"Known total {values[0][0]:g} credits; reference target {values[0][1]:g} credits. " + details[code]
            out["findings"].append(Finding(id=f"f-{len(out['findings'])+1}",code=code,severity=severity[code],semesterId=sid,courseIds=ids,title=code.replace('_',' ').capitalize(),detail=detail,nextStep="Review whether this planning signal matches your goals.",evidence=[],proposalId=None))
    focus=set(options.get("focusDepartments",[])); resolved=[e for e in entries if e.course_id in by_id]
    if focus and len(resolved)>=3:
        count=sum(by_id[e.course_id].department in focus for e in resolved)
        out["findings"].append(Finding(id=f"f-{len(out['findings'])+1}",code="focus_distribution",severity="info",semesterId=None,courseIds=[],title="Focus department coverage",detail=f"{count} of {len(resolved)} catalog-resolved course placements are in {', '.join(sorted(focus))}.",nextStep="Decide whether this balance matches the breadth you want.",evidence=[],proposalId=None))
    out["findings"].sort(key=lambda f: ({"attention":0,"review":1,"info":2}[f.severity], SEMESTERS.index(f.semester_id) if f.semester_id else 9, f.course_ids[0] if f.course_ids else ""))
    # Offer one exact, simulated move for a supported prerequisite gap when it
    # fixes the gap without creating another modeled sequence failure.
    reference_target=float(options.get("targetCredits",16))
    for finding in out["findings"]:
        if finding.code!="sequence_gap" or not finding.course_ids or len(out["proposals"])>=5: continue
        course_id=finding.course_ids[0]; original=next((e for e in entries if e.course_id==course_id),None)
        course=by_id.get(course_id)
        if not original or not course: continue
        old_index=SEMESTERS.index(original.semester_id); move_options=[]
        before_totals=totals(plan,courses)
        baseline={cid:requisite_status(c,plan,courses)[0] for cid,c in by_id.items() if cid in index}
        for new_index,new_sid in enumerate(SEMESTERS):
            if new_index==old_index: continue
            moved=[e.model_copy(update={"semester_id":new_sid}) if e.course_id==course_id else e for e in entries]
            trial=plan.model_copy(update={"entries":moved})
            if requisite_status(course,trial,courses)[0]!="no_issue_in_plan": continue
            trial_status={cid:requisite_status(c,trial,courses)[0] for cid,c in by_id.items() if cid in index}
            if any(st=="no_issue_in_plan" and trial_status.get(cid)=="sequence_gap" for cid,st in baseline.items()): continue
            after_totals=totals(trial,courses)
            if any(after_totals[s][1] is None or before_totals[s][1] is None for s in (original.semester_id,new_sid)): continue
            target=reference_target
            overload_before=max(0,(before_totals[new_sid][1] or 0)-target)
            overload_after=max(0,(after_totals[new_sid][1] or 0)-target)
            if overload_after>overload_before: continue
            source_ok=course.source_term==term_label(new_sid,plan.start_year)
            deviation=abs((after_totals[original.semester_id][1] or 0)-target)+abs((after_totals[new_sid][1] or 0)-target)
            move_options.append(((not source_ok,abs(new_index-old_index),deviation,course_id,new_index),new_sid,trial,after_totals))
        if move_options:
            _,new_sid,trial,after_totals=min(move_options,key=lambda x:x[0]); pid=f"repair-{len(out['proposals'])+1}"
            moved_course=by_id[course_id]
            out["proposals"].append(Proposal(id=pid,label="Preview move",rationale=f"Move {moved_course.code} to {term_label(new_sid,plan.start_year)} so its planned prerequisite is earlier.",actions=[Action(kind="move",courseId=course_id,fromSemesterId=original.semester_id,semesterId=new_sid)],totals=[Total(semesterId=original.semester_id,before=before_totals[original.semester_id][1],after=after_totals[original.semester_id][1]),Total(semesterId=new_sid,before=before_totals[new_sid][1],after=after_totals[new_sid][1])],placements=[Placement(courseId=course_id,semesterId=new_sid,availability=availability(moved_course,new_sid,plan.start_year),requisiteStatus="no_issue_in_plan",evidence=[x for x in (evidence(moved_course,"prerequisites"),evidence(moved_course,"system_requisites")) if x])],notices=[]))
            finding.proposal_id=pid
    return Advice.model_validate(out)

def generate(revision, courses, plan, options, *, perspective=None, pathways=None):
    sid=options["semesterId"]; target=Decimal(str(options.get("targetCredits",16)))
    by_id={c.id:c for c in courses}
    current=totals(plan,courses)[sid][1]
    out=_base("generate_semester",revision,courses,plan,"Drafts use the catalog snapshot and your full eight-semester plan as context.")
    if current is None:
        out["summary"]="This semester has unknown credits, so a target-matched draft cannot be calculated. Resolve unavailable credit data first."
        return Advice.model_validate(out)
    remaining=target-Decimal(str(current))
    if remaining<=0:
        out["summary"]="This semester has already reached the selected target. Choose a higher target to add courses."
        return Advice.model_validate(out)
    existing_ids={e.course_id for e in plan.entries}
    existing_codes={course_identity(by_id[e.course_id]) for e in plan.entries if e.course_id in by_id}
    focus=set(options.get("focusDepartments", []))
    pathways = pathways or {}
    lab=by_id.get("chm-129l")
    allow_review=options.get("allowRequisiteReview",True)
    candidates=[]
    for c in courses:
        if c.id=="chm-129l": continue  # The lab is only suggested with its chemistry course.
        if c.id in existing_ids or course_identity(c) in existing_codes or c.credits is None or c.credits<=0: continue
        bundle=[c]
        if c.id=="chm-129":
            if lab is None or lab.credits is None: continue
            if lab.id in existing_ids:
                lab_entry=next(e for e in plan.entries if e.course_id==lab.id)
                if lab_entry.semester_id!=sid: continue
            elif course_identity(lab) in existing_codes: continue
            else: bundle.append(lab)
        credits=sum((fixed_credit(x) for x in bundle),Decimal(0))
        if credits>remaining: continue
        trial=plan.model_copy(update={"entries":plan.entries+[Entry(courseId=x.id,semesterId=sid) for x in bundle]})
        statuses=[requisite_status(x,trial,courses,by_id=by_id)[0] for x in bundle]
        if "sequence_gap" in statuses: continue
        needs_review="needs_review" in statuses
        if needs_review and not allow_review: continue
        candidates.append((c,bundle,credits,needs_review))
    represented={by_id[e.course_id].department for e in plan.entries if e.course_id in by_id}
    goal_scores={c.id:goal_score(c,options.get("goals", "")) for c,_,_,_ in candidates}
    base_scores={c.id:goal_scores[c.id]-(6 if needs_review else 0)
                 for c,_,_,needs_review in candidates}
    if perspective is not None:
        term_index=SEMESTERS.index(sid)
        focus_credits=defaultdict(float)
        for entry in plan.entries:
            existing=by_id.get(entry.course_id)
            if existing and existing.department in focus:
                focus_credits[existing.department] += existing.credits or 0
        for c,_,_,_ in candidates:
            base_scores[c.id] += 5*goal_scores[c.id] - 2
            # Favor earlier courses that make later focus courses possible.
            base_scores[c.id] += min(20, pathways.get(c.code, 0)) * (7-term_index) / 4
            if c.department in focus:
                base_scores[c.id] += 8/(1+focus_credits[c.department]/4)
            if term_index < 2:
                base_scores[c.id] += {100:1,200:0,300:-3,400:-5}.get(c.level,0)
    continuity=2 if perspective is None else 0
    perspectives={
        "Balanced":lambda c:base_scores[c.id]+(3 if c.department in focus else 0)+(continuity if c.department in represented else 0),
        "Focus":lambda c:base_scores[c.id]+(5 if c.department in focus else 0)+(continuity if c.department in represented else 0),
        "Breadth":lambda c:base_scores[c.id]+(2 if c.department not in represented else 0),
    }
    priority_credits={}
    for course, _, credits, _ in candidates:
        priority_credits[course.id]=Decimal(0)
        if course.department in focus or (perspective is not None and not focus and goal_scores[course.id]>=2):
            priority_credits[course.id]=credits
        elif pathways.get(course.code, 0):
            priority_credits[course.id]=credits/2

    finalist_rows=[]; seen_drafts=set()
    for label,score_for in perspectives.items():
        if perspective is not None and label != perspective: continue
        ordered=sorted(candidates,key=lambda row:(-priority_credits[row[0].id],-score_for(row[0]),row[0].id))
        # Preserve department breadth while bounding the search over the large catalog.
        pool=ordered[:60]
        for value in sorted({int(row[2]*2) for row in candidates}):
            pool.extend([row for row in ordered if int(row[2]*2)==value][:2])
        pool=list({row[0].id:row for row in pool}.values())
        pool.sort(key=lambda row:(-priority_credits[row[0].id],-score_for(row[0]),row[0].id))
        states=[{"rows":(),"credits":Decimal(0),"ids":frozenset(),"codes":frozenset(),"score":0,
                 "next_index":0,"departments":frozenset(),"priority":Decimal(0)}]
        finalized=[]
        for _depth in range(6):
            buckets=defaultdict(list)
            for state in states:
                for index in range(state["next_index"],len(pool)):
                    row=pool[index]
                    c,bundle,credits,_=row
                    bundle_ids={x.id for x in bundle}; bundle_codes={course_identity(x) for x in bundle}
                    if state["ids"] & bundle_ids or state["codes"] & bundle_codes: continue
                    if len(plan.entries)+len(state["ids"])+len(bundle)>MAX_PLAN_ENTRIES: continue
                    added=state["credits"]+credits
                    if added>remaining: continue
                    diversity=2 if perspective=="Breadth" and c.department not in state["departments"] else 0
                    entry={"rows":state["rows"]+(row,),"credits":added,"ids":state["ids"]|bundle_ids,
                           "codes":state["codes"]|bundle_codes,"score":state["score"]+score_for(c)+diversity,
                           "priority":state["priority"]+priority_credits[c.id],
                           "next_index":index+1 if perspective is not None else 0,
                           "departments":state["departments"]|{c.department}}
                    key=(int(added*2),len(entry["rows"]))
                    buckets[key].append(entry)
                    finalized.append(entry)
            states=[]
            for key,values in buckets.items():
                values.sort(key=lambda x:(-x["priority"],-x["score"],tuple(sorted(x["ids"]))))
                states.extend(values[:24])
            if not states: break
        finalized.sort(key=lambda x:(-x["priority"],remaining-x["credits"],-x["score"],tuple(sorted(x["ids"]))))
        added_for_label=0
        for state in finalized:
            key=tuple(sorted(state["ids"]))
            if key in seen_drafts: continue
            seen_drafts.add(key)
            finalist_rows.append((label,state)); added_for_label+=1
            if added_for_label==(1 if perspective is not None else 4): break
    finalist_rows.sort(key=lambda item:(-item[1]["priority"],remaining-item[1]["credits"],-item[1]["score"],tuple(sorted(item[1]["ids"]))))
    proposals=[]
    for n,(label,state) in enumerate(finalist_rows[:12]):
        bundle_courses=[]
        for row in state["rows"]:
            for c in row[1]:
                if c.id not in {x.id for x in bundle_courses}: bundle_courses.append(c)
        simulated=plan.model_copy(update={"entries":plan.entries+[Entry(courseId=x.id,semesterId=sid) for x in bundle_courses if x.id not in existing_ids]})
        placements=[]; notices=[]
        for x in bundle_courses:
            st,xev,_=requisite_status(x,simulated,courses,by_id=by_id)
            placements.append(Placement(courseId=x.id,semesterId=sid,availability=availability(x,sid,plan.start_year),requisiteStatus="needs_review" if st=="needs_review" else "no_issue_in_plan",evidence=xev))
            if st=="needs_review": notices.append(f"Verify the catalog requisites for {x.code} before placing it.")
        after=Decimal(str(current))+state["credits"]
        departments=sorted({x.department for x in bundle_courses})
        summary=f"Adds {len(bundle_courses)} course{'s' if len(bundle_courses)!=1 else ''} across {', '.join(departments)} for {float(state['credits']):g} credits."
        proposal=Proposal(id=f"p{n+1}",label=label,rationale=summary,actions=[Action(kind="add",courseId=x.id,semesterId=sid) for x in bundle_courses],totals=[Total(semesterId=sid,before=current,after=float(after))],placements=placements,notices=notices)
        proposals.append(proposal)
    out["proposals"]=proposals
    if not proposals:
        out["summary"]=f"No eligible catalog courses fit the remaining {float(remaining):g} credits under these prerequisite settings."
    elif not any(p.totals[0].after==float(target) for p in proposals):
        out["summary"]=f"No exact target draft was found in the eligible shortlist. These drafts leave some credits open from {float(remaining):g}."
    return Advice.model_validate(out)

def full_plan_shortfall(proposal, target):
    return sum(total.after is None or total.after < target for total in proposal.totals)


def draft_priority(proposal, plan, by_id, options):
    focus = set(options.get("focusDepartments", []))
    projected = [by_id[row.course_id] for row in [*plan.entries, *proposal.actions] if row.course_id in by_id]
    represented = {course.department for course in projected if course.department in focus}
    focus_credits = sum(course.credits or 0 for course in projected if course.department in focus)
    goals = options.get("goals", "")
    goal_matches = sum(goal_score(course, goals) for course in projected)
    return (-len(represented), -focus_credits, -goal_matches,
            full_plan_shortfall(proposal, options.get("targetCredits", 16)))


def _pathway_weights(courses, focus, goals):
    # Trace each requested course back to the courses that open a path to it.
    prerequisites = defaultdict(set)
    for course in courses:
        for rule in course_requirements(course)[0]:
            if rule.timing != "same":
                prerequisites[course.code].update(rule.codes)
    dependents = defaultdict(set)
    for course in courses:
        if course.department not in focus and not goal_score(course, goals):
            continue
        seen = {course.code}
        pending = list(prerequisites[course.code])
        while pending:
            code = pending.pop()
            if code in seen:
                continue
            seen.add(code)
            dependents[code].add(course.code)
            pending.extend(prerequisites[code] - seen)
    return {code: len(target_codes) for code, target_codes in dependents.items()}


def generate_full_plan(revision, courses, plan, options):
    target=options.get("targetCredits",16)
    out=_base("generate_full_plan",revision,courses,plan,
              "Review the proposed courses and projected credits for all eight semesters.")
    before=totals(plan,courses)
    focus=options.get("focusDepartments", [])
    by_id={course.id: course for course in courses}
    pathways=_pathway_weights(courses, set(focus), options.get("goals", ""))
    first_profile="Focus" if focus else "Balanced"
    labels={"Focus":"More focus courses","Balanced":"Balanced mix",
            "Breadth":"Focus with a wider mix of electives" if focus else "More departmental breadth"}
    seen=set()

    for profile in (first_profile,"Breadth"):
        draft=plan
        actions=[]
        placements=[]
        for sid in SEMESTERS:
            current=before[sid][1]
            if current is None or current>=target:
                continue
            term=generate(revision,courses,draft,{**options,"semesterId":sid},perspective=profile,pathways=pathways)
            if not term.proposals:
                continue
            addition=term.proposals[0]
            actions.extend(addition.actions)
            placements.extend(addition.placements)
            draft=draft.model_copy(update={"entries":draft.entries+[
                Entry(courseId=a.course_id,semesterId=a.semester_id) for a in addition.actions
            ]})

        key=frozenset((a.course_id,a.semester_id) for a in actions)
        if not key or key in seen:
            continue
        seen.add(key)
        after=totals(draft,courses)
        reached=sum(credits is not None and credits>=target for _,credits in after.values())
        reviews=sum(p.requisite_status=="needs_review" for p in placements)
        notices=[f"{reviews} proposed courses have requisites to verify."] if reviews else []
        if focus:
            counts=defaultdict(int)
            for action in actions:
                counts[by_id[action.course_id].department] += 1
            coverage=", ".join(f"{department} {counts[department]}" for department in focus)
            notices.append(f"Proposed courses by focus department ({coverage}).")
            if not any(counts[department] for department in focus):
                notices.append("This draft adds electives only. Check open credits and prerequisites in your focus departments.")
        out["proposals"].append(Proposal(
            id=f"full-{profile.lower()}",label=labels[profile],
            rationale=f"Adds {len(actions)} courses and reaches the {target:g}-credit target in {reached} of 8 semesters.",
            actions=actions,placements=placements,
            totals=[Total(semesterId=sid,before=before[sid][1],after=after[sid][1]) for sid in SEMESTERS],
            notices=notices,
        ))

    out["proposals"].sort(key=lambda proposal:draft_priority(proposal,plan,by_id,options))
    if not out["proposals"]:
        if all(credits is not None and credits>=target for _,credits in before.values()):
            out["summary"]="All eight semesters already meet or exceed your credit target."
        else:
            out["summary"]="No eligible courses fit the open credits. Check semesters with unknown credits or adjust your draft settings."
    return Advice.model_validate(out)


def other_workflow(action, revision, courses, plan, options):
    out=_base(action,revision,courses,plan,"Catalog-based results.")
    by_id={c.id:c for c in courses}; planned={e.course_id for e in plan.entries}
    if action=="discover_courses":
        goals=options.get("goals", ""); focus=set(options.get("focusDepartments",[]))
        matches=[c for c in courses if goal_score(c,goals)>0 or c.department in focus]
        fallback=not matches
        if fallback: matches=[c for c in courses if c.level==100]
        term=options.get("semesterId")
        matches.sort(key=lambda c:(-(goal_score(c,goals)+(5 if c.department in focus else 0)), c.source_term!=term_label(term,plan.start_year) if term else False,c.department,c.id))
        if fallback:
            unique=[]; seen_depts=set()
            for c in matches:
                if c.department not in seen_depts: unique.append(c);seen_depts.add(c.department)
            matches=unique
            out["summary"]="No direct goal or focus matches were found. This is a broad exploration list of introductory courses."
        for c in matches[:12]:
            stat,ev,_=requisite_status(c,plan,courses)
            reason="Already in your plan; review its catalog detail." if c.id in planned else "Broad exploration option." if fallback else "Matches the selected interests."
            out["suggestions"].append(Suggestion(courseId=c.id,reason=reason,availability=availability(c,term,plan.start_year) if term else None,requisiteStatus=stat,evidence=ev,proposalId=None))
    elif action=="find_alternatives":
        target=by_id.get(options.get("courseId")); term=options.get("semesterId")
        if target and term:
            source_entry=next((e for e in plan.entries if e.course_id==target.id and e.semester_id==term),None)
            for c in courses:
                if c.id in planned or c.credits is None or c.credits!=target.credits or c.id==target.id: continue
                if target.id in {"chm-129","chm-129l"} or c.id in {"chm-129","chm-129l"}: continue
                status,ev,_=requisite_status(c,plan,courses)
                if status!="no_issue_in_plan": continue
                reason="Same fixed credits and no modeled requisite issue in this plan."
                proposal_id=None
                if source_entry:
                    trial_entries=[e for e in plan.entries if e.course_id!=target.id]
                    from .schemas import Entry as PlanEntry
                    trial_entries.append(PlanEntry(courseId=c.id,semesterId=term))
                    trial=plan.model_copy(update={"entries":trial_entries})
                    trial_codes=[by_id[e.course_id].code for e in trial.entries if e.course_id in by_id]
                    if len(trial_codes)==len(set(trial_codes)) and requisite_status(c,trial,courses)[0]=="no_issue_in_plan":
                        baseline={cid:requisite_status(x,plan,courses)[0] for cid,x in by_id.items() if cid in planned}
                        after={cid:requisite_status(x,trial,courses)[0] for cid,x in by_id.items() if cid in {e.course_id for e in trial.entries}}
                        if not any(before=="no_issue_in_plan" and after.get(cid)=="sequence_gap" for cid,before in baseline.items()):
                            total=totals(plan,courses)[term][1]
                            if total is not None:
                                proposal_id=f"replace-{len(out['proposals'])+1}"
                                out["proposals"].append(Proposal(id=proposal_id,label="Replacement",rationale=f"Replace {target.code} with {c.code} while keeping the term at {total:g} credits.",actions=[Action(kind="replace",courseId=target.id,replacementCourseId=c.id,semesterId=term)],totals=[Total(semesterId=term,before=total,after=total)],placements=[Placement(courseId=c.id,semesterId=term,availability=availability(c,term,plan.start_year),requisiteStatus="no_issue_in_plan",evidence=ev)],notices=[]))
                out["suggestions"].append(Suggestion(courseId=c.id,reason=reason,availability=availability(c,term,plan.start_year),requisiteStatus=status,evidence=ev,proposalId=proposal_id))
            focused=set(options.get("focusDepartments",[])); selected_term=term_label(term,plan.start_year)
            out["suggestions"].sort(key=lambda s:(by_id[s.course_id].department!=target.department,by_id[s.course_id].department not in focused,-goal_score(by_id[s.course_id],options.get("goals","")),by_id[s.course_id].source_term!=selected_term,s.course_id))
            preference={s.course_id:i for i,s in enumerate(out["suggestions"])}
            out["proposals"].sort(key=lambda p:preference.get(p.actions[0].replacement_course_id or "",999))
            out["suggestions"]=out["suggestions"][:12]
            out["proposals"]=out["proposals"][:12]
    elif action=="prerequisite_roadmap":
        c=by_id.get(options.get("courseId"))
        if c:
            dependencies={"csc-161":(["csc-151"],"prior"),"csc-207":(["csc-151","csc-161"],"prior"),"mat-133":(["mat-124","mat-131"],"or"),"mat-215":(["mat-133"],"prior"),"chm-129":(["chm-129l"],"same")}
            positions=defaultdict(list)
            for entry in plan.entries: positions[entry.course_id].append(SEMESTERS.index(entry.semester_id))
            target_pos=SEMESTERS.index(options["semesterId"]) if options.get("semesterId") else (positions[c.id][0] if positions[c.id] else None)
            visited=set()
            def walk(parent, depth, path):
                if depth>=3 or parent.id in path or parent.id in visited: return
                visited.add(parent.id)
                deps,kind=dependencies.get(parent.id,([],"prior"))
                if not deps: return
                ev=[x for x in (evidence(parent,"prerequisites"),evidence(parent,"system_requisites")) if x]
                known=[d for d in deps if d in by_id]; unknown=[d for d in deps if d not in by_id]
                for dep in known+unknown:
                    related=by_id.get(dep)
                    if related is None:
                        detail=f"{dep.upper().replace('-', ' ')} is named as an alternative, but no course ID exists in this catalog snapshot. Confirm whether it is available."
                        step="Ask whether this catalog alternative is offered and whether your prior work satisfies it."
                        status="needing source confirmation"; ids=[parent.id]
                    else:
                        planned=positions.get(dep,[]); satisfies=any((p==target_pos if kind=="same" else target_pos is not None and p<target_pos) for p in planned)
                        if satisfies: status="same term required" if kind=="same" else "already earlier in plan"
                        elif planned: status="planned later"
                        else: status="missing from plan"
                        detail=f"{related.code} is {status}."; step="Verify completed or transfer work, then place this course in a term that satisfies the listed requisite."
                        ids=[parent.id,related.id]
                    out["findings"].append(Finding(id=f"roadmap-{len(out['findings'])+1}",code="roadmap_step",severity="review" if status in {"missing from plan","planned later","needing source confirmation"} else "info",semesterId=options.get("semesterId"),courseIds=ids,title=f"{related.code if related else dep.upper().replace('-', ' ')} · {status}",detail=detail,nextStep=step,evidence=ev,proposalId=None))
                    if related: walk(related,depth+1,path|{parent.id})
            walk(c,0,set())
            if not out["findings"]:
                status,ev,_=requisite_status(c,plan,courses)
                out["findings"].append(Finding(id="roadmap-1",code="roadmap_step",severity="review" if status=="needs_review" else "info",semesterId=options.get("semesterId"),courseIds=[c.id],title=f"{c.code} prerequisite path",detail="No modeled prerequisite dependency is available; review the source text below.",nextStep="Verify the listed requirements with the department.",evidence=ev,proposalId=None))
    elif action=="advisor_brief":
        review=critique(revision,courses,plan,options)
        out["findings"]=review.findings[:5]
        for finding in out["findings"]:
            code=finding.course_ids[0] if finding.course_ids else "this part of my plan"
            if finding.code in {"sequence_gap","corequisite_gap","requisite_review"}:
                finding.next_step=f"Can I take {code} based on completed or transfer work, and what should I verify?"
            elif finding.code=="offering_unverified": finding.next_step=f"Is my planned offering for {finding.semester_id} available in that term?"
            elif finding.code.startswith("credit_"): finding.next_step=f"Does this course load fit my goals for {finding.semester_id}?"
        covered=sum(x[0] for x in totals(plan,courses).values())
        unknown=any(x[0] and x[1] is None for x in totals(plan,courses).values())
        out["summary"]=f"Advising brief · {covered} planned courses across eight semesters · {revision[:12]} catalog revision. Credits unavailable in one or more populated terms." if unknown else f"Advising brief · {covered} planned courses across eight semesters · {revision[:12]} catalog revision. Catalog offerings and degree requirements need adviser confirmation."
    return Advice.model_validate(out)

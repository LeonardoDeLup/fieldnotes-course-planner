# Fieldnotes AI advisor implementation plan

## 1. Delivery order

Implement phases 0–3 in order. Phase 3 is the first release and includes both required workflows. Ship the four follow-on workflows in phase 4 using the same advisor drawer and backend. The Python service should build valid options and findings from the plan and catalog. Local Qwen should rank those options and prioritize the findings using the student's stated goals and the rest of the plan.

| Phase | Deliverable | Exit check |
| --- | --- | --- |
| 0 | Reconcile current fixtures and verify the installed model | Python and TypeScript baseline tests pass after the fixture corrections below. Record the live Ollama smoke result or the environment blocker. |
| 1 | Advisor contracts, catalog context, rules and local Ollama client | Backend tests prove catalog lookup, term labeling, credit handling, prerequisite checks, output validation and rules-only operation. |
| 2 | Generate semester | Open from any semester, preview up to three valid drafts, apply one in a single plan edit, and undo it. |
| 3 | Critique plan | Review all eight semesters, see evidence and tradeoffs, and preview and apply a verified reorder when available. |
| 4 | Find alternatives, Discover courses, Prerequisite roadmap, Advisor meeting brief | Each workflow meets its acceptance checks in §8. Add the Compare view for generation drafts. |

## 2. Existing code and baseline

- `backend/app/main.py` defines the `Course` model and `CsvCourseRepository`, and serves courses from `database/grinnell_spring_2027_courses.csv`. The file contains 395 rows, including distinct topics and repeat codes. Older README references to a 32-course mock are stale. Use `repository.list()` and the supplied CSV. Leave the CSV and the legacy mock JSON untouched.
- `frontend/src/plan.ts` defines Plan v1, `place`, `totalCredits`, and the eight semester IDs. `frontend/src/main.tsx` owns edits, undo, the shared dialog, and `fieldnotes-plan-v1` storage. `frontend/src/AiAdvisor.tsx` is the advisor placeholder. `frontend/vite.config.ts` already proxies `/api` to FastAPI. The backend already has `httpx`, FastAPI and Pydantic.
- Eight Python tests and four of five Vitest tests passed during planning. In `frontend/src/plan.test.ts`, the missing-course case at line 32 should expect `null`, consistent with `totalCredits` and the planner's “Credits unavailable” display. Keep the 1.5 + 0 and `null` credit assertions. In `frontend/tests/planner.spec.ts`, change the two unfiltered `385 courses` expectations to `395 courses`. Change the old `Coming later` assertion when phase 2 ships. The browser suite was inspected without a live browser run.
- Confirmed local Ollama manifests include `qwen3-vl:4b` and `qwen3-vl:4b-instruct`. The `4b` manifest digest matches Ollama's published thinking variant. Default to `qwen3-vl:4b`. The loopback call was blocked by the planning sandbox, so daemon availability, thinking behavior and latency need the live test in §9. [Ollama `qwen3-vl:4b`](https://ollama.com/library/qwen3-vl%3A4b) · [Ollama `qwen3-vl:4b-thinking`](https://ollama.com/library/qwen3-vl%3A4b-thinking)

## 3. Contracts and integration points

| File | Implementation |
| --- | --- |
| `backend/app/main.py` | Register the advisor router using an injected catalog provider. Add `X-Catalog-Revision` to the existing `GET /api/courses` response. Keep the course array and `/api/health` response shape. |
| `backend/app/advisor/schemas.py` | Strict Pydantic request, response, model-ranking and action schemas. |
| `backend/app/advisor/rules.py` | Catalog snapshot/indexes, semester math, credit totals, prerequisite evaluation, candidate eligibility and action simulation. |
| `backend/app/advisor/workflows.py` | Candidate and finding construction, Ollama ranking, response assembly and rules fallback. Split by workflow when phase 4 makes the file unwieldy. |
| `backend/app/advisor/ollama.py` | Async HTTP adapter, model capability probe, timeout, concurrent-call limit and normalized errors. |
| `backend/app/advisor/routes.py` | `GET /api/ai/status` and `POST /api/ai/advice`. Validate requests and map errors to stable response codes. |
| `frontend/src/advisorApi.ts` | Request and response types, runtime checks for the response and action fields, and a typed fetch function with `AbortSignal`. |
| `frontend/src/AiAdvisor.tsx` | Workflow forms, request lifecycle, evidence, result cards and preview. |
| `frontend/src/plan.ts`, `frontend/src/main.tsx`, `frontend/src/styles.css` | Safe batch apply, reuse of the planner's undo and storage, entry points, and drawer styling. |
| `backend/test_advisor*.py`, `frontend/src/plan.test.ts`, `frontend/tests/planner.spec.ts` | Rules and HTTP tests, plan-edit tests, and mocked-advisor browser flows. |

Make `revision` the SHA-256 hex digest of the JSON-serialized course records sorted by `id`. Include all `Course` fields and sort object keys. Compute the header from the same `repository.list()` result used for the body. Each advice request loads the list once and uses one in-memory snapshot throughout the request. Build `byId` and `byCode` indexes. `byCode` maps a normalized code to a list so topic rows stay distinct. Read the revision from the initial catalog fetch in `main.tsx` and keep it with `courses`.

### 3.1 Request

`POST /api/ai/advice` accepts this common shape. Use a Pydantic discriminated union by `action` and reject extra or wrongly typed fields. The frontend projects its Plan v1 into this shape and omits entry UUIDs, which the advisor never needs.

```json
{
  "action": "generate_semester",
  "catalogRevision": "<64 hex characters from X-Catalog-Revision>",
  "plan": {
    "version": 1,
    "startYear": 2026,
    "entries": [
      {"courseId": "csc-151", "semesterId": "semester-0"},
      {"courseId": "csc-161", "semesterId": "semester-1"}
    ]
  },
  "options": {
    "semesterId": "semester-1",
    "targetCredits": 16,
    "focusDepartments": ["MAT", "STA"],
    "goals": "Explore statistics and keep computer science options open.",
    "allowRequisiteReview": true
  }
}
```

- Use the same semester IDs and starting-year range (2000–2100) as `parsePlan`. Limit to 128 entries and course IDs of 1–120 characters. Reject duplicate course IDs and malformed semester IDs. Preserve unknown saved IDs as unresolved entries. Resolve submitted subject course IDs and department filters against the current catalog.
- `generate_semester` requires `semesterId`. Defaults: `targetCredits=16`, `focusDepartments=[]`, `goals=""`, `allowRequisiteReview=true`. `critique_plan` uses the same options except `semesterId` and `allowRequisiteReview`. The critique target is a planning reference for populated semesters. The generation target is a ceiling. Valid targets are 1–24 in half-credit increments. Accept up to five distinct department codes and 400 characters of trimmed goals. Empty goals are valid.
- Serialize only on explicit submission. The backend reads titles, prerequisites, descriptions and credits from the repository. It receives placements and the current form values from the browser. Keep forms, drafts and critique results in memory.

### 3.2 Response

Use camelCase consistently across the advisor API. Define these types in Pydantic and mirror them in TypeScript. All arrays shown below are present, including when empty. Generate IDs server-side within each result.

```ts
type SemesterId = `semester-${0|1|2|3|4|5|6|7}`;
type Action =
  | { kind: "add"; courseId: string; semesterId: SemesterId }
  | { kind: "move"; courseId: string; fromSemesterId: SemesterId; semesterId: SemesterId }
  | { kind: "replace"; courseId: string; replacementCourseId: string; semesterId: SemesterId };
type Availability = "listed_in_source_term" | "term_unverified";
type Evidence = { courseId: string; field: "prerequisites" | "system_requisites" |
  "catalog_notes" | "description"; excerpt: string };
type Finding = {
  id: string; code: string; severity: "attention" | "review" | "info";
  semesterId: SemesterId | null; courseIds: string[];
  title: string; detail: string; nextStep: string; evidence: Evidence[];
  proposalId: string | null;
};
type Proposal = {
  id: string; label: string; rationale: string; actions: Action[];
  totals: { semesterId: SemesterId; before: number | null; after: number | null }[];
  placements: {
    courseId: string; semesterId: SemesterId; availability: Availability;
    requisiteStatus: "no_issue_in_plan" | "needs_review"; evidence: Evidence[];
  }[];
  notices: string[];
};
type CourseSuggestion = {
  courseId: string; reason: string; availability: Availability | null;
  requisiteStatus: "no_issue_in_plan" | "sequence_gap" | "needs_review" | null;
  evidence: Evidence[]; proposalId: string | null;
};
type Advice = {
  action: string; catalogRevision: string; sourceTerms: string[];
  mode: "model" | "rules";
  reason: "model_unavailable" | "model_timeout" | "model_busy" |
          "invalid_model_output" | "model_disabled" | "model_not_needed" | null;
  summary: string; proposals: Proposal[]; findings: Finding[];
  suggestions: CourseSuggestion[];
  semesterStats: { semesterId: SemesterId; courseCount: number; credits: number | null }[];
};
```

Join course references to the loaded catalog for code and title. Evidence excerpts come directly from the named field, with whitespace normalized and the first 240 characters at most. An unknown saved course ID may appear in `findings.courseIds` with a clear unavailable label and no evidence. All proposal and suggestion IDs must resolve. Populate a proposal's `placements` with the resulting placements of added, moved or replacement courses. Include any other affected requisite warning in the proposal's `notices`, identifying the exact course and source. Reserve `reason=null` for model mode.

- `GET /api/ai/status` returns HTTP 200 with `{state: "ready" | "offline" | "model_missing" | "disabled", model: string, thinking: boolean | null}`. `thinking=null` means capability metadata is unavailable. Probe on first advisor open and use `?refresh=true` on **Check connection** to bypass the capability cache. An unavailable model leaves the workflows usable in rules mode.
- Invalid request shape returns 422. A changed catalog revision returns 409 with `detail.code="catalog_changed"`. The client refetches `/api/courses`, invalidates the draft, and offers **Run again**. A failed catalog read returns 503 with `detail.code="catalog_unavailable"`. A usable rules result is HTTP 200 even when Ollama failed. Return `model_not_needed` when there is nothing to rank and omit the offline message in that case.

## 4. Catalog rules shared by every workflow

1. **Term.** Reproduce `semesterLabel` on the server. For index `i`, fall is `startYear + floor(i/2)` for even `i`, and spring is `startYear + floor(i/2) + 1` for odd `i`. Compare the exact computed term with each course's `source_term`. Show “Listed in Spring 2027 catalog” for matching rows and “Offering unverified for Fall 2027” or the corresponding selected term for other placements. A term mismatch lowers certainty but permits a planning draft. Never infer seat counts, meeting conflicts, frequency of offerings, registration eligibility or degree completion from this CSV.
2. **Credits.** Use decimal arithmetic from `str(course.credits)` on the server. Preserve fixed `0` and fractional values. A missing course or `credits=null` makes the affected semester total `null`. Preserve `credit_display` for course rows, and never substitute the lower bound of a range or zero. Empty semesters total 0. For exact-budget proposals, hold back any plan with unknown affected credit totals.
3. **Prerequisites.** Return `no_issue_in_plan`, `sequence_gap` or `needs_review`. Earlier planned work is evidence of sequence only. A gap is evidence of what is missing from this plan, which may omit transfer credit, placement or completed work. Evaluate relative to semester index, without assuming enrollment or grades.
4. **Deterministic rule coverage for the first release.** If both requisite fields explicitly say `None` and notes are empty, return no known rule. If either field is missing, notes are nonempty, or the data is ambiguous, default to `needs_review`. Implement the exact structured rules below using stable course IDs. Store each supported row's expected pair of requisite strings from the CSV beside its rule. If either string changes or a note is added, return `needs_review` and show the current source. Leave remaining prose, grade thresholds, permissions, standing, transfer and unresolved cross-listed references for manual review. Do not use the model to approve any of them. The supported list can expand only with source-backed fixtures.

| Course | Supported rule | Acceptance case |
| --- | --- | --- |
| `csc-161` | `csc-151` in a strictly earlier term | Same-term `csc-151` flags a gap. |
| `csc-207` | Both `csc-151` and `csc-161` strictly earlier | Seeing `csc-161` in a later term provides reorder evidence. |
| `mat-133` | A planned `MAT 124` or `MAT 131` strictly earlier | `MAT 124` is absent from the current snapshot. Preserve the source alternative in evidence and never invent an ID. A planned `mat-131` satisfies this modeled rule. |
| `mat-215` | `mat-133` strictly earlier | A later or same-term `mat-133` flags a gap. |
| `chm-129` | `chm-129l` in the same term | A proposed pair adds both rows for exactly 4 credits. The lab on its own is unavailable as an AI suggestion. A lab already planned in a different term blocks the add bundle. |

5. **Identity and simulation.** Mutations use exact `courseId`. Eligibility excludes a course ID already anywhere in the plan. AI placement also avoids introducing a second row of the same displayed code, because repeatability is unverified. Existing duplicate-code topics remain intact and readable. A same-code topic swap may be offered when there is no other row of that code in the simulated plan. Evaluate atomic proposals against the complete proposed plan. Recheck the changed courses and every supported planned course whose requisite depends on them. Track failed predicates by dependent course and rule clause, with an OR group treated as one predicate. Reject any newly failed predicate, and require the intended predicate to become satisfied for a proposed repair. Present unresolved checks for affected courses as review notes. An add or replacement workflow can impose stricter rules.
6. **Evidence-only generation.** Keep course facts, numerical totals, availability, and edit actions out of the model's output schema. UI evidence and warnings always come from the rules or the actual CSV. Render model-derived ordering and deterministic explanations as ordinary React text.

## 5. Local Qwen adapter and selection

Use an `httpx.AsyncClient` created in FastAPI lifespan and close it on shutdown. Allow one active model request per backend process. If a second request arrives while Qwen is busy, return rules mode immediately. Use two seconds for connection and probe timeouts, five minutes for `keep_alive`, `trust_env=False`, and `follow_redirects=False`. `FIELDNOTES_OLLAMA_URL` defaults to `http://127.0.0.1:11434`. Accept only a loopback HTTP origin without credentials, path, query or fragment. `FIELDNOTES_OLLAMA_MODEL` defaults to `qwen3-vl:4b`. `FIELDNOTES_AI_ENABLED=0` skips model calls and still exposes rules results. `start.sh` must continue starting when Ollama is closed. Document how to open Ollama or run `ollama serve` separately and use models installed by the operator. [Ollama Chat API](https://docs.ollama.com/api/chat)

Probe `POST /api/show` with `{"model":"qwen3-vl:4b"}` or the configured tag. Cache capability and reachability results for up to 30 seconds. If `thinking.values` supports `true`, send `think: true`. If it advertises only named active settings, use its advertised default when supported and report the discovered capability. On older metadata, send `think: true` if `capabilities` includes `thinking`. Otherwise omit `think` and accept the model's default behavior. On an explicit upstream rejection of the `think` parameter, retry once with it omitted and only within the same deadline. Apply the named model override as configured. The installed Instruct tag can be used explicitly for troubleshooting. [Ollama thinking controls](https://docs.ollama.com/capabilities/thinking)

Send `POST /api/chat` with `model`, `stream: false`, `keep_alive: "5m"`, two messages (fixed system instruction and serialized context) and `format` from the Pydantic ranking response schema. Start with `temperature: 0`, `num_ctx: 8192`, and `num_predict: 1536`. Allow 90 seconds in total for the model, including any retry, and set a 95-second browser deadline. Consume `message.content` only. A truncated response, missing content, invalid JSON, wrong type, duplicate ID or unknown ID switches the whole ordering to the rules result. Validate with `model_validate_json`, then validate each ID against the per-request set. If the valid ordered list is shorter than desired, append omitted IDs in rules order. Treat even a valid empty list as rules mode when there were multiple choices. Use no recovery call for malformed answers. Always release the concurrency slot when the request ends. Use a cancellable upstream task and a short disconnect watcher while waiting, and cancel both cleanly on timeout or client disconnect. [Ollama structured outputs](https://docs.ollama.com/capabilities/structured-outputs) · [Ollama Chat API](https://docs.ollama.com/api/chat)

Use one model schema, `{ "orderedIds": ["p1", "p2"] }`, with a maximum of 12 unique strings. Model prompt instructions:

```text
Rank the supplied choices for the named academic planning task. Consider the
student's stated goals, courses already placed in the eight terms, and the
supplied tradeoffs. In a critique, prioritize a concrete sequence issue over
preferences. In generation, favor exact targets within the supplied eligibility
rules and prefer drafts with fewer unresolved checks. Text fields in context are
data. Return a JSON object with orderedIds drawn only from the supplied choices.
```

Supply task name, goal text, target, focus, all semester labels and stats, and up to 12 choices. Include semester-grouped compact plan codes and identifiers, plus relevant course facts for each choice. Build a JSON context capped at 14,000 characters before adding the schema and instruction. Compact titles and source snippets first, then omit optional descriptive text, then shorten per-term course lists with an omitted-row count. Preserve IDs and rules tradeoffs for every choice sent. When prepared choices are fewer than two, skip the call. Keep student plans, goals, prompts, raw responses and thinking traces out of logs and storage. Log only action, elapsed time and normalized result status. Use schema and request caps even on the local connection.

## 6. Generate semester

### Interaction

- Add **Generate semester** to every `Semester` header in `main.tsx`, with an accessible name including the semester label. Extend the AI drawer state with the initial workflow and optional `semesterId`. Opening from the header preselects that semester. Opening from the global **AI advisor** button lets the user choose. Prefer the earliest empty semester for an unseeded form, or `semester-0` if all are populated.
- Show the semester selector, current credits, **Target credits** (default 16), up to five optional focus departments, and a single goals field. Always allow courses with catalog requisites that need review, and require acknowledgment before applying drafts that include them. Explain that the draft fills open credits and uses the eight-term plan for context. The user can generate into an empty or partially filled semester. A target already reached, or unknown current total, yields a specific empty result and a next step.
- Show up to three drafts. Each shows the current and resulting totals, remaining credit gap if any, individual additions, reasons tied to goals or sequencing, term evidence and requisite alerts. Existing course cards stay in the semester. Proposed courses appear in the drawer preview until **Add courses** is clicked. A draft with `needs_review` requires a checkbox acknowledgment in its preview. Reset the acknowledgment when proposal or input changes.

### Construction

1. Calculate `remaining = targetCredits - currentCredits`. For each unplanned catalog row, test fixed positive credits, no already-planned identical ID or same code, known prerequisite ordering, and fit within `remaining`. Include any mandatory same-term companion as part of the candidate, unless already placed in the selected semester. Do not select zero-credit courses as standalone additions. Exclude a candidate with an unfulfillable known rule. With review enabled, retain courses with unmodeled requisites and attach the raw catalog evidence to their preview placements. When there are no eligible additions, explain the relevant constraint and show the remaining credits. The empty beam state is never a proposed draft.
2. Score candidates from three perspectives. All three use `+1` per distinct goal token matched in code, title or description, capped at `+5` per anchor, and `-6` per anchor with a requisite review. Tokenize case-insensitively on nonalphanumeric boundaries and ignore tokens shorter than three characters. **Balanced** adds `+3` per anchor in a focus department and `+2` per anchor in a department already represented in the plan. **Focus** uses `+5` and `+2` for those same signals. **Breadth** adds `+2` per anchor in a department absent from the plan and `+2` for each distinct anchor department after the first in a draft. All three add `+8` per supported later course whose sequence gap the draft resolves. For the early search, precompute which later courses each candidate could help and use the union of those IDs as the estimated bonus. Score the real improvement on finalists. Keep eligible courses outside the selected departments in the pool so they can fill the semester.
3. Search the top 60 anchors per perspective plus the two highest-scoring candidates for each available fixed credit value. Use a stable beam of 24 states per `(addedCredits, anchorCount)` bucket, up to six anchors. Iterate candidates in stable score/ID order. Each step expands from the previous states only. Track IDs and codes to prevent duplicates and deduplicate states by sorted course IDs. A companion counts toward credits and actions without consuming an anchor. Evaluate the before and after rule states and count each improved later course once per draft for the unlock bonus. Re-evaluate the full plan for each finalist. Order first by smallest remaining-credit gap, then by perspective score, then by stable sorted IDs. Keep up to four distinct finalists per perspective and at most 12 overall. Surface a partial draft with its numerical gap when there is no exact draft in the filtered search.
4. Pass the finalists and compact context to Qwen. Keep up to three distinct drafts. If any exact draft is available, the first displayed draft must be exact. Avoid repeating labels in the visible list by using **Balanced**, **Focus**, **Breadth** when unique, with **Draft 1**, **Draft 2**, **Draft 3** as the neutral fallback. Rationale templates report actual stats such as “Adds two MAT courses and places MAT 133 before planned MAT 215.” Report an improved sequence only after comparing the rule states. Preserve actual course and companion order on apply, using the anchor followed by its companion and appending after existing entries.

## 7. Critique plan

Open **Critique plan** from the global advisor and the plan toolbar. Accept an optional goals field, focus departments and reference credit target. Show a compact semester overview with counts and known credits, followed by findings with affected terms, courses, excerpts and one concrete next step. Leave goals blank by default. If the plan is empty, show a build-plan prompt with **Generate semester**. Critique drafts and empty-result pages require no model call when there is nothing to rank.

| Finding code | When to emit | Next step |
| --- | --- | --- |
| `sequence_gap` | A supported prior-term rule fails | Identify the needed course or alternatives from the rule, show the source, and show the conflicting placement if present. |
| `corequisite_gap` | A supported same-term rule fails | Show the associated lab or other course and the term it must share. |
| `requisite_review` | Requisite text is unmodeled, incomplete or conflicting | Show relevant source excerpts and what the student should verify. |
| `unavailable_course` / `unknown_credits` | A saved ID is missing or a course has nonnumeric credits | Retain the row and state which credit total is unavailable. Group multiple affected courses under the same semester and code. |
| `credit_above_target` / `credit_below_target` | A populated semester's known total is at least 2 credits above or below the selected target | Report the difference. For low totals, link to generation for that term. Call this a credit-load signal. |
| `empty_between_terms` | An empty semester lies between the first and last populated semester | Ask whether the gap is intentional. Omit leading and trailing empty semesters. |
| `offering_unverified` | A planned course is placed outside its source term | Group by semester and show the term of the CSV snapshot. |
| `focus_distribution` | Focus departments were selected and the plan has at least three catalog-resolved courses | Report how many placements are in the selected departments. Offer exploration or a reorder only when supported by actual choices. |

Order severity groups `attention`, `review`, `info`. Sequence and corequisite gaps are `attention`. Unknown IDs, credits and requisites are `review`. Term coverage, credit variance, plan gaps and preferences are `info`. Within a severity group, default to table order, earlier term, then course ID. Give Qwen up to the first 12 findings and allow reordering within each severity group. Always include every finding, keeping omitted IDs in rules order. Show the first six by default and an expandable list for the rest. Include a positive observation only when the rules have a specific example, such as CSC 151 before CSC 161. A plan with no emitted findings still shows catalog scope and the semester overview.

**Propose small, checkable fixes.** For each modeled gap where the affected or required course already exists in the plan, simulate moving one exact course to each other semester. Include a corequisite pair only through a candidate single move that places the courses together. Consider only moves that fix the intended gap, create no new supported gap, preserve known affected totals, and do not increase the recipient's overload relative to the selected target. Rank by listed source-term placement, shortest distance, smallest aggregate deviation from the target across both terms, then stable ID. Attach at most one repair per finding and five total. If a prerequisite is entirely absent, or multiple changes are required, give a manual next step with evidence. Click **Preview move** before **Apply move**. Show before and after credits and any unverified offering or unresolved check in both affected terms.

## 8. Follow-on workflows

Use the same response in §3. Populate `suggestions` when the workflow lists courses and `findings` when it lists issues or advisor questions. The provider ranks eligible rows or existing questions. Keep the same preview and undo path for the workflows that write edits.

| Action and entry point | Inputs and implementation | Acceptance check |
| --- | --- | --- |
| `find_alternatives`, **Find alternatives** on a planned course detail | Require `courseId` and its current `semesterId`, optional goals and focus departments. Evaluate each replacement against the original plan and the complete simulated plan. Require the same fixed credits, a known affected semester total, no new supported gap and no unresolved requisite check for the replacement. Use the standard term label and favor source-term confirmation. Consider single-row replacements only and exclude known companion roles on either side. Prefer same department, then matching focus, then the goal-token score. Qwen ranks up to 12. Show at most five with **Preview replacement**. | A 4-credit replacement keeps the affected term total constant. Replacing an earlier CSC 151 when CSC 161 depends on it is blocked if the replacement fails that rule. Undo restores the original course and card position. |
| `discover_courses`, **Discover courses** in the drawer | Require nonblank goals or one focus department. Accept an optional `semesterId`. Score every row by §6 goal-token matches plus `+5` for focus, and break ties by source-term match when a term was selected, then course ID. The shortlist takes matches on at least one goal token or a focus department. When neither yields matches, give Qwen up to 12 unplanned 100-level rows, one per department, sorted by source-term match, department and ID. Label that list as broad exploration. For a selected term add availability and requisite status. Include exploratory rows with variable credits, manual requirements, or an existing placement, clearly labeled. Show up to five suggestions with descriptions and an **Open course details** action. | An interdisciplinary request can surface more than one department. Suggestions link to exact IDs even when two rows share a code. Opening a course never changes the plan. |
| `prerequisite_roadmap`, **Explore prerequisites** on a course detail | Require `courseId`. Accept an optional `semesterId`. Walk modeled prerequisites to depth three with a visited-ID path guard. Preserve OR semantics in separate branches and same-term requirements in their own node. Show each step as already earlier in plan, same term required, planned later, missing from plan, or needing source confirmation. Treat an unknown alternate such as MAT 124 as plain evidence. Qwen can prioritize branches or questions. The rules determine which prerequisites are linked. Use `findings` for the ordered steps. This is a read-only workflow. | `csc-207` shows the CSC 151 and CSC 161 chain. `chm-129` shows its same-term lab. A conflict note yields a verification step. |
| `advisor_brief`, **Prepare for advising** in the drawer | Accept goals, focus departments and target. Reuse the eight semester stats and critique findings. Use issue-specific question templates, for example “Can I take [course] before [prerequisite] based on work already completed?” Qwen prioritizes up to five questions. Render a copyable plain-text brief with goals, course/credit summary, term coverage, questions and selected evidence. Use `navigator.clipboard.writeText`, with a selectable-text fallback. | A brief preserves `Credits unavailable`, cites the CSV term, and includes a specific question when a conflict exists. Copy and generation leave the plan intact. |

Add **Compare drafts** to `generate_semester` after the core workflows ship. Choose any two available drafts using native controls. Build the comparison locally from the two validated proposals. Show courses unique to each, shared courses, projected credits, target gap, focus departments, and review counts. Keep the standard apply confirmation for the chosen draft. With one draft available, hide Compare.

Possible later work depends on additional data. Timetable and section conflict checks need term-specific sections with meeting times. Degree progress needs maintained, year-specific requirements and verified completed or transferred credits. Multi-semester generation can reuse the current workflow after the planner can distinguish completed terms and let students pin courses for multi-term previews.

## 9. UI state, applying drafts, and verification

### UI and persistence

- Reuse the native `dialog`, drawer heading ID, focus return and Escape behavior. Set focus to the first relevant field when opening a seeded form. When switching from advisor to course detail inside the open dialog, keep the original outside trigger for final focus restoration. Remove the “Coming later” UI and the topbar placeholder dot. Use the existing dark theme, 430px drawer and mobile sizing. Use stacked result cards and real buttons. Keep loading and completion messages in a polite live region and failures in an alert. Use a static “Reviewing your plan…” label with **Cancel** and allow reduced motion.
- Track `idle`, `loading`, `success`, `empty` and `error`. During a request, disable repeated submission but allow cancellation or closing. Aborting on close, mode/field changes, catalog revision changes, or a plan change must also increment a request token so stale responses cannot render. Retain form values on retry. If API connectivity prevents any response, show retry without touching the plan. If rules mode was caused by a provider error, label it “Catalog-based suggestions. Local AI is unavailable.” Show model status and retry in the drawer.
- Capture the exact Plan object, catalog revision and options used for the advice. On confirmation, refetch `/api/courses` with `cache: "no-store"`. On a mismatch, load the new catalog, invalidate the result and offer **Run again**. If the response or revision cannot be verified, leave the plan alone and offer **Retry**. Check generation actions are a nonempty list of adds to the selected semester and do not exceed its target. Critique requires one move with an exact current source semester. Alternatives require one replacement for the selected course in its current term with the same fixed credits. Check exact known IDs, valid terms, uniqueness and the displayed before/after totals using the refreshed catalog. Require the full batch to pass before creating the resulting Plan. Preserve plan and undo history when any check fails.
- Guard the edit at commit time, because catalog revalidation is async. Move plan and history into one state reducer (or an equivalent single functional state update). Keep the existing `edit(next)` entry point for manual callers, dispatching a guarded change with `basis` and `next`. For advisor apply, compute the full `next` outside the reducer, then commit only if the state still references `basis`. Production `place()` allocates an entry ID, so keep it outside the reducer and reuse it for add/move. For a one-row replacement, replace the matched array item in place with a new entry UUID and course ID. A successful batch is one history item and yields the same localStorage effect as manual edits. Disable Apply while checking or committing. Clear the result and announce success only on a confirmed commit. A stale or duplicate apply prompts the user to rerun. Keep undo's 40-item bound and preserve the storage recovery path.

### Automated checks

- **Python rules.** Test empty, partial and full semesters, including a partial draft with a displayed gap. Cover 0.5 credits, a zero-credit chemistry companion, credit ranges and legacy IDs. Test stable duplicate-topic identity, changed `startYear`, prior-term and same-term rules, OR rules and unresolved notes. Check duplicate prevention across the plan, rejection of moves that introduce a dependent gap and stable ranking after shuffling the catalog.
- **Python API.** Test strict schemas, invalid targets, years, semesters and duplicate IDs, and a catalog revision change between requests. Use `httpx.MockTransport` or a fake adapter to test unknown and duplicate IDs, wrong shape, truncation, invalid JSON, missing content, timeouts, offline, busy and disabled scenarios. Assert that each case yields the expected fallback and that the response contains only the documented fields. Include goal text that asks for invented courses and assert that only validated proposals come back.
- **Vitest:** guarded batch apply with mocked IDs, whole-batch rejection on unknown IDs, no mutation of input, stale-plan rejection, correct replace index, and one-step undo. Retain current `totalCredits` null semantics.
- **Playwright:** mock `/api/ai/status` and `/api/ai/advice`. Use real `/api/courses` and set mocked advice `catalogRevision` from its response header. Cover a semester-trigger preselect, partial-plan preview with no edit, add and reload, atomic undo, critique ordering and move preview, canceled request and late response, rules fallback, and refetch returning changed revision on Apply. Check keyboard-only flow, focus restoration and 390px drawer overflow. Keep existing drag/drop, storage and course detail tests passing.

Use these end-to-end fixtures for the first release. The deterministic rules test for chemistry can use a reduced fixture with just these four exact catalog IDs. For the browser test, serve the usual catalog and mock the advisor result.

| Scenario | Start state | Assert |
| --- | --- | --- |
| Fill a partial semester | Start year 2026. `csc-151` in `semester-0`, `csc-161` in `semester-1`. Generate for `semester-1` with CHM focus and target 8. | A valid draft can add `chm-129` and `chm-129l` for 4 + 0 credits, bringing Spring 2027 from 4 to 8. Applying leaves CSC 161 in place. Undo removes both new rows together. |
| Critique a reversed sequence | `csc-161` in `semester-0`, `csc-151` in `semester-1`, reference target 16. | The attention finding quotes the CSC 151 prior-course requisite. With a snapshot consisting of the current Spring 2027 catalog, the best valid move places CSC 161 in `semester-2` and shows an unverified Fall 2027 offering. Applying changes one placement; Undo restores the reversal. |
| Refuse a stale draft | Show a generated draft, then have `/api/courses` return a different revision on Apply. | The draft is invalidated, the user sees **Run again**, and localStorage and undo are unaffected. |

Run from the workspace root. Run Playwright after starting `./start.sh` in another terminal.

```sh
(cd backend && .venv/bin/python -m pytest -q)
(cd frontend && PATH="$PWD/../.tools/node/bin:$PATH" npm test)
(cd frontend && PATH="$PWD/../.tools/node/bin:$PATH" npm run build)
(cd frontend && PATH="$PWD/../.tools/node/bin:$PATH" \
  PLAYWRIGHT_BROWSERS_PATH="$PWD/../.tools/browsers" npm run test:e2e)
```

### Live smoke and release gate

1. With Ollama running, run `ollama list` and `curl --fail --json '{"model":"qwen3-vl:4b"}' http://127.0.0.1:11434/api/show`. Confirm the tag and supported thinking control. In `POST /api/chat`, send a tiny structured prompt that asks for `{"orderedIds":["p1"]}` with an object schema, using the probed `think` setting. Confirm Pydantic accepts `message.content` and the response is complete. Use the configured tag if it differs. Record the actual tag, Ollama version, cold/warm response time, and whether structured output worked with thinking enabled. Tune `num_predict` within the same timeout if valid content is being truncated. [Ollama structured outputs](https://docs.ollama.com/capabilities/structured-outputs) · [Ollama thinking controls](https://docs.ollama.com/capabilities/thinking)
2. Start Fieldnotes. With Fall 2026 CSC 151 already placed, generate for Spring 2027 using a CSC focus and inspect where CSC 161 ranks when eligible. Verify the payload has `mode: "model"` when multiple candidates exist, the preview keeps existing placements, and one Undo removes the whole applied draft. Repeat for a term outside Spring 2027 and check the unverified offering label.
3. Create an intentional gap with CSC 161 before CSC 151. Run **Critique plan**, inspect the actual requisite excerpt, and preview a repair. Stop Ollama and rerun both workflows. Confirm rules results remain actionable and manual planning still works.
4. Update `README.md` with current CSV data, advisor workflows, model configuration, commands, and only test results actually run. Record live smoke as pending if local loopback is unavailable in the implementation environment. A mocked suite alone cannot verify real Qwen integration.

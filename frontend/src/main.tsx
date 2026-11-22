import React, { useEffect, useId, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  KeyboardSensor,
  useSensor,
  useSensors,
  useDraggable,
  useDroppable,
  closestCenter,
  pointerWithin,
} from "@dnd-kit/core";
import type { DragStartEvent, DragEndEvent } from "@dnd-kit/core";
import {
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
  sortableKeyboardCoordinates,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  BookOpen,
  Search,
  Plus,
  X,
  GripVertical,
  Undo2,
  PanelLeftClose,
  PanelLeftOpen,
  ChevronDown,
  Check,
  CalendarDays,
  Leaf,
  ChevronRight,
  Trash2,
  CircleAlert,
} from "lucide-react";
import "@fontsource/source-sans-3/400.css";
import "@fontsource/source-sans-3/500.css";
import "@fontsource/source-sans-3/600.css";
import "@fontsource/literata/400.css";
import "./styles.css";
import { AiAdvisor } from "./AiAdvisor";
import advisorSquirrel from "./advisor-squirrel.webp";
import { fetchCatalog } from "./advisorApi";
import type { AdviceAction, Proposal } from "./advisorApi";
import {
  emptyPlan,
  examplePlan,
  parsePlan,
  place,
  semesterLabel,
  semesters,
  totalCredits,
} from "./plan";
import type { Course, Entry, Plan } from "./plan";
import { planRequisiteWarnings } from "./requisites";
const STORAGE = "fieldnotes-plan-v1";
type Drawer = { kind: "ai"; semesterId?: string; action?: AdviceAction; courseId?: string } | { kind: "course"; course: Course } | null;
function loadInitial() {
  try {
    const raw = localStorage.getItem(STORAGE);
    return { plan: raw ? parsePlan(raw) : emptyPlan(), error: "" };
  } catch {
    return {
      plan: emptyPlan(),
      error:
        "Your saved plan could not be read. Changes will not overwrite it until you choose Start fresh.",
    };
  }
}
function courseTone(course: Course) {
  return ["CSC", "MAT", "STA", "BIO", "CHM", "PHY", "PSY"].some((d) =>
    course.code.startsWith(d),
  )
    ? "science"
    : ["ECN", "SOC", "ANT", "HIS"].some((d) => course.code.startsWith(d))
      ? "society"
      : "arts";
}
function CourseFace({
  course,
  compact = false,
  warning,
}: {
  course: Course;
  compact?: boolean;
  warning?: string;
}) {
  return (
    <>
      <div className="course-meta">
        <span className="course-identity">
          <span className={`course-code ${courseTone(course)}`}>
            {course.code}
          </span>
          {warning && (
            <span className="requisite-icon" title={warning} aria-hidden="true">
              <CircleAlert size={15} />
            </span>
          )}
        </span>
        <span>
          {course.credit_display ? `${course.credit_display} ${compact ? "cr" : "credits"}` : course.credits == null ? "Credits unavailable" : `${course.credits} ${compact ? "cr" : "credits"}`}
        </span>
      </div>
      <div className="course-title">{course.title}</div>
    </>
  );
}
function CatalogCard({
  course,
  planned,
  onDetail,
  onAdd,
}: {
  course: Course;
  planned?: string;
  onDetail: () => void;
  onAdd: () => void;
}) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: `catalog-${course.id}`,
    data: { courseId: course.id },
    disabled: !!planned,
  });
  return (
    <article
      ref={setNodeRef}
      className={`catalog-card ${isDragging ? "dragging" : ""}`}
      data-testid={`catalog-${course.id}`}
    >
      <div className="catalog-card-content">
        <button className="card-main" onClick={onDetail}>
          <CourseFace course={course} />
        </button>
        <button
          className="drag-handle catalog-grip"
          {...listeners}
          {...attributes}
          disabled={!!planned}
          aria-label={`Drag ${course.code}`}
        >
          <GripVertical size={16} />
        </button>
      </div>
      <div className="catalog-card-bottom">
        {planned ? (
          <span className="planned-label">
            <Check size={13} />
            {planned}
          </span>
        ) : (
          <span className="catalog-dept">{course.department}</span>
        )}
        <button
          className="add-course"
          aria-label={`${planned ? "View" : "Add"} ${course.code}`}
          onClick={planned ? onDetail : onAdd}
        >
          {planned ? <ChevronRight size={16} /> : <Plus size={17} />}
        </button>
      </div>
    </article>
  );
}
function PlannedCard({
  entry,
  course,
  warnings,
  onDetail,
  onRemove,
}: {
  entry: Entry;
  course?: Course;
  warnings?: string[];
  onDetail: () => void;
  onRemove: () => void;
}) {
  const warningId = useId();
  const warning = warnings?.length ? `Check course requisites. ${warnings.join(". ")}.` : undefined;
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({
    id: entry.id,
    data: { courseId: entry.courseId, semesterId: entry.semesterId },
  });
  return (
    <article
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={`planned-card ${isDragging ? "dragging" : ""}`}
      data-testid={`planned-${entry.courseId}`}
    >
      <button
        className="drag-handle"
        {...attributes}
        {...listeners}
        aria-label={`Move ${course?.code ?? entry.courseId}`}
      >
        <GripVertical size={17} />
      </button>
      <button className="card-main" onClick={onDetail} aria-describedby={warning ? warningId : undefined}>
        {course ? (
          <CourseFace course={course} compact warning={warning} />
        ) : (
          <span>Not in this catalog: {entry.courseId}</span>
        )}
      </button>
      {warning && <span id={warningId} hidden>{warning}</span>}
      <button
        className="icon-button planned-remove"
        aria-label={`Remove ${course?.code ?? entry.courseId} from plan`}
        title="Remove from plan"
        onClick={onRemove}
      >
        <Trash2 size={16} />
      </button>
    </article>
  );
}
function Semester({
  id,
  plan,
  courses,
  warnings,
  onBrowse,
  onGenerate,
  onDetail,
  onRemove,
}: {
  id: string;
  plan: Plan;
  courses: Course[];
  warnings: ReadonlyMap<string, string[]>;
  onBrowse: () => void;
  onGenerate: () => void;
  onDetail: (course: Course) => void;
  onRemove: (entry: Entry) => void;
}) {
  const entries = plan.entries.filter((e) => e.semesterId === id);
  const { setNodeRef, isOver } = useDroppable({ id, data: { semesterId: id } });
  return (
    <section
      ref={setNodeRef}
      className={`semester ${isOver ? "drop-active" : ""}`}
      data-testid={id}
      aria-label={semesterLabel(id, plan.startYear)}
    >
      <header className="semester-header">
        <h3>{semesterLabel(id, plan.startYear)}</h3>
        <div><span>{totalCredits(entries, courses) == null ? "Credits unavailable" : `${totalCredits(entries, courses)} credits`}</span><button className="semester-ai" aria-label={`Generate semester for ${semesterLabel(id, plan.startYear)}`} onClick={onGenerate}>Generate semester</button></div>
      </header>
      <div className="semester-body">
        <SortableContext
          items={entries.map((e) => e.id)}
          strategy={verticalListSortingStrategy}
        >
          {entries.map((entry) => (
            <PlannedCard
              key={entry.id}
              entry={entry}
              onRemove={() => onRemove(entry)}
              course={courses.find((c) => c.id === entry.courseId)}
              warnings={warnings.get(entry.courseId)}
              onDetail={() => {
                const c = courses.find((c) => c.id === entry.courseId);
                if (c) onDetail(c);
              }}
            />
          ))}
        </SortableContext>
        {entries.length === 0 ? (
          <button className="empty-semester" onClick={onBrowse}>
            <Plus size={19} />
            <span>Room to explore</span>
            <small>Drop a course here or browse courses</small>
          </button>
        ) : (
          <button className="semester-add" onClick={onBrowse}>
            <Plus size={15} />
            Add a course
          </button>
        )}
      </div>
    </section>
  );
}
function App() {
  const [initial] = useState(loadInitial);
  const [plan, setPlan] = useState(initial.plan);
  const [history, setHistory] = useState<Plan[]>([]);
  const [storageBlocked, setStorageBlocked] = useState(!!initial.error);
  const [saveState, setSaveState] = useState("");
  const [notice, setNotice] = useState(initial.error);
  const [courses, setCourses] = useState<Course[]>([]);
  const [catalogRevision, setCatalogRevision] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  const retryCatalog = () => setRetry((n) => n + 1);
  const planRef = useRef(plan);
  planRef.current = plan;
  const [query, setQuery] = useState("");
  const [department, setDepartment] = useState("");
  const [level, setLevel] = useState("");
  const [sidebar, setSidebar] = useState(() => window.innerWidth >= 1100);
  const [drawer, setDrawer] = useState<Drawer>(null);
  const [activeCourse, setActiveCourse] = useState<Course | null>(null);
  const [target, setTarget] = useState(semesters[0]);
  const [confirmation, setConfirmation] = useState<"example" | "clear" | null>(null);
  const confirmationTrigger = useRef<HTMLButtonElement>(null);
  const undoButton = useRef<HTMLButtonElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError("");
    fetchCatalog(controller.signal)
      .then(({courses: rows, revision}) => {setCourses(rows);setCatalogRevision(revision)})
      .catch((e) => {
        if (e.name !== "AbortError")
          setError(
            "Courses could not load. Check the output from ./start.sh, then retry.",
          );
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [retry]);
  useEffect(() => {
    if (storageBlocked) {
      setSaveState("Not saved");
      return;
    }
    try {
      localStorage.setItem(STORAGE, JSON.stringify(plan));
      setSaveState("Saved on this device");
    } catch {
      setSaveState("Not saved");
      setNotice(
        "Device storage is unavailable. Your plan will last only for this session.",
      );
    }
  }, [plan, storageBlocked]);
  useEffect(() => {
    if (drawer) {
      if (!dialogRef.current?.open) returnFocus.current = document.activeElement as HTMLElement;
      dialogRef.current?.showModal();
    } else {
      dialogRef.current?.close();
      returnFocus.current?.focus();
    }
  }, [drawer]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape")
        setSidebar((s) => (window.innerWidth < 1100 ? false : s));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  useEffect(() => {
    const media = window.matchMedia("(min-width: 1100px)");
    const sync = () => setSidebar(media.matches);
    media.addEventListener("change", sync);
    return () => media.removeEventListener("change", sync);
  }, []);
  const departments = useMemo(
    () => [...new Set(courses.map((c) => c.department))].sort(),
    [courses],
  );
  const filtered = courses.filter(
    (c) =>
      (!department || c.department === department) &&
      (!level || c.level === Number(level)) &&
      `${c.code} ${c.title}`.toLowerCase().replaceAll("-", " ").includes(query.toLowerCase().replaceAll("-", " ")),
  );
  const edit = (next: Plan) => {
    if (JSON.stringify(next) === JSON.stringify(plan)) return;
    setConfirmation(null);
    setHistory((h) => [...h.slice(-39), plan]);
    setPlan(next);
  };
  const applyAdvisorProposal = async (proposal: Proposal, basis: Plan, targetCredits: number, signal: AbortSignal): Promise<string> => {
    let fresh;
    try { fresh = await fetchCatalog(signal); }
    catch { return "The catalog could not be verified. Your plan was left unchanged. Retry after reconnecting."; }
    if (signal.aborted) return "Request canceled.";
    if (fresh.revision !== catalogRevision) {
      setCourses(fresh.courses); setCatalogRevision(fresh.revision);
      return "The catalog changed. This draft was cleared; Run again with the refreshed catalog.";
    }
    if (planRef.current !== basis) return "Your plan changed while this draft was open. Run the advisor again before applying it.";
    if (!proposal.actions.length) return "This draft contains no edits. Your plan was left unchanged.";
    let next=basis;
    if (proposal.actions.every(a=>a.kind==="add")) {
      const catalog=new Map(fresh.courses.map(course=>[course.id,course]));
      const ids=new Set(basis.entries.map(e=>e.courseId));
      const codes=new Set(basis.entries.map(e=>catalog.get(e.courseId)?.code).filter(Boolean));
      const affected=new Set(proposal.actions.map(a=>a.semesterId));
      for (const action of proposal.actions) {
        const course=catalog.get(action.courseId);
        if (!course || ids.has(course.id) || codes.has(course.code)) return "A course in this draft is missing or already planned. Run the advisor again.";
        ids.add(course.id); codes.add(course.code); next=place(next,course.id,action.semesterId);
      }
      const expectedSemesters=new Set(proposal.totals.map(total=>total.semesterId));
      const validTotals=expectedSemesters.size===proposal.totals.length &&
        [...affected].every(sid=>expectedSemesters.has(sid)) &&
        proposal.totals.every(expected=>{
          const before=totalCredits(basis.entries.filter(e=>e.semesterId===expected.semesterId),fresh.courses);
          const after=totalCredits(next.entries.filter(e=>e.semesterId===expected.semesterId),fresh.courses);
          return before===expected.before && after===expected.after &&
            (!affected.has(expected.semesterId) || (after!==null && after<=targetCredits));
        });
      if (!validTotals) return "The draft's semester totals could not be verified. Run the advisor again.";
    } else if (proposal.actions.length===1 && proposal.actions[0].kind==="move") {
      const action=proposal.actions[0]; const entry=basis.entries.find(e=>e.courseId===action.courseId);
      if (!entry || entry.semesterId!==action.fromSemesterId || !fresh.courses.some(c=>c.id===action.courseId)) return "The course has moved since this review. Run the advisor again.";
      next=place(basis,action.courseId,action.semesterId);
      for (const expected of proposal.totals) {
        const actual=totalCredits(next.entries.filter(e=>e.semesterId===expected.semesterId),fresh.courses);
        if(actual==null || actual!==expected.after) return "The move totals could not be verified. Your plan was left unchanged.";
      }
    } else if (proposal.actions.length===1 && proposal.actions[0].kind==="replace") {
      const action=proposal.actions[0]; const index=basis.entries.findIndex(e=>e.courseId===action.courseId&&e.semesterId===action.semesterId);
      const oldCourse=fresh.courses.find(c=>c.id===action.courseId), replacement=fresh.courses.find(c=>c.id===action.replacementCourseId);
      if(index<0||!oldCourse||!replacement||oldCourse.credits==null||replacement.credits!==oldCourse.credits||basis.entries.some((e,i)=>i!==index&&e.courseId===replacement.id)) return "The replacement no longer matches the selected course. Your plan was left unchanged.";
      const entries=[...basis.entries];entries[index]={id:crypto.randomUUID(),courseId:replacement.id,semesterId:action.semesterId};
      const codes=entries.map(e=>fresh.courses.find(c=>c.id===e.courseId)?.code).filter(Boolean);
      if(new Set(codes).size!==codes.length) return "The replacement would duplicate a course code already in the plan.";
      next={...basis,entries};
      for(const expected of proposal.totals){const actual=totalCredits(next.entries.filter(e=>e.semesterId===expected.semesterId),fresh.courses);if(actual==null||actual!==expected.after)return "The replacement totals could not be verified. Your plan was left unchanged."}
    } else return "This draft contains an unsupported edit. Your plan was left unchanged.";
    if (planRef.current!==basis) return "Your plan changed while the catalog was checked. Run the advisor again.";
    setConfirmation(null);
    setHistory(h=>[...h.slice(-39),basis]);setPlan(next);planRef.current=next;
    setNotice("Advisor change applied as one plan edit. Undo is available.");
    return "applied";
  };
  const undo = () => {
    const last = history.at(-1);
    if (last) {
      setConfirmation(null);
      setPlan(last);
      setHistory((h) => h.slice(0, -1));
      setNotice("Last change undone.");
    }
  };
  const browse = (id?: string) => {
    if (id) setTarget(id);
    setSidebar(true);
    setTimeout(() => searchRef.current?.focus(), 50);
  };
  const openCourse = (course: Course) => {
    const current = plan.entries.find((e) => e.courseId === course.id);
    if (current) setTarget(current.semesterId);
    setDrawer({ kind: "course", course });
  };
  const startDrag = (event: DragStartEvent) =>
    setActiveCourse(
      courses.find((c) => c.id === event.active.data.current?.courseId) ?? null,
    );
  const endDrag = (event: DragEndEvent) => {
    setActiveCourse(null);
    const { active, over } = event;
    if (!over) return;
    const courseId = active.data.current?.courseId as string;
    const semesterId = over.data.current?.semesterId as string;
    if (courseId && semesterId) {
      edit(
        place(
          plan,
          courseId,
          semesterId,
          semesters.includes(String(over.id)) ? undefined : String(over.id),
        ),
      );
      setNotice(
        `${courses.find((c) => c.id === courseId)?.code} placed in ${semesterLabel(semesterId, plan.startYear)}.`,
      );
    }
  };
  const applyExample = () => {
    const example = examplePlan(plan.startYear, courses);
    setConfirmation(null);
    if (!example) {
      confirmationTrigger.current?.focus();
      setNotice("The example plan is unavailable because some of its courses are missing from this catalog.");
      return;
    }
    edit(example);
    setNotice("Example plan loaded.");
    requestAnimationFrame(() => undoButton.current?.focus());
  };
  const clearSchedule = () => {
    edit({ ...plan, entries: [] });
    setNotice("Schedule cleared. Use Undo to restore your courses.");
    requestAnimationFrame(() => undoButton.current?.focus());
  };
  const selected = drawer?.kind === "course" ? drawer.course : null;
  const selectedEntry = selected
    ? plan.entries.find((e) => e.courseId === selected.id)
    : undefined;
  const warnings = useMemo(() => planRequisiteWarnings(plan, courses), [plan, courses]);
  const selectedWarnings = selected ? warnings.get(selected.id) : undefined;
  return (
    <DndContext
      sensors={sensors}
      collisionDetection={(args) => {
        if (!args.pointerCoordinates) return closestCenter(args);
        const hits = pointerWithin(args).filter(
          (hit) => hit.id !== args.active.id,
        );
        const cards = hits.filter((hit) => !semesters.includes(String(hit.id)));
        return cards.length ? cards : hits;
      }}
      onDragStart={startDrag}
      onDragEnd={endDrag}
      onDragCancel={() => setActiveCourse(null)}
    >
      <div className="app-shell">
        <header className="topbar">
          <a className="brand" href="#main">
            <span className="brand-mark">
              <BookOpen size={20} />
            </span>
            <span>
              Fieldnotes
              <span className="brand-college">Grinnell course planner</span>
            </span>
          </a>
          <button
            className="library-toggle"
            aria-label={`${sidebar ? "Hide" : "Show"} course library`}
            aria-expanded={sidebar}
            aria-controls="course-library"
            onClick={() => setSidebar((open) => !open)}
          >
            {sidebar ? <PanelLeftClose size={17} /> : <PanelLeftOpen size={17} />}
            <span>{sidebar ? "Hide courses" : "Show courses"}</span>
          </button>
          <div className="topbar-right">
            <span className="save-status">
              {saveState.startsWith("Saved") && <Check size={14} />}
              {saveState}
            </span>
            <button
              className="ai-trigger"
              onClick={() => setDrawer({ kind: "ai" })}
            >
              <img src={advisorSquirrel} alt="" width={32} height={32} />
              <span>AI advisor</span>
            </button>
          </div>
        </header>
        <div className={`workspace ${sidebar ? "with-sidebar" : ""}`}>
          {sidebar && (
            <>
              <button
                className="sidebar-backdrop"
                aria-label="Hide course library"
                onClick={() => setSidebar(false)}
              />
              <aside id="course-library" className="catalog" aria-label="Course library">
                <div className="catalog-heading">
                  <h2>Course library</h2>
                  <button
                    className="icon-button"
                    onClick={() => setSidebar(false)}
                    aria-label="Hide course library"
                  >
                    <PanelLeftClose size={19} />
                  </button>
                </div>
                <p className="catalog-intro">
                  Find what sparks your curiosity.
                </p>
                <label className="search-box">
                  <Search size={17} />
                  <input
                    ref={searchRef}
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder="Search courses"
                    aria-label="Search courses"
                  />
                  {query && (
                    <button
                      aria-label="Clear search"
                      onClick={() => setQuery("")}
                    >
                      <X size={14} />
                    </button>
                  )}
                </label>
                <div className="filters">
                  <div className="select-wrap">
                    <select
                      aria-label="Filter by department"
                      value={department}
                      onChange={(e) => setDepartment(e.target.value)}
                    >
                      <option value="">All departments</option>
                      {departments.map((d) => (
                        <option key={d}>{d}</option>
                      ))}
                    </select>
                    <ChevronDown size={14} />
                  </div>
                  <div className="select-wrap level-filter">
                    <select
                      aria-label="Filter by level"
                      value={level}
                      onChange={(e) => setLevel(e.target.value)}
                    >
                      <option value="">Level</option>
                      {[...new Set(courses.map(c => c.level))].sort((a,b)=>a-b).map((n) => (
                        <option key={n} value={n}>
                          {n}
                        </option>
                      ))}
                    </select>
                    <ChevronDown size={14} />
                  </div>
                </div>
                <div className="results-heading">
                  <span>
                    {loading
                      ? "Loading courses…"
                      : `${filtered.length} ${filtered.length === 1 ? "course" : "courses"}`}
                  </span>
                  <span>{courses[0]?.source_term ?? "Catalog"}</span>
                </div>
                <div className="course-results">
                  {error ? (
                    <div className="inline-error">
                      <p>{error}</p>
                      <button onClick={retryCatalog}>
                        Retry
                      </button>
                    </div>
                  ) : loading ? (
                    <div className="loading-courses">
                      {[0, 1, 2, 3].map((i) => (
                        <div className="skeleton" key={i} />
                      ))}
                    </div>
                  ) : filtered.length === 0 ? (
                    <div className="no-results">
                      <Search size={23} />
                      <p>No courses found</p>
                      <small>Try another title or clear your filters.</small>
                      <button
                        className="text-button"
                        onClick={() => {
                          setQuery("");
                          setDepartment("");
                          setLevel("");
                        }}
                      >
                        Clear filters
                      </button>
                    </div>
                  ) : (
                    filtered.map((course) => {
                      const entry = plan.entries.find(
                        (e) => e.courseId === course.id,
                      );
                      return (
                        <CatalogCard
                          key={course.id}
                          course={course}
                          planned={
                            entry
                              ? semesterLabel(entry.semesterId, plan.startYear)
                              : undefined
                          }
                          onDetail={() => openCourse(course)}
                          onAdd={() => openCourse(course)}
                        />
                      );
                    })
                  )}
                </div>
                <footer className="catalog-footer">
                  <GripVertical size={15} />
                  <span>Drag a course into your plan</span>
                </footer>
              </aside>
            </>
          )}
          <main id="main" className="planner">
            <div className="planner-intro">
              <div className="intro-topline">
                <span className="quiet-label">
                  <span className="tiny-leaf">
                    <Leaf size={14} />
                  </span>
                  Your education, thoughtfully explored
                </span>
                <span className="plan-kind">Personal plan</span>
              </div>
              <h1>
                A little structure.
                <br className="mobile-break" /> A world of possibility.
              </h1>
              <p>
                Make room for your interests. Shape the next four years, one
                course at a time.
              </p>
            </div>
            <div className="plan-toolbar">
              <div className="toolbar-start">
                {!sidebar && (
                  <button
                    className="browse-button"
                    aria-label="Courses"
                    onClick={() => browse()}
                  >
                    <PanelLeftOpen size={17} />
                    <span>Courses</span>
                  </button>
                )}
                <div className="start-year">
                  <CalendarDays size={16} />
                  <label htmlFor="start-year">Starting fall</label>
                  <div className="select-wrap">
                    <select
                      id="start-year"
                      value={plan.startYear}
                      onChange={(e) =>
                        edit({ ...plan, startYear: Number(e.target.value) })
                      }
                    >
                      {Array.from({ length: 16 }, (_, i) => 2020 + i).map(
                        (y) => (
                          <option key={y}>{y}</option>
                        ),
                      )}
                    </select>
                    <ChevronDown size={14} />
                  </div>
                </div>
                <span className="toolbar-divider" />
                <span className="total-credits">
                  {totalCredits(plan.entries, courses) == null ? <><strong>{plan.entries.length}</strong> courses · Credits unavailable</> : <><strong>{totalCredits(plan.entries, courses)}</strong> planned credits</>}
                </span>
              </div>
              <div className="toolbar-actions">
                <button className="example-button" onClick={() => setDrawer({kind:"ai",action:"critique_plan"})}>Critique plan</button>
                <button
                  className="example-button"
                  disabled={loading || !!error || !courses.length}
                  onClick={(event) => {
                    confirmationTrigger.current = event.currentTarget;
                    plan.entries.length
                      ? setConfirmation("example")
                      : applyExample();
                  }}
                >
                  Load example<span className="example-long"> plan</span>
                </button>
                <button
                  className="example-button"
                  disabled={!plan.entries.length}
                  onClick={(event) => {
                    confirmationTrigger.current = event.currentTarget;
                    setConfirmation("clear");
                  }}
                >
                  Clear schedule
                </button>
                <button
                  ref={undoButton}
                  className="icon-button undo-button"
                  onClick={undo}
                  disabled={!history.length}
                  aria-label="Undo last change"
                  title="Undo last change"
                >
                  <Undo2 size={18} />
                </button>
              </div>
            </div>
            {confirmation && (
              <div className="confirmation" role="alert">
                {confirmation === "clear" ? (
                  <>
                    <span>Remove every course from your schedule? You can undo this change.</span>
                    <button className="clear-confirm-button" onClick={clearSchedule}>Clear all courses</button>
                  </>
                ) : (
                  <>
                    <span>Replace your current plan with the example?</span>
                    <button disabled={loading || !!error} onClick={applyExample}>Replace plan</button>
                  </>
                )}
                <button autoFocus onClick={() => {
                  setConfirmation(null);
                  confirmationTrigger.current?.focus();
                }}>Cancel</button>
              </div>
            )}
            {storageBlocked && (
              <div className="inline-error">
                <p>{initial.error}</p>
                <button onClick={() => setStorageBlocked(false)}>
                  Start fresh
                </button>
              </div>
            )}
            {error && !sidebar && (
              <div className="inline-error">
                <p>{error}</p>
                <button onClick={() => setRetry((n) => n + 1)}>Retry</button>
              </div>
            )}
            <div className="years">
              {[0, 1, 2, 3].map((year) => (
                <section className="year" key={year}>
                  <div className="year-heading">
                    <h2>Year {year + 1}</h2>
                    <span>
                      {plan.startYear + year}–
                      {String(plan.startYear + year + 1).slice(-2)}
                    </span>
                    <div className="year-line" />
                    {year === 0 && (
                      <span className="year-note">Begin with curiosity</span>
                    )}
                  </div>
                  <div className="semester-grid">
                    {[year * 2, year * 2 + 1].map((i) => (
                      <Semester
                        key={i}
                        id={semesters[i]}
                        plan={plan}
                        courses={courses}
                        warnings={warnings}
                        onBrowse={() => browse(semesters[i])}
                        onGenerate={() => setDrawer({kind:"ai",semesterId:semesters[i],action:"generate_semester"})}
                        onDetail={openCourse}
                      onRemove={(entry) => edit({...plan, entries: plan.entries.filter(e => e.id !== entry.id)})}
                      />
                    ))}
                  </div>
                </section>
              ))}
            </div>
            <footer className="planner-footer">
              <span>A plan is a starting point. Leave room to discover.</span>
              <span>{courses[0]?.source_term ?? "Course"} catalog · Not a degree audit</span>
            </footer>
          </main>
        </div>
        {notice && !storageBlocked && (
          <div className="toast" role="status">
            <span>{notice}</span>
            <button
              aria-label="Dismiss notification"
              onClick={() => setNotice("")}
            >
              <X size={15} />
            </button>
          </div>
        )}
        <dialog
          ref={dialogRef}
          className="detail-drawer"
          aria-labelledby="drawer-title"
          onCancel={() => setDrawer(null)}
          onClick={(e) => {
            if (e.target === e.currentTarget) setDrawer(null);
          }}
        >
          <div className="drawer-inner">
            <div className="drawer-header">
              <span>{selected ? "Course details" : "Your advising space"}</span>
              <button
                className="icon-button"
                aria-label="Close panel"
                onClick={() => setDrawer(null)}
              >
                <X size={21} />
              </button>
            </div>
            {drawer?.kind === "ai" ? (
              <AiAdvisor plan={plan} courses={courses} revision={catalogRevision} catalogLoadFailed={!!error} onCatalogRetry={retryCatalog} initialSemester={drawer.semesterId} initialAction={drawer.action} initialCourseId={drawer.courseId} onApply={applyAdvisorProposal} onOpenCourse={(course)=>setDrawer({kind:"course",course})} onClose={()=>setDrawer(null)} onCatalogRefresh={(rows,revision)=>{setCourses(rows);setCatalogRevision(revision)}} />
            ) : (
              selected && (
                <div className="course-detail">
                  <span className={`course-code ${courseTone(selected)}`}>
                    {selected.code}
                  </span>
                  <h2 id="drawer-title">{selected.title}</h2>
                  <div className="detail-meta">
                    <span>{selected.credit_display ? `${selected.credit_display} credits` : selected.credits == null ? "Credits unavailable" : `${selected.credits} credits`}</span>
                    <span>{selected.department}</span>
                  </div>
                  <p>{selected.description ?? "A full course description is not included in this catalog file."}</p>
                  {selectedWarnings && (
                    <div className="requisite-warning">
                      <h3><CircleAlert size={16} aria-hidden="true" /> Course requisites to check</h3>
                      <ul>
                        {selectedWarnings.map((requirement) => <li key={requirement}>{requirement}</li>)}
                      </ul>
                    </div>
                  )}
                  <div className="prerequisites">
                    <h3>Description prerequisites</h3>
                    <p>
                      {selected.prerequisites ??
                        "Not provided in the catalog file."}
                    </p>
                  </div>
                  <div className="prerequisites"><h3>System requisites</h3><p>{selected.system_requisites ?? "Not provided in the catalog file."}</p></div>
                  {selected.catalog_notes && <div className="catalog-note"><h3>Catalog note</h3><p>{selected.catalog_notes}</p></div>}
                  <div className="course-advisor-actions"><button className="text-button" onClick={()=>setDrawer({kind:"ai",action:"prerequisite_roadmap",semesterId:selectedEntry?.semesterId,courseId:selected.id})}>Explore prerequisites</button>{selectedEntry&&<button className="text-button" onClick={()=>setDrawer({kind:"ai",action:"find_alternatives",semesterId:selectedEntry.semesterId,courseId:selected.id})}>Find alternatives</button>}</div>
                  <div className="placement-form">
                    <label htmlFor="semester-choice">
                      {selectedEntry ? "Move to semester" : "Add to semester"}
                    </label>
                    <div className="select-wrap">
                      <select
                        id="semester-choice"
                        value={target}
                        onChange={(e) => setTarget(e.target.value)}
                      >
                        {semesters.map((id) => (
                          <option key={id} value={id}>
                            {semesterLabel(id, plan.startYear)}
                          </option>
                        ))}
                      </select>
                      <ChevronDown size={17} />
                    </div>
                    <button
                      className="primary-button"
                      onClick={() => {
                        edit(place(plan, selected.id, target));
                        setNotice(
                          `${selected.code} ${selectedEntry ? "moved to" : "added to"} ${semesterLabel(target, plan.startYear)}.`,
                        );
                        setDrawer(null);
                        if (window.innerWidth < 1100) setSidebar(false);
                      }}
                    >
                      <Plus size={17} />
                      {selectedEntry ? "Move course" : "Add to plan"}
                    </button>
                    {selectedEntry && (
                      <button
                        className="remove-button"
                        onClick={() => {
                          edit({
                            ...plan,
                            entries: plan.entries.filter(
                              (e) => e.id !== selectedEntry.id,
                            ),
                          });
                          setNotice(`${selected.code} removed from your plan.`);
                          setDrawer(null);
                        }}
                      >
                        <Trash2 size={16} />
                        Remove from plan
                      </button>
                    )}
                  </div>
                  <p className="demo-note">
                    Source: {selected.source_term} course file. Offering in other semesters is unconfirmed. Requisite warnings use the courses in your plan.
                  </p>
                </div>
              )
            )}
          </div>
        </dialog>
      </div>
      <DragOverlay>
        {activeCourse && (
          <div className="drag-preview">
            <CourseFace course={activeCourse} />
          </div>
        )}
      </DragOverlay>
    </DndContext>
  );
}
createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

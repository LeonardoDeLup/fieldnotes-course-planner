# Fieldnotes · Grinnell course planner

A local dark-mode, four-year planning workspace. React and TypeScript provide the interface; Python FastAPI serves the supplied Spring 2027 course CSV (395 rows, including distinct topics and repeat codes). An optional local Ollama model ranks catalog-based drafts and findings; the planner remains usable when Ollama is unavailable.

## Run

This workspace already includes installed dependencies and a project-local Node runtime:

```sh
./start.sh
```

Open **http://127.0.0.1:5173** after the launcher prints `Fieldnotes is ready`. API documentation is at **http://127.0.0.1:8000/docs**. Ctrl+C stops both servers. If the launcher reports that port 8000 or 5173 is occupied, stop the older server in its terminal and rerun `./start.sh`.

For a fresh checkout, install Node.js 22 LTS and Python 3.12+, then:

```sh
python3 -m venv backend/.venv
backend/.venv/bin/pip install -r backend/requirements.txt
cd frontend
npm ci --legacy-peer-deps
cd ..
./start.sh
```

`--legacy-peer-deps` avoids an npm 10 peer-graph resolver crash involving optional Vitest browser dependencies. Versions are pinned in the lockfile.

## Use

- Search courses and filter by department or level.
- Drag a course by its grip into a semester. Move between semesters or reorder within one; drop on the lower add-course area to place it at the end.
- Alternatively, open any course card or its plus button and select a semester. These controls work with keyboard and touch.
- Click a planned course to move or remove it. Undo restores the previous plan edit.
- An amber exclamation marks a planned course with a missing or mistimed course requisite. Open the card to see the course and semester timing to check.
- Change the starting fall year without changing placements. Load example plan provides a populated demonstration, with confirmation before replacement.
- The plan saves on this browser and origin. It is not stored in Python or synchronized across devices. Use the same `127.0.0.1:5173` address when reopening.
- Generate semester from any term header to preview course drafts. Critique the full plan for sequence, credit, source-term, and catalog-data signals. The drawer also supports course discovery, prerequisite exploration, alternatives, and an advising brief.
- Choose **Generate 4-year plan** in the AI advisor to draft courses across all eight semesters. Set a credit target per semester and optionally add focus departments and goals. Existing placements appear in the preview alongside proposed courses. Applying a draft adds the courses in one undoable edit.
- Drafts and findings use the current CSV snapshot. Requisite checks cover a small set of explicit catalog rules; other text is shown for manual review. This is not a degree audit, enrollment check, or guarantee of future offerings.
- The optional model runs locally through Ollama. Without it, deterministic catalog advice still works. No student plan or prompt is written to disk by the advisor.

The supplied Spring 2027 CSV is loaded directly. Card warnings compare explicit course requisites with semester placements in your plan. The course details show the full catalog text for requirements such as placement, grades, or instructor permission. Duplicate course placement is prevented in this version, including courses that could eventually be repeatable.

## Database integration

`backend/app/main.py` defines `CourseRepository` with `list() -> list[Course]` and `get(course_id) -> Course | None`. Replace `MockCourseRepository` with your database adapter and keep course IDs stable. The frontend does not depend on the database schema.

| Endpoint | Response |
| --- | --- |
| `GET /api/health` | Current catalog health and row count |
| `GET /api/courses` | Array of courses |
| `GET /api/courses/{course_id}` | Course, or 404 |
| `GET /api/ai/status` | Local model connection state |
| `POST /api/ai/advice` | Validated catalog advice, proposals, findings, or suggestions |

`GET /api/courses` includes an `X-Catalog-Revision` header. The advisor rejects a request when the catalog snapshot changes and rechecks the revision before an edit is applied.

A course has `id`, `code`, `title`, `department`, `level` (100/200/300), numeric `credits` from the CSV, `description`, and nullable `prerequisites` display text. The Python Pydantic model and generated `/docs` are authoritative. Add SQL queries behind the repository; no API shape change is required.

Frontend plan data is versioned separately: `{version: 1, startYear, entries: [{id, courseId, semesterId}]}`. Semester IDs are `semester-0` through `semester-7`; ordering is the array order within each semester. Unavailable catalog entries remain in saved plans. Credit totals count only loaded, known courses.

The advisor routes read the catalog once per request and build rules-based options before the optional model ranks IDs. The shared drawer also displays course details, so only one secondary panel is open at a time.

### Optional local model

Install and start Ollama separately, then install `qwen3-vl:4b-instruct` with `ollama pull qwen3-vl:4b-instruct`. Fieldnotes connects to `http://127.0.0.1:11434` and uses that model by default. To override the settings, export these variables before starting Fieldnotes:

```sh
export FIELDNOTES_OLLAMA_URL=http://127.0.0.1:11434
export FIELDNOTES_OLLAMA_MODEL=qwen3-vl:4b-instruct
export FIELDNOTES_AI_ENABLED=1
```

Set `FIELDNOTES_AI_ENABLED=0` to disable model calls while keeping catalog advice. Ollama can be opened from its desktop app or started in a separate terminal with `ollama serve`.

## Verification

```sh
cd backend
.venv/bin/python -m pytest -q
cd ../frontend
export PATH="$(pwd)/../.tools/node/bin:$PATH"  # only for this workspace's local Node
npm test
npm run build
```

With the app running, browser checks:

```sh
cd frontend
export PATH="$(pwd)/../.tools/node/bin:$PATH"
export PLAYWRIGHT_BROWSERS_PATH="$(pwd)/../.tools/browsers"
npx playwright install chromium
npm run test:e2e
```

Browser tests cover catalog filtering, mouse dragging, ordering, keyboard-accessible placement, undo, persistence, failed API requests, storage errors, dialog focus, and responsive overflow. Screenshots are written to `artifacts/` for visual review. Browser test traces are retained on failure.

### Verified in this workspace

- Backend: **11 passed**.
- Frontend unit tests: **5 passed**.
- Production TypeScript/Vite build: passed.
- Chromium browser suite: **14 passed**, including advisor generation, move preview/apply/undo, stale-catalog invalidation, and recovery from an older API.
- The installed `qwen3-vl:4b-instruct` model returned ranked advice through the full advisor route.

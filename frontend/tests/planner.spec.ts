import { test, expect } from "@playwright/test";
import type { Page, Locator } from "@playwright/test";
async function drag(page: Page, source: Locator, target: Locator) {
  await expect(page.locator(".drag-preview")).toHaveCount(0);
  await source.scrollIntoViewIfNeeded();
  const s = await source.boundingBox();
  const t = await target.boundingBox();
  if (!s || !t) throw Error("Missing drag bounds");
  await page.mouse.move(s.x + s.width / 2, s.y + s.height / 2);
  await page.mouse.down();
  await page.mouse.move(s.x + s.width / 2 + 10, s.y + s.height / 2, {
    steps: 3,
  });
  await page.mouse.move(t.x + t.width / 2, t.y + t.height / 2, { steps: 18 });
  await page.mouse.up();
  await expect(page.locator(".drag-preview")).toHaveCount(0);
}
test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await expect(page.getByText("395 courses", { exact: true })).toBeVisible();
});
test("requisite warnings update when a prerequisite moves and undo restores them", async ({ page }) => {
  const entries = [
    { id: "dependent", courseId: "csc-161", semesterId: "semester-1" },
    { id: "prerequisite", courseId: "csc-151", semesterId: "semester-2" },
  ];
  await page.evaluate((entries) => localStorage.setItem(
    "fieldnotes-plan-v1", JSON.stringify({ version: 1, startYear: 2026, entries }),
  ), entries);
  await page.reload();

  const dependent = page.getByTestId("planned-csc-161").locator(".card-main");
  const icon = dependent.locator(".requisite-icon");
  await expect(icon).toBeVisible();
  await expect(dependent).toHaveAccessibleDescription(/CSC 151 in an earlier semester/);
  await dependent.focus();
  await page.keyboard.press("Enter");
  const drawer = page.getByRole("dialog");
  await expect(drawer.getByText("CSC 151 in an earlier semester", { exact: true })).toBeVisible();
  await drawer.getByRole("button", { name: "Close panel" }).click();

  await page.getByTestId("planned-csc-151").locator(".card-main").click();
  await drawer.getByLabel("Move to semester").selectOption("semester-0");
  await drawer.getByRole("button", { name: "Move course", exact: true }).click();
  await expect(icon).toHaveCount(0);
  await page.getByRole("button", { name: "Undo last change" }).click();
  await expect(icon).toBeVisible();
});
test("browse, add, move, remove, undo, save, and AI drawer", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.getByRole("textbox", { name: "Search courses" }).fill("CSC 151");
  await expect(page.getByTestId("catalog-csc-151")).toBeVisible();
  await expect(page.getByText("1 course", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Add CSC 151", exact: true }).click();
  await page
    .getByLabel("Add to semester", { exact: true })
    .selectOption("semester-0");
  await page.getByRole("button", { name: "Add to plan", exact: true }).click();
  await expect(
    page.getByTestId("semester-0").getByTestId("planned-csc-151"),
  ).toBeVisible();
  await expect(page.locator(".total-credits")).toContainText("4");
  await page.getByTestId("planned-csc-151").locator(".card-main").click();
  await page
    .getByLabel("Move to semester", { exact: true })
    .selectOption("semester-3");
  await page.getByRole("button", { name: "Move course", exact: true }).click();
  await expect(
    page.getByTestId("semester-3").getByTestId("planned-csc-151"),
  ).toBeVisible();
  await page.reload();
  await expect(
    page.getByTestId("semester-3").getByTestId("planned-csc-151"),
  ).toBeVisible();
  await page.getByTestId("planned-csc-151").locator(".card-main").click();
  await page
    .getByRole("button", { name: "Remove from plan", exact: true })
    .click();
  await expect(page.getByTestId("planned-csc-151")).toHaveCount(0);
  await page.getByRole("button", { name: "Undo last change" }).click();
  await expect(page.getByTestId("planned-csc-151")).toHaveCount(1);
  await page.getByRole("button", { name: "AI advisor" }).click();
  await expect(page.getByRole("dialog")).toContainText("Generate semester");
  await expect(page.getByRole("dialog")).toContainText("1 course");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).not.toBeVisible();
  await expect(page.getByRole("button", { name: "AI advisor" })).toBeFocused();
  expect(errors).toEqual([]);
});
test("semester advisor previews a chemistry pair, applies one edit, and undoes it", async ({page})=>{
  const plan={version:1,startYear:2026,entries:[{id:"e1",courseId:"csc-151",semesterId:"semester-0"},{id:"e2",courseId:"csc-161",semesterId:"semester-1"}]};
  await page.evaluate((value)=>localStorage.setItem("fieldnotes-plan-v1",JSON.stringify(value)),plan);
  await page.reload();
  await page.getByRole("button",{name:"Generate semester for Spring 2027"}).click();
  await page.getByLabel("Reference credit target").fill("8");
  await page.getByLabel("Focus departments (up to five)").fill("CHM");
  await page.route("**/api/ai/advice",async route=>{
    const request=route.request().postDataJSON();
    const stats=Array.from({length:8},(_,i)=>({semesterId:`semester-${i}`,courseCount:i===1?1:i===0?1:0,credits:i===0||i===1?4:0}));
    await route.fulfill({status:200,contentType:"application/json",headers:{"X-Catalog-Revision":request.catalogRevision},body:JSON.stringify({action:"generate_semester",catalogRevision:request.catalogRevision,sourceTerms:["Spring 2027"],mode:"rules",reason:"model_not_needed",summary:"A chemistry pair fits the remaining credits.",proposals:[{id:"p1",label:"Balanced",rationale:"Adds CHM 129 with its same-term lab for 4 credits.",actions:[{kind:"add",courseId:"chm-129",semesterId:"semester-1"},{kind:"add",courseId:"chm-129l",semesterId:"semester-1"}],totals:[{semesterId:"semester-1",before:4,after:8}],placements:[{courseId:"chm-129",semesterId:"semester-1",availability:"listed_in_source_term",requisiteStatus:"no_issue_in_plan",evidence:[]},{courseId:"chm-129l",semesterId:"semester-1",availability:"listed_in_source_term",requisiteStatus:"no_issue_in_plan",evidence:[]}],notices:[]}],findings:[],suggestions:[],semesterStats:stats})});
  });
  await page.getByRole("button",{name:"Generate drafts"}).click();
  await expect(page.getByText("Adds CHM 129 with its same-term lab for 4 credits.")).toBeVisible();
  await expect(page.getByTestId("semester-1").getByTestId("planned-csc-161")).toBeVisible();
  await page.getByRole("button",{name:"Add courses"}).click();
  await expect(page.getByTestId("semester-1").getByTestId("planned-chm-129")).toBeVisible();
  await expect(page.getByTestId("semester-1").getByTestId("planned-chm-129l")).toBeVisible();
  await page.getByRole("button",{name:"Undo last change"}).click();
  await expect(page.getByTestId("semester-1").getByTestId("planned-chm-129")).toHaveCount(0);
  await expect(page.getByTestId("semester-1").getByTestId("planned-csc-161")).toBeVisible();
});
test("critique previews and applies a supported move before undo", async ({page})=>{
  const plan={version:1,startYear:2026,entries:[{id:"e1",courseId:"csc-161",semesterId:"semester-0"},{id:"e2",courseId:"csc-151",semesterId:"semester-1"}]};
  await page.evaluate((value)=>localStorage.setItem("fieldnotes-plan-v1",JSON.stringify(value)),plan);await page.reload();
  await page.getByRole("button",{name:"Critique plan"}).click();
  await page.route("**/api/ai/advice",async route=>{const request=route.request().postDataJSON();const stats=Array.from({length:8},(_,i)=>({semesterId:`semester-${i}`,courseCount:i<2?1:0,credits:i<2?4:0}));await route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({action:"critique_plan",catalogRevision:request.catalogRevision,sourceTerms:["Spring 2027"],mode:"rules",reason:"model_not_needed",summary:"A planned prerequisite comes later.",proposals:[{id:"repair-1",label:"Preview move",rationale:"Move CSC 161 to Fall 2027 so CSC 151 is earlier.",actions:[{kind:"move",courseId:"csc-161",fromSemesterId:"semester-0",semesterId:"semester-2"}],totals:[{semesterId:"semester-0",before:4,after:0},{semesterId:"semester-2",before:0,after:4}],placements:[{courseId:"csc-161",semesterId:"semester-2",availability:"term_unverified",requisiteStatus:"no_issue_in_plan",evidence:[{courseId:"csc-161",field:"system_requisites",excerpt:"CSC-151 - Must be completed prior to taking this course."}]}],notices:[]}],findings:[{id:"f1",code:"sequence_gap",severity:"attention",semesterId:"semester-0",courseIds:["csc-161"],title:"CSC 161 requisite needs attention",detail:"CSC 151 is planned later.",nextStep:"Move CSC 161 after CSC 151.",evidence:[{courseId:"csc-161",field:"system_requisites",excerpt:"CSC-151 - Must be completed prior to taking this course."}],proposalId:"repair-1"}],suggestions:[],semesterStats:stats})})});
  await page.getByRole("button",{name:"Review plan"}).click();
  await expect(page.getByRole("blockquote")).toContainText("CSC-151 - Must be completed prior");
  await page.getByRole("button",{name:"Preview move"}).click();
  await page.getByRole("button",{name:"Apply move"}).click();
  await expect(page.getByTestId("semester-2").getByTestId("planned-csc-161")).toBeVisible();
  await page.getByRole("button",{name:"Undo last change"}).click();
  await expect(page.getByTestId("semester-0").getByTestId("planned-csc-161")).toBeVisible();
});

test("four-year advisor previews all terms, applies as one edit, and keeps saved courses on undo", async ({page})=>{
  test.setTimeout(125_000);
  const plan={version:1,startYear:2026,entries:[{id:"saved",courseId:"csc-151",semesterId:"semester-0"}]};
  await page.evaluate(value=>localStorage.setItem("fieldnotes-plan-v1",JSON.stringify(value)),plan);
  await page.reload();
  await page.getByRole("button",{name:"AI advisor"}).click();
  const dialog=page.getByRole("dialog");
  await dialog.getByLabel("Planning workflow").selectOption({label:"Generate 4-year plan"});
  await expect(dialog.getByLabel("Semester",{exact:true})).toHaveCount(0);
  await dialog.getByLabel("Focus departments (up to five)").fill("CSC");
  await dialog.getByRole("button",{name:"Generate 4-year plan"}).click();
  await expect(dialog.getByRole("heading",{name:"4-year plan preview"})).toBeVisible({timeout:110_000});
  await expect(dialog.locator(".full-plan-terms summary")).toHaveCount(8);
  await expect(dialog.getByText("16-credit target in 8 of 8 semesters",{exact:false})).toBeVisible();
  await dialog.locator("summary").filter({hasText:"Fall 2026"}).click();
  await expect(dialog.getByText("Already planned",{exact:true})).toBeVisible();
  await expect(page.locator(".planned-card")).toHaveCount(1);

  await dialog.getByRole("button",{name:"Apply 4-year draft"}).click();
  await expect(dialog).not.toBeVisible();
  await expect(page.locator(".total-credits")).toContainText("128");
  for (let i=0;i<8;i++) {
    await expect(page.getByTestId(`semester-${i}`).locator(".planned-card").first()).toBeVisible();
  }
  await page.getByRole("button",{name:"Undo last change"}).click();
  await expect(page.locator(".planned-card")).toHaveCount(1);
  await expect(page.getByTestId("semester-0").getByTestId("planned-csc-151")).toBeVisible();
});
test("a changed catalog revision invalidates the preview and allows a rerun",async({page})=>{
  await page.getByRole("button",{name:"Generate semester for Fall 2026"}).click();
  await page.getByLabel("Reference credit target").fill("8");
  await page.route("**/api/ai/advice",async route=>{const request=route.request().postDataJSON();const stats=Array.from({length:8},(_,i)=>({semesterId:`semester-${i}`,courseCount:0,credits:0}));await route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({action:"generate_semester",catalogRevision:request.catalogRevision,sourceTerms:["Spring 2027"],mode:"rules",reason:"model_not_needed",summary:"A four-credit course fits.",proposals:[{id:"p1",label:"Balanced",rationale:"Add CSC 105 for 4 credits.",actions:[{kind:"add",courseId:"csc-105",semesterId:"semester-0"}],totals:[{semesterId:"semester-0",before:0,after:4}],placements:[{courseId:"csc-105",semesterId:"semester-0",availability:"term_unverified",requisiteStatus:"no_issue_in_plan",evidence:[]}],notices:[]}],findings:[],suggestions:[],semesterStats:stats})})});
  await page.getByRole("button",{name:"Generate drafts"}).click();await expect(page.getByText("Add CSC 105 for 4 credits.")).toBeVisible();
  await page.route("**/api/courses",async route=>{const response=await route.fetch();await route.fulfill({response,headers:{...response.headers(),"x-catalog-revision":"f".repeat(64)}})});
  await page.getByRole("button",{name:"Add courses"}).click();
  await expect(page.getByText("Catalog changed. Run again with the refreshed catalog.")).toBeVisible();
  await expect(page.getByTestId("planned-csc-105")).toHaveCount(0);
  await page.getByRole("button",{name:"Run again"}).click();
  await expect(page.getByText("A four-credit course fits.")).toBeVisible();
});
test("pointer drag, move, reorder, and cancel outside a semester", async ({
  page,
}) => {
  await drag(
    page,
    page.getByRole("button", { name: "Drag CSC 151", exact: true }),
    page.getByTestId("semester-0").locator(".empty-semester"),
  );
  await expect(
    page.getByTestId("semester-0").getByTestId("planned-csc-151"),
  ).toBeVisible();
  await drag(
    page,
    page.getByRole("button", { name: "Move CSC 151", exact: true }),
    page.getByTestId("semester-1").locator(".empty-semester"),
  );
  await expect(
    page.getByTestId("semester-1").getByTestId("planned-csc-151"),
  ).toBeVisible();
  await drag(
    page,
    page.getByRole("button", { name: "Drag CSC 161", exact: true }),
    page.getByTestId("semester-1").locator(".semester-add"),
  );
  await expect(
    page.getByTestId("semester-1").locator(".planned-card"),
  ).toHaveCount(2);
  await drag(
    page,
    page.getByRole("button", { name: "Move CSC 161", exact: true }),
    page.getByTestId("planned-csc-151"),
  );
  await expect(
    page.getByTestId("semester-1").locator(".planned-card").first(),
  ).toHaveAttribute("data-testid", "planned-csc-161");
  await drag(
    page,
    page.getByRole("button", { name: "Move CSC 151", exact: true }),
    page.locator("h1"),
  );
  await expect(
    page.getByTestId("semester-1").getByTestId("planned-csc-151"),
  ).toBeVisible();
  const handle = page.getByRole("button", {
    name: "Move CSC 151",
    exact: true,
  });
  await handle.focus();
  await page.keyboard.press("Space");
  await page.keyboard.press("Escape");
  await expect(
    page.getByTestId("semester-1").getByTestId("planned-csc-151"),
  ).toBeVisible();
});
test("filters, example confirmation, dates and populated screenshots", async ({
  page,
}) => {
  await page
    .getByLabel("Filter by department")
    .selectOption("CSC");
  await page.getByLabel("Filter by level").selectOption("200");
  await expect(page.locator(".catalog-card")).toHaveCount(3);
  await page
    .getByRole("textbox", { name: "Search courses" })
    .fill("nothing matches");
  await expect(page.getByText("No courses found")).toBeVisible();
  await page.getByRole("button", { name: "Clear filters" }).click();
  await page.getByRole("button", { name: "Load example plan" }).click();
  await expect(page.locator(".planned-card")).toHaveCount(12);
  await expect(page.locator(".total-credits")).toContainText("45");
  await page.getByRole("button", { name: "Load example plan" }).click();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page.locator(".planned-card")).toHaveCount(12);
  await page.getByLabel("Starting fall").selectOption("2027");
  await expect(page.getByTestId("semester-7")).toContainText("Spring 2031");
  await expect(page.locator(".planned-card")).toHaveCount(12);
  await page.getByLabel("Starting fall").selectOption("2026");
  await page.getByRole("button", { name: "Dismiss notification" }).click();
  await page.screenshot({
    path: "../artifacts/desktop-populated.png",
    fullPage: true,
  });
});
test("responsive layout, keyboard add, reduced motion, and drawer focus", async ({
  page,
}) => {
  for (const width of [1280, 1024, 768, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await expect
      .poll(() =>
        page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth,
        ),
      )
      .toBe(true);
  }
  await page.reload();
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.getByRole("button", { name: "Courses", exact: true }).click();
  await page.getByRole("textbox", { name: "Search courses" }).fill("ENG 205");
  await page.getByRole("button", { name: "Add ENG 205", exact: true }).focus();
  await page.keyboard.press("Enter");
  await page
    .getByLabel("Add to semester", { exact: true })
    .selectOption("semester-0");
  await page.getByRole("button", { name: "Add to plan", exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("planned-eng-205")).toBeVisible();
  await page.screenshot({ path: "../artifacts/mobile.png", fullPage: true });
  await page.getByRole("button", { name: "AI advisor" }).click();
  for (let i = 0; i < 8; i++) await page.keyboard.press("Tab");
  expect(
    await page.evaluate(() =>
      document.querySelector("dialog")?.contains(document.activeElement),
    ),
  ).toBe(true);
  await page.screenshot({ path: "../artifacts/mobile-ai.png" });
  await page.keyboard.press("Escape");
});
test("API failure preserves the saved plan and retry restores catalog", async ({
  page,
}) => {
  await page.getByRole("button", { name: "Load example plan" }).click();
  await page.route("**/api/courses", (r) =>
    r.fulfill({ status: 503, body: "unavailable" }),
  );
  await page.reload();
  await expect(
    page.getByText("Courses could not load.", { exact: false }),
  ).toBeVisible();
  await expect(page.locator(".planned-card")).toHaveCount(12);
  await page.unroute("**/api/courses");
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(page.getByText("395 courses", { exact: true })).toBeVisible();
  await expect(page.locator(".planned-card")).toHaveCount(12);
});
test("advisor recovers from an older API without showing an empty plan", async ({ page }) => {
  await page.getByRole("button", { name: "Load example plan" }).click();
  await page.route("**/api/courses", async route => {
    const response = await route.fetch();
    const headers = response.headers();
    delete headers["x-catalog-revision"];
    await route.fulfill({ response, headers });
  });
  await page.route("**/api/ai/status", route => route.fulfill({ status: 404 }));
  await page.reload();
  await page.getByRole("button", { name: "AI advisor" }).click();
  const dialog = page.getByRole("dialog");
  const review = dialog.getByRole("button", { name: "Review plan" });
  await expect(dialog).toContainText("Advisor service unavailable");
  await expect(dialog).toContainText("Your plan has 12 courses across 4 semesters. Catalog: unavailable.");
  await expect(dialog.getByText("Your plan is empty.", { exact: false })).toHaveCount(0);
  await expect(review).toBeDisabled();

  await page.unroute("**/api/courses");
  await dialog.getByRole("button", { name: "Retry catalog" }).click();
  await expect(review).toBeEnabled();
  await expect(dialog).toContainText("Catalog: Spring 2027.");
  await expect(dialog.getByText("Catalog changed.", { exact: false })).toHaveCount(0);

  await page.route("**/api/ai/status?refresh=true", route =>
    route.fulfill({ json: { state: "offline", model: "qwen3-vl:4b-instruct", thinking: null } }),
  );
  await dialog.getByRole("button", { name: "Check connection" }).click();
  await expect(dialog).toContainText("Ollama is unreachable");
  await expect(review).toBeEnabled();
});
test("storage failure is reported without false saved status", async ({
  page,
}) => {
  await page.addInitScript(() => {
    Storage.prototype.setItem = () => {
      throw new Error("Blocked");
    };
  });
  await page.reload();
  await expect(page.getByText("Not saved", { exact: true })).toBeVisible();
  await expect(
    page.getByText("Device storage is unavailable.", { exact: false }),
  ).toBeVisible();
});

test("drag across years while scrolling and inspect empty responsive views", async ({
  page,
}) => {
  await page.screenshot({
    path: "../artifacts/desktop-empty.png",
    fullPage: true,
  });
  await drag(
    page,
    page.getByRole("button", { name: "Drag CSC 151", exact: true }),
    page.getByTestId("semester-0").locator(".empty-semester"),
  );
  const handle = page.getByRole("button", {
    name: "Move CSC 151",
    exact: true,
  });
  await handle.scrollIntoViewIfNeeded();
  const s = await handle.boundingBox();
  if (!s) throw Error("Missing source");
  await page.mouse.move(s.x + s.width / 2, s.y + s.height / 2);
  await page.mouse.down();
  await page.mouse.move(s.x + 25, s.y + 10, { steps: 5 });
  await expect(page.locator(".drag-preview")).toBeVisible();
  await page.mouse.wheel(0, 1000);
  const destination = page.getByTestId("semester-6").locator(".empty-semester");
  await destination.scrollIntoViewIfNeeded();
  const t = await destination.boundingBox();
  if (!t) throw Error("Missing target");
  await page.mouse.move(t.x + t.width / 2, t.y + t.height / 2, { steps: 20 });
  await page.mouse.up();
  await expect(page.locator(".drag-preview")).toHaveCount(0);
  await expect(
    page.getByTestId("semester-6").getByTestId("planned-csc-151"),
  ).toBeVisible();
  for (const width of [1280, 1024, 768]) {
    await page.setViewportSize({ width, height: 900 });
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: `../artifacts/layout-${width}.png` });
  }
});

test("touch placement and invalid saved data recovery", async ({ browser }) => {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
  const page = await context.newPage();
  await page.goto("/");
  await page.getByRole("button", { name: "Courses", exact: true }).tap();
  await page.getByRole("textbox", { name: "Search courses" }).fill("MUS 101");
  await page.getByRole("button", { name: "Add MUS 101", exact: true }).tap();
  await page.getByRole("button", { name: "Add to plan", exact: true }).tap();
  await expect(page.getByTestId("planned-mus-101")).toBeVisible();
  await expect(page.locator(".total-credits")).toContainText("1");
  await page.evaluate(() =>
    localStorage.setItem("fieldnotes-plan-v1", "invalid"),
  );
  await page.reload();
  await expect(page.getByRole("button", { name: "Start fresh" })).toBeVisible();
  expect(
    await page.evaluate(() => localStorage.getItem("fieldnotes-plan-v1")),
  ).toBe("invalid");
  await page.getByRole("button", { name: "Start fresh" }).tap();
  expect(
    await page.evaluate(
      () =>
        JSON.parse(localStorage.getItem("fieldnotes-plan-v1") || "{}").version,
    ),
  ).toBe(1);
  await context.close();
});

test('CSV topics stay distinct and source notes appear without invented credits', async ({page}) => {
 await page.getByRole('textbox',{name:'Search courses'}).fill('ADS-295');
 await expect(page.locator('.catalog-card')).toHaveCount(5);
 const islands=page.locator('.catalog-card').filter({hasText:"Africa's Islands"});
 await islands.getByRole('button',{name:'Add ADS 295',exact:true}).click();
 const dialog=page.getByRole('dialog');
 await expect(dialog).toContainText('Second-year standing');
 await expect(dialog).toContainText('System Requisites field says None.');
 await expect(dialog).toContainText('4 credits');
 await expect(dialog).toContainText('Spring 2027');
 await expect(dialog).toContainText('Contrary to the popular colonial logic');
 await page.screenshot({path:'../artifacts/catalog-notes.png'});
 await page.getByRole('button',{name:'Add to plan',exact:true}).click();
 await page.locator('.catalog-card').filter({hasText:'Soccer & African Diaspora'}).getByRole('button',{name:'Add ADS 295',exact:true}).click();
 await page.getByRole('button',{name:'Add to plan',exact:true}).click();
 await expect(page.getByTestId('semester-0').locator('.planned-card')).toHaveCount(2);
 await page.reload();await expect(page.getByTestId('semester-0').locator('.planned-card')).toHaveCount(2);
 await page.getByLabel('Filter by level').selectOption('400');await page.getByRole('textbox',{name:'Search courses'}).fill('');
 await expect(page.locator('.catalog-card').first()).toBeVisible();
});

test('legacy missing courses remain recoverable without fabricated totals',async({page})=>{
 await page.evaluate(()=>localStorage.setItem('fieldnotes-plan-v1',JSON.stringify({version:1,startYear:2026,entries:[{id:'legacy',courseId:'tut-100',semesterId:'semester-0'},{id:'existing',courseId:'csc-151',semesterId:'semester-1'}]})));
 await page.reload();await expect(page.getByText('Not in this catalog: tut-100')).toBeVisible();
 await expect(page.getByTestId('planned-csc-151')).toContainText('Functional Prob Solving w/lab');
 await expect(page.locator('.total-credits')).toContainText('Credits unavailable');
 await page.getByRole('button',{name:'Remove unavailable tut-100'}).click();await expect(page.getByTestId('planned-tut-100')).toHaveCount(0);
 await page.getByRole('button',{name:'Undo last change'}).click();await expect(page.getByTestId('planned-tut-100')).toBeVisible();
});

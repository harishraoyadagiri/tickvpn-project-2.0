/* Drives the real frontend in Chromium against the real backend. */
const { chromium } = require("playwright");

const FE = "http://localhost:3000";
const consoleErrors = [];
const failedRequests = [];
const netLog = [];

let pass = 0, fail = 0;
const check = (c, label, detail = "") => {
  if (c) { pass++; console.log(`  PASS  ${label}${detail ? "  — " + detail : ""}`); }
  else { fail++; console.log(`  FAIL  ${label}${detail ? "  — " + detail : ""}`); }
};
const head = (s) => console.log(`\n${"─".repeat(74)}\n${s}\n${"─".repeat(74)}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome", args: ["--no-sandbox"] });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();

  page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });
  page.on("requestfailed", (r) => failedRequests.push(`${r.method()} ${r.url()} :: ${r.failure()?.errorText}`));
  page.on("response", (r) => { if (r.url().includes(":3001")) netLog.push(`${r.status()} ${r.request().method()} ${r.url().replace("http://localhost:3001","")}`); });

  // ─────────── landing page ───────────
  head("1  LANDING PAGE");
  await page.goto(FE, { waitUntil: "networkidle", timeout: 30000 });
  const title = await page.title();
  const h1 = await page.locator("h1").first().innerText().catch(() => "(none)");
  check(true, "landing page rendered", `title="${title}"  h1="${h1.replace(/\n/g, " ")}"`);
  await page.screenshot({ path: "/tmp/shots/01-landing.png", fullPage: true });

  // does the landing page show pricing pulled from the API?
  const bodyText = await page.locator("body").innerText();
  check(/\$\s?0?\.?\d/.test(bodyText), "pricing is visible on the landing page");

  // ─────────── login ───────────
  head("2  LOGIN  (this is where CORS shows up)");
  await page.goto(FE + "/login", { waitUntil: "networkidle" });
  await page.fill("#email", "uitest@tickvpn.test");
  netLog.length = 0; consoleErrors.length = 0; failedRequests.length = 0;
  await page.click('button:has-text("Continue")');
  await sleep(3000);
  await page.screenshot({ path: "/tmp/shots/02-login.png", fullPage: true });

  console.log("  network to backend:", netLog.length ? netLog.join(" | ") : "(nothing reached it)");
  if (failedRequests.length) console.log("  failed requests:", failedRequests.slice(0, 3).join(" | "));
  if (consoleErrors.length) console.log("  console errors :", consoleErrors.slice(0, 3).join(" | "));

  const afterLogin = await page.locator("body").innerText();
  const reachedTokenStep = afterLogin.includes("Check your email");
  check(reachedTokenStep, "POST /auth/login succeeded from the browser",
        reachedTokenStep ? "" : "page still shows: " + afterLogin.slice(0, 120).replace(/\n/g, " "));

  if (!reachedTokenStep) {
    console.log("\n  >>> Blocked here. Dumping diagnosis and stopping.");
    console.log("  visible error:", afterLogin.match(/Something went wrong.*|.*rate limited.*/i)?.[0] ?? "(none)");
    await browser.close();
    console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
    process.exit(1);
  }

  // ─────────── verify + dashboard ───────────
  head("3  VERIFY TOKEN AND LAND ON THE DASHBOARD");
  await page.click('button:has-text("Verify")');
  await page.waitForURL("**/dashboard", { timeout: 15000 }).catch(() => {});
  await sleep(2500);
  check(page.url().includes("/dashboard"), "redirected to the dashboard", page.url());
  await page.screenshot({ path: "/tmp/shots/03-dashboard.png", fullPage: true });
  const dash = await page.locator("body").innerText();
  console.log("  dashboard text:", dash.slice(0, 220).replace(/\n+/g, " | "));

  // ─────────── regions ───────────
  head("4  REGIONS AND DEVICE CREATION");
  await page.goto(FE + "/dashboard/devices", { waitUntil: "networkidle" });
  await sleep(1500);
  await page.click('button:has-text("Add a device")').catch(() => {});
  await sleep(800);
  const pills = await page.locator(".region-pill").allInnerTexts();
  check(pills.length === 3, "all three regions render as choices", JSON.stringify(pills));
  await page.screenshot({ path: "/tmp/shots/04-regions.png", fullPage: true });

  if (pills.length) {
    // pick the LAST region, so we prove the choice is actually honoured
    const chosen = pills[pills.length - 1];
    await page.locator(".region-pill").last().click();
    await page.fill("#dname", "UI test laptop");
    netLog.length = 0;
    await page.click('button:has-text("Generate & add")');
    await sleep(4000);
    await page.screenshot({ path: "/tmp/shots/05-config.png", fullPage: true });
    const after = await page.locator("body").innerText();
    console.log("  backend calls:", netLog.join(" | "));

    const hasConfig = after.includes("[Interface]") && after.includes("PrivateKey");
    check(hasConfig, "a WireGuard config was produced in the browser");

    const cfg = await page.locator(".config-box").innerText().catch(() => "");
    const endpoint = cfg.match(/Endpoint = (.+)/)?.[1] ?? "";
    const address = cfg.match(/Address = (.+)/)?.[1] ?? "";
    console.log(`  chose region "${chosen}" -> endpoint ${endpoint}, address ${address}`);
    check(!!endpoint && !!address, "config carries a server endpoint and tunnel address");

    // did it actually land on the chosen region's node?
    const devText = await page.locator(".device-row").last().innerText().catch(() => "");
    check(devText.includes(chosen), `the device is on the region I picked (${chosen})`,
          devText.replace(/\n/g, " "));
  }

  // ─────────── other pages ───────────
  head("5  REMAINING PAGES");
  for (const [path, name] of [["/dashboard/billing", "billing"], ["/dashboard/discover", "discover"]]) {
    consoleErrors.length = 0;
    await page.goto(FE + path, { waitUntil: "networkidle" }).catch(() => {});
    await sleep(2000);
    const txt = await page.locator("body").innerText().catch(() => "");
    const broken = txt.includes("Application error") || txt.includes("Unhandled Runtime Error") || txt.trim().length < 40;
    check(!broken, `${name} page renders`, broken ? txt.slice(0, 140).replace(/\n/g, " ") : `${txt.length} chars`);
    await page.screenshot({ path: `/tmp/shots/06-${name}.png`, fullPage: true });
    if (consoleErrors.length) console.log(`    console errors on ${name}:`, consoleErrors.slice(0, 2).join(" | "));
  }

  head(`RESULT: ${pass} passed, ${fail} failed`);
  await browser.close();
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error("HARNESS ERROR:", e.message); process.exit(1); });

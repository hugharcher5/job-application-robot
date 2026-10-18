import { answerFields, researchJob, testConnection, writeCoverLetter } from "./claude.js";
import { letterPdf } from "./pdf.js";
import { markApplied } from "./notion.js";

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });

const progress = (tabId, text) => chrome.runtime.sendMessage({ type: "progress", tabId, text }).catch(() => {});

async function inject(tabId) {
  try {
    await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, files: ["content.js"] });
  } catch {
    // One refusing frame fails the whole call, so inject frame by frame instead.
    const frames = (await chrome.webNavigation.getAllFrames({ tabId }).catch(() => null)) || [{ frameId: 0 }];
    await Promise.all(
      frames.map((f) =>
        chrome.scripting.executeScript({ target: { tabId, frameIds: [f.frameId] }, files: ["content.js"] }).catch(() => {})
      )
    );
  }
}

// Scan every frame and merge their fields, prefixing ids with the frame id.
async function scanTab(tabId) {
  const frames = (await chrome.webNavigation.getAllFrames({ tabId }).catch(() => null)) || [{ frameId: 0 }];
  // One frame at a time: scanning opens dropdowns, which close when focus moves.
  const scans = [];
  for (const f of frames) {
    const r = await chrome.tabs.sendMessage(tabId, { type: "scan" }, { frameId: f.frameId }).catch(() => null);
    if (r && Array.isArray(r.fields)) scans.push({ ...r, frameId: f.frameId });
  }
  const ok = scans;
  if (!ok.length) throw new Error("Couldn't read this page. Reload it and press Fill again.");
  const top = ok.find((s) => s.frameId === 0) || ok[0];
  const fields = [];
  const flags = { login: false, captcha: false, submitted: false };
  for (const s of ok) {
    for (const f of s.fields || []) fields.push({ ...f, id: `${s.frameId}|${f.id}` });
    for (const k of Object.keys(flags)) flags[k] ||= !!s.flags?.[k];
  }
  const text = ok
    .sort((a, b) => a.frameId - b.frameId)
    .map((s) => s.pageText)
    .join("\n\n")
    .slice(0, 30000);
  return { page: { url: top?.url || "", title: top?.title || "", ats: top?.ats || "generic", text }, fields, flags };
}

function byFrame(items) {
  const groups = new Map();
  for (const item of items) {
    const [frame, id] = item.id.split("|");
    if (!groups.has(frame)) groups.set(frame, []);
    groups.get(frame).push({ ...item, id });
  }
  return groups;
}

async function fillInFrames(tabId, answers, files, fieldInfo) {
  const results = [];
  for (const [frame, list] of byFrame(answers)) {
    // Only send the files this frame actually needs.
    const needed = {};
    for (const a of list) {
      if (fieldInfo.get(`${frame}|${a.id}`)?.type === "file" && files[a.value]) needed[a.value] = files[a.value];
    }
    let res = await chrome.tabs
      .sendMessage(tabId, { type: "fill", answers: list, files: needed }, { frameId: Number(frame) })
      .catch((e) => list.map((a) => ({ id: a.id, ok: false, error: String(e.message || e) })));
    if (!Array.isArray(res)) res = list.map((a) => ({ id: a.id, ok: false, error: "the page didn't respond" }));
    results.push(...res.map((r) => ({ ...r, id: `${frame}|${r.id}` })));
  }
  return results;
}

async function loadFiles() {
  const { cv, transcript } = await chrome.storage.local.get(["cv", "transcript"]);
  const files = {};
  if (cv) files.cv = cv;
  if (transcript) files.transcript = transcript;
  return files;
}

async function makeCoverLetter(tabId, page, company, role) {
  const { profile, letterExamples } = await chrome.storage.local.get(["profile", "letterExamples"]);
  progress(tabId, "Reading the job listing…");
  let brief = "";
  try {
    brief = await researchJob({ page, company, role });
  } catch (e) {
    // Web search may be switched off for the API key's organisation; write from the page instead.
    progress(tabId, `Couldn't look up the listing (${e.message}). Writing from this page…`);
  }
  progress(tabId, "Writing a cover letter…");
  const letter = await writeCoverLetter({ profile, examples: letterExamples, page, company, role, brief });
  const dataUrl = await letterPdf(letter);
  const who = letter.name
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w[0] + w.slice(1).toLowerCase())
    .join(" ");
  const name = `${who || "Cover"} Cover Letter - ${company || "Application"}.pdf`.replace(/[\\/:*?"<>|]/g, "");
  const file = { name, type: "application/pdf", dataUrl };
  await chrome.storage.session.set({ [`letter:${tabId}`]: file });
  return file;
}

// Sections whose rows the profile can fill.
const PROFILE_SECTIONS = /experience|employment|work history|education|certif|licen|qualification|language/i;

async function fillTab(tabId) {
  const { profile } = await chrome.storage.local.get("profile");
  if (!profile?.trim()) throw new Error("Add your profile under Settings first.");

  progress(tabId, "Reading the form…");
  await inject(tabId);
  let scan = await scanTab(tabId);
  const fillable = scan.fields.filter((f) => f.type !== "button");
  if (!fillable.length) {
    return { page: scan.page, flags: scan.flags, items: [], message: "No form fields found on this page." };
  }

  const files = await loadFiles();
  const allAnswers = new Map();
  const allResults = new Map();
  const fieldInfo = new Map(scan.fields.map((f) => [f.id, f]));
  let company = "";
  let role = "";
  let pending = scan.fields;

  for (let round = 0; round < 4 && pending.length; round++) {
    progress(tabId, round ? "Filling the new rows…" : `Asking Claude about ${pending.length} fields…`);
    const filesAvailable = [...Object.keys(files), "cover_letter"];
    const alreadyFilled = [...allAnswers.values()]
      .filter((a) => a.value && a.status !== "skip" && a.status !== "no_answer")
      .map((a) => ({ label: fieldInfo.get(a.id)?.label, value: a.value }));
    const out = await answerFields({ profile, page: scan.page, fields: pending, filesAvailable, alreadyFilled });
    company ||= out.company;
    role ||= out.role;

    const known = new Set(pending.map((f) => f.id));
    const answers = out.answers.filter((a) => known.has(a.id));
    for (const a of answers) allAnswers.set(a.id, a);

    if (answers.some((a) => a.status !== "skip" && a.value === "cover_letter" && fieldInfo.get(a.id)?.type === "file")) {
      try {
        files.cover_letter = await makeCoverLetter(tabId, scan.page, company, role);
      } catch (e) {
        progress(tabId, `Cover letter failed: ${e.message}`);
      }
    }

    const toFill = answers.filter((a) => (a.status === "fill" || a.status === "review") && a.value !== "");
    progress(tabId, `Filling ${toFill.length} fields…`);
    for (const r of await fillInFrames(tabId, toFill, files, fieldInfo)) allResults.set(r.id, r);

    // Press the "Add" buttons Claude asked for (an id repeated once per extra row), then fill the new rows.
    let clicks = out.clicks.filter((id) => fieldInfo.get(id)?.type === "button");
    // First pass and Claude added nothing: open one row in each profile-backed section anyway.
    if (!clicks.length && round === 0) {
      clicks = pending
        .filter((f) => f.type === "button" && PROFILE_SECTIONS.test(`${f.section || ""} ${f.label}`))
        .map((f) => f.id);
    }
    if (!clicks.length) break;
    for (const [frame, list] of byFrame(clicks.map((id) => ({ id })))) {
      await chrome.tabs.sendMessage(tabId, { type: "click", ids: list.map((x) => x.id) }, { frameId: Number(frame) }).catch(() => {});
    }
    await new Promise((r) => setTimeout(r, 800));
    scan = await scanTab(tabId);
    pending = scan.fields.filter((f) => !fieldInfo.has(f.id));
    for (const f of pending) fieldInfo.set(f.id, f);
    if (!pending.length) break;
    // Keep the Add buttons in view so Claude can open further rows next round.
    pending.push(...scan.fields.filter((f) => f.type === "button" && !pending.includes(f)));
  }

  // One more try for fields the form wouldn't accept: fresh options plus the reason it failed.
  const failed = [...allResults.values()].filter((r) => !r.ok && fieldInfo.get(r.id)?.type !== "file");
  if (failed.length) {
    progress(tabId, `Retrying ${failed.length} field${failed.length === 1 ? "" : "s"}…`);
    const rescan = await scanTab(tabId);
    const fresh = new Map(rescan.fields.map((f) => [f.id, f]));
    const retry = failed
      .filter((r) => fresh.has(r.id))
      .map((r) => ({ ...fresh.get(r.id), previous: { value: allAnswers.get(r.id)?.value || "", error: r.error } }));
    if (retry.length) {
      const out = await answerFields({ profile, page: rescan.page, fields: retry, filesAvailable: [...Object.keys(files), "cover_letter"] });
      const known = new Set(retry.map((f) => f.id));
      const answers = out.answers.filter((a) => known.has(a.id));
      for (const a of answers) allAnswers.set(a.id, a);
      for (const f of retry) fieldInfo.set(f.id, fresh.get(f.id));
      const toFill = answers.filter((a) => (a.status === "fill" || a.status === "review") && a.value !== "");
      for (const r of await fillInFrames(tabId, toFill, files, fieldInfo)) allResults.set(r.id, r);
    }
  }

  const items = [];
  for (const [id, a] of allAnswers) {
    const f = fieldInfo.get(id);
    if (!f || f.type === "button") continue;
    const empty = !f.current || (f.type === "checkbox" && f.current !== "true");
    if (a.status === "skip") {
      // A required field left empty still needs the user.
      if (f.required && empty) {
        items.push({ id, label: f.label || "(unlabelled field)", required: true, value: "", note: a.note || "Required and left empty", group: "missing" });
      }
      continue;
    }
    const r = allResults.get(id);
    let group;
    let note = a.note;
    if (a.status === "no_answer" || a.value === "") group = "missing";
    else if (r && !r.ok) {
      group = "missing";
      note = `Couldn't fill: ${r.error}`;
    } else if (r?.warn) {
      group = "review";
      note = r.warn;
    } else if (f.maxLength && a.value.length > f.maxLength) {
      group = "review";
      note = `Longer than the ${f.maxLength}-character limit`;
    } else group = a.status === "review" ? "review" : "done";
    const shown = f.type === "file" && files[a.value] ? files[a.value].name : a.value;
    items.push({ id, label: f.label || "(unlabelled field)", required: !!f.required, value: shown, note, group });
  }
  // Required fields Claude never answered.
  for (const f of fieldInfo.values()) {
    const empty = !f.current || (f.type === "checkbox" && f.current !== "true");
    if (f.type !== "button" && f.required && !allAnswers.has(f.id) && empty) {
      items.push({ id: f.id, label: f.label, required: true, value: "", note: "Not answered", group: "missing" });
    }
  }
  return { page: scan.page, flags: scan.flags, company, role, items, letter: !!files.cover_letter };
}

async function downloadLetter(tabId) {
  const key = `letter:${tabId}`;
  let file = (await chrome.storage.session.get(key))[key];
  if (!file) {
    await inject(tabId);
    const scan = await scanTab(tabId);
    const { lastReport } = await chrome.storage.session.get("lastReport");
    const company = lastReport?.tabId === tabId ? lastReport.company : "";
    const role = lastReport?.tabId === tabId ? lastReport.role : "";
    file = await makeCoverLetter(tabId, scan.page, company || scan.page.title, role || scan.page.title);
  }
  // Downloads\Cover Letters is a junction to Employment\Cover Letters (extensions
  // can only save inside the Downloads folder)
  await chrome.downloads.download({ url: file.dataUrl, filename: `Cover Letters/${file.name}`, saveAs: false });
  return file.name;
}

// Keep the service worker awake while a long Claude call is running.
async function keepAlive(work) {
  const timer = setInterval(() => chrome.runtime.getPlatformInfo(), 20000);
  try {
    return await work();
  } finally {
    clearInterval(timer);
  }
}

// ---------- auto-advance: fill, press Next, repeat (never Submit) ----------

const MAX_PAGES = 12;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The form's field labels across frames: changes when a new page loads, not when
// validation errors appear on the same page.
async function pageSignature(tabId) {
  const frames = (await chrome.webNavigation.getAllFrames({ tabId }).catch(() => null)) || [{ frameId: 0 }];
  const parts = [];
  for (const f of frames) {
    const s = await chrome.tabs.sendMessage(tabId, { type: "signature" }, { frameId: f.frameId }).catch(() => null);
    if (s) parts.push(s);
  }
  return parts.join("\n");
}

async function clickNext(tabId) {
  const frames = (await chrome.webNavigation.getAllFrames({ tabId }).catch(() => null)) || [{ frameId: 0 }];
  for (const f of frames) {
    if (await chrome.tabs.sendMessage(tabId, { type: "advance" }, { frameId: f.frameId }).catch(() => false)) return true;
  }
  return false;
}

// Waits for the next page's form to appear. False if it never did (usually a validation error).
async function waitForNewPage(tabId, before) {
  for (let i = 0; i < 20; i++) {
    await sleep(750);
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (tab?.status !== "complete") continue;
    await inject(tabId);
    const now = await pageSignature(tabId);
    if (now && now !== before) {
      await sleep(800); // let the new page finish rendering its widgets
      return true;
    }
  }
  return false;
}

// Stop and hand over when the user is needed on this page.
const needsUser = (report) =>
  report.flags?.login || report.flags?.captcha || report.flags?.submitted || report.items.some((i) => i.group === "missing" && i.required);

async function remember(tabId, report) {
  // Remember what the robot put in each field, so learning only keeps the user's changes.
  const answered = {};
  for (const it of report.items) if (it.value) answered[learnKey(it.label)] = it.value;
  const { [`answered:${tabId}`]: earlier = {} } = await chrome.storage.session.get(`answered:${tabId}`);
  await chrome.storage.session.set({ lastReport: { ...report, tabId }, [`answered:${tabId}`]: { ...earlier, ...answered } });
}

const handlers = {
  testConnection: () => testConnection(),
  fill: async ({ tabId, autoAdvance }) => {
    let report;
    for (let page = 1; page <= MAX_PAGES; page++) {
      report = await fillTab(tabId);
      report.pages = page;
      await remember(tabId, report);
      if (!autoAdvance || needsUser(report)) break;
      const before = await pageSignature(tabId);
      if (!(await clickNext(tabId))) break; // last page: Submit is the user's
      progress(tabId, `Page ${page} done. Moving to the next page…`);
      if (!(await waitForNewPage(tabId, before))) {
        report.stuck = `Filled ${page} page${page === 1 ? "" : "s"}, but the form didn't move on. Check this page for errors.`;
        break;
      }
    }
    return report;
  },
  focus: async ({ tabId, id }) => {
    const [frame, local] = id.split("|");
    await chrome.tabs.sendMessage(tabId, { type: "focus", id: local }, { frameId: Number(frame) });
  },
  letter: ({ tabId }) => downloadLetter(tabId),
  notion: async () => {
    const { lastReport } = await chrome.storage.session.get("lastReport");
    if (!lastReport?.company) throw new Error("Fill an application first so I know the firm and role.");
    return markApplied(lastReport.company, lastReport.role);
  },
};

// ---------- learning: fold the user's own answers into the profile ----------

const LEARNED_HEAD = "## Learned answers";
const LEARNED_NOTE =
  "(Added automatically from answers I typed or changed on application forms. These are my own answers: for the same question, they override anything above.)";
const MAX_LEARNED = 150;
const learnKey = (s) => String(s || "").toLowerCase().replace(/[*:?]+\s*$/, "").replace(/\s+/g, " ").trim();
// Contact details are already in the profile and differ by form layout, not by answer.
const NOT_LEARNED = /\b(password|e-?mail|phone|mobile|first name|last name|surname|full name|address|post ?code|zip|signature|today'?s date|captcha|linkedin|website)\b/i;

function splitProfile(profile) {
  const at = profile.indexOf(`\n${LEARNED_HEAD}`);
  if (at < 0) return { base: profile.trimEnd(), learned: new Map() };
  const learned = new Map();
  for (const line of profile.slice(at).split("\n")) {
    const m = line.match(/^- (.+?) → (.+)$/);
    if (m) learned.set(learnKey(m[1]), { q: m[1], a: m[2] });
  }
  return { base: profile.slice(0, at).trimEnd(), learned };
}

async function learnFrom(tabId, entries) {
  const key = `answered:${tabId}`;
  const { [key]: answered = {} } = await chrome.storage.session.get(key);
  const { profile = "" } = await chrome.storage.local.get("profile");
  if (!profile.trim()) return;
  const { base, learned } = splitProfile(profile);
  let added = 0;
  for (const { label, value } of entries) {
    const k = learnKey(label);
    const q = label.replace(/\s*[*:]+\s*$/, "").replace(/→/g, "->").replace(/\s+/g, " ").slice(0, 150);
    const a = value.replace(/\s+/g, " ").replace(/→/g, "->").slice(0, 200);
    if (!k || NOT_LEARNED.test(k)) continue;
    // Keep only what the user supplied or corrected, not the robot's own answers
    // (including its closest-option picks, e.g. "White – Irish" filled as "White").
    const robot = (answered[k] || "").toLowerCase();
    const mine = a.toLowerCase();
    // Matching the robot only counts as "nothing new" if there's no older learned answer it replaces.
    if (robot && (robot === mine || robot.includes(mine) || mine.includes(robot)) && !learned.has(k)) continue;
    if (learned.get(k)?.a === a) continue;
    learned.delete(k); // re-insert so the newest answers sit at the bottom
    learned.set(k, { q, a });
    added++;
  }
  if (!added) return;
  const kept = [...learned.values()].slice(-MAX_LEARNED);
  const section = [LEARNED_HEAD, LEARNED_NOTE, ...kept.map(({ q, a }) => `- ${q} → ${a}`)].join("\n");
  await chrome.storage.local.set({ profile: `${base}\n\n${section}\n` });
  progress(tabId, `Learned ${added} answer${added === 1 ? "" : "s"} from this form and added them to your profile.`);
}

// Content scripts report the user's final answers when they press Submit / Next.
chrome.runtime.onMessage.addListener((msg, sender) => {
  if (sender.id !== chrome.runtime.id || !sender.tab || msg?.type !== "learn" || !Array.isArray(msg.entries)) return;
  learnFrom(sender.tab.id, msg.entries.slice(0, 200)).catch(() => {});
});

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  // Only the extension's own pages may drive it.
  if (sender.id !== chrome.runtime.id || sender.tab) return;
  const handler = handlers[msg.type];
  if (!handler) return;
  keepAlive(() => handler(msg))
    .then((result) => reply({ ok: true, result }))
    .catch((err) => reply({ ok: false, error: String(err?.message || err) }));
  return true;
});

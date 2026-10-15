import { answerFields, testConnection, writeCoverLetter } from "./claude.js";
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
  progress(tabId, "Writing a cover letter…");
  const letter = await writeCoverLetter({ profile, examples: letterExamples, page, company, role });
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

  for (let round = 0; round < 3 && pending.length; round++) {
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

    // Press "Add another" buttons Claude asked for, then fill the new fields.
    const clicks = out.clicks.filter((id) => fieldInfo.get(id)?.type === "button");
    if (!clicks.length) break;
    for (const [frame, list] of byFrame(clicks.map((id) => ({ id })))) {
      await chrome.tabs.sendMessage(tabId, { type: "click", ids: list.map((x) => x.id) }, { frameId: Number(frame) }).catch(() => {});
    }
    await new Promise((r) => setTimeout(r, 800));
    scan = await scanTab(tabId);
    pending = scan.fields.filter((f) => !fieldInfo.has(f.id));
    for (const f of pending) fieldInfo.set(f.id, f);
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

const handlers = {
  testConnection: () => testConnection(),
  fill: async ({ tabId }) => {
    const report = await fillTab(tabId);
    await chrome.storage.session.set({ lastReport: { ...report, tabId } });
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

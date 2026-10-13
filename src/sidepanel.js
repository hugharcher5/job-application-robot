const $ = (id) => document.getElementById(id);
const status = (text) => ($("status").textContent = text);
let currentTabId = null;

async function activeTabId() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab?.id;
}

async function call(type, extra = {}) {
  const res = await chrome.runtime.sendMessage({ type, ...extra });
  if (!res) throw new Error("The extension didn't respond. Reload it and try again.");
  if (!res.ok) throw new Error(res.error);
  return res.result;
}

const GROUPS = [
  ["missing", "No answer"],
  ["review", "Needs review"],
  ["done", "Done"],
];

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

function render(report) {
  const box = $("report");
  box.replaceChildren();
  const banner = $("banner");
  const warnings = [];
  if (report.flags?.login) warnings.push("This page wants a login. Sign in yourself, then press Fill again.");
  if (report.flags?.captcha) warnings.push("There's a CAPTCHA on this page. Solve it yourself before submitting.");
  if (report.flags?.submitted) warnings.push("This looks submitted. Press Mark applied to update Notion.");
  banner.hidden = !warnings.length;
  banner.textContent = warnings.join(" ");

  if (report.message) return status(report.message);
  const counts = Object.fromEntries(GROUPS.map(([g]) => [g, report.items.filter((i) => i.group === g).length]));
  status(
    `${report.company || "Form"}${report.role ? ` · ${report.role}` : ""}: ${counts.done} done, ${counts.review} to review, ${counts.missing} unanswered`
  );

  for (const [group, title] of GROUPS) {
    const items = report.items.filter((i) => i.group === group);
    if (!items.length) continue;
    const section = el("div", `group ${group}`);
    const h = el("h2");
    h.append(el("span", "dot"), document.createTextNode(title), el("span", "count", String(items.length)));
    section.append(h);
    for (const item of items) {
      const b = el("button", "item");
      b.title = "Show this field on the page";
      const label = el("span", "label", item.label);
      if (item.required) label.append(el("span", "req", " *"));
      b.append(label);
      if (item.value) b.append(el("span", "value", item.value));
      if (item.note) b.append(el("span", "note", item.note));
      b.onclick = () => call("focus", { tabId: currentTabId, id: item.id }).catch(() => {});
      section.append(b);
    }
    box.append(section);
  }
}

async function busy(button, fn) {
  const buttons = document.querySelectorAll("button");
  buttons.forEach((b) => (b.disabled = true));
  try {
    await fn();
  } catch (e) {
    status(e.message);
  } finally {
    buttons.forEach((b) => (b.disabled = false));
  }
}

$("fill").onclick = () =>
  busy($("fill"), async () => {
    currentTabId = await activeTabId();
    $("report").replaceChildren();
    status("Starting…");
    render(await call("fill", { tabId: currentTabId }));
  });

$("letter").onclick = () =>
  busy($("letter"), async () => {
    const tabId = await activeTabId();
    status("Preparing cover letter…");
    status(`Saved to Downloads: ${await call("letter", { tabId })}`);
  });

$("notion").onclick = () =>
  busy($("notion"), async () => {
    status("Updating Notion…");
    status(await call("notion"));
  });

$("saveKey").onclick = async () => {
  const apiKey = $("apiKey").value.trim();
  if (!apiKey) return status("Paste a key first.");
  await chrome.storage.local.set({ apiKey });
  $("apiKey").value = "";
  status("API key saved.");
};

$("testKey").onclick = () =>
  busy($("testKey"), async () => {
    status("Testing…");
    status(`Connected (${await call("testConnection")})`);
  });

async function readFile(input) {
  const file = input.files?.[0];
  if (!file) return null;
  const dataUrl = await new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
  return { name: file.name, type: file.type, dataUrl };
}

$("saveSettings").onclick = async () => {
  const update = {
    profile: $("profile").value,
    letterExamples: $("letterExamples").value,
    notionDatabaseId: $("notionDatabaseId").value.trim().replace(/-/g, ""),
  };
  if ($("notionToken").value.trim()) update.notionToken = $("notionToken").value.trim();
  for (const key of ["cv", "transcript"]) {
    const f = await readFile($(key));
    if (f) update[key] = f;
  }
  await chrome.storage.local.set(update);
  $("notionToken").value = "";
  await loadSettings();
  status("Settings saved.");
};

async function loadSettings() {
  const s = await chrome.storage.local.get(["profile", "letterExamples", "notionDatabaseId", "cv", "transcript"]);
  $("profile").value = s.profile || "";
  $("letterExamples").value = s.letterExamples || "";
  $("notionDatabaseId").value = s.notionDatabaseId || "";
  $("cvName").textContent = s.cv ? `(saved: ${s.cv.name})` : "";
  $("transcriptName").textContent = s.transcript ? `(saved: ${s.transcript.name})` : "";
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === "progress" && (!currentTabId || msg.tabId === currentTabId)) status(msg.text);
});

loadSettings();
activeTabId().then(async (tabId) => {
  currentTabId = tabId;
  const { lastReport } = await chrome.storage.session.get("lastReport");
  if (lastReport?.tabId === tabId) render(lastReport);
});

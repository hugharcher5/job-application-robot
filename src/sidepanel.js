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
  if (report.stuck) warnings.push(report.stuck);
  banner.hidden = !warnings.length;
  banner.textContent = warnings.join(" ");

  if (report.message) return status(report.message);
  const counts = Object.fromEntries(GROUPS.map(([g]) => [g, report.items.filter((i) => i.group === g).length]));
  status(
    `${report.company || "Form"}${report.role ? ` · ${report.role}` : ""}${report.pages > 1 ? ` (page ${report.pages})` : ""}: ${counts.done} done, ${counts.review} to review, ${counts.missing} unanswered`
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

// Brief confirmation on the button itself, since the status line can be off-screen.
function confirmOn(button, text) {
  const original = button.dataset.label || button.textContent;
  button.dataset.label = original;
  button.textContent = text;
  setTimeout(() => (button.textContent = original), 2000);
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
    const autoAdvance = $("autoAdvance").checked;
    await chrome.storage.local.set({ autoAdvance });
    render(await call("fill", { tabId: currentTabId, autoAdvance }));
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
  confirmOn($("saveKey"), "Saved ✓");
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

const LEARNED_HEAD = "\n## Learned answers";

// Pasting a fresh profile shouldn't wipe the answers the robot has learned.
async function withLearned(profile) {
  if (profile.includes(LEARNED_HEAD)) return profile;
  const { profile: old = "" } = await chrome.storage.local.get("profile");
  const at = old.indexOf(LEARNED_HEAD);
  return at < 0 ? profile : `${profile.trimEnd()}\n${old.slice(at)}`;
}

$("saveSettings").onclick = async () => {
  const update = {
    profile: await withLearned($("profile").value),
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
  confirmOn($("saveSettings"), "Saved ✓");
};

async function loadSettings() {
  const s = await chrome.storage.local.get(["profile", "letterExamples", "notionDatabaseId", "cv", "transcript", "autoAdvance"]);
  $("autoAdvance").checked = s.autoAdvance !== false;
  $("profile").value = s.profile || "";
  $("letterExamples").value = s.letterExamples || "";
  $("notionDatabaseId").value = s.notionDatabaseId || "";
  $("cvName").textContent = s.cv ? `(saved: ${s.cv.name})` : "";
  $("transcriptName").textContent = s.transcript ? `(saved: ${s.transcript.name})` : "";
  const keys = await chrome.storage.local.get(["apiKey", "notionToken"]);
  $("apiKey").placeholder = keys.apiKey ? "Saved ✓ (paste a new key to replace)" : "sk-ant-…";
  $("notionToken").placeholder = keys.notionToken ? "Saved ✓ (paste a new token to replace)" : "secret_… or ntn_…";
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === "progress" && (!currentTabId || msg.tabId === currentTabId)) status(msg.text);
});

// The robot adds learned answers to the profile; show them unless the user is mid-edit.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.profile && document.activeElement !== $("profile")) {
    $("profile").value = changes.profile.newValue || "";
  }
});

loadSettings();
activeTabId().then(async (tabId) => {
  currentTabId = tabId;
  const { lastReport } = await chrome.storage.session.get("lastReport");
  if (lastReport?.tabId === tabId) render(lastReport);
});

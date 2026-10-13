const $ = (id) => document.getElementById(id);
const status = (text) => ($("status").textContent = text);

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

function render(result) {
  const box = $("fields");
  box.replaceChildren();
  for (const f of result.fields) {
    const div = document.createElement("div");
    div.className = "field";
    const label = document.createElement("span");
    label.textContent = f.label || "(no label)";
    if (f.required) label.className = "req";
    const meta = document.createElement("span");
    meta.className = "muted";
    meta.textContent = ` · ${f.type}${f.options ? ` · ${f.options.length} options` : ""}`;
    div.append(label, meta);
    box.append(div);
  }
}

$("scan").onclick = async () => {
  const tab = await activeTab();
  try {
    const result = await chrome.tabs.sendMessage(tab.id, { type: "scan" });
    if (!result) return status("No form found on this page.");
    status(`${result.ats}: ${result.fields.length} fields found`);
    render(result);
  } catch {
    status("This page isn't a supported application site yet.");
  }
};

$("saveKey").onclick = async () => {
  await chrome.storage.local.set({ apiKey: $("apiKey").value.trim() });
  $("apiKey").value = "";
  status("API key saved.");
};

$("testKey").onclick = async () => {
  status("Testing…");
  const res = await chrome.runtime.sendMessage({ type: "testConnection" });
  status(res.ok ? `Connected (${res.text})` : `Failed: ${res.error}`);
};

$("saveProfile").onclick = async () => {
  await chrome.storage.local.set({ profile: $("profile").value });
  status("Profile saved.");
};

chrome.storage.local.get("profile").then(({ profile }) => {
  if (profile) $("profile").value = profile;
});

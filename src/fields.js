// Generic field extraction. ATS-specific adapters will refine this in later phases.

function labelFor(el) {
  if (el.id) {
    const lab = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
    if (lab) return lab.innerText.trim();
  }
  const by = el.getAttribute("aria-labelledby");
  if (by) {
    const text = by.split(/\s+/).map((id) => document.getElementById(id)?.innerText || "").join(" ").trim();
    if (text) return text;
  }
  if (el.getAttribute("aria-label")) return el.getAttribute("aria-label").trim();
  const wrap = el.closest("label");
  if (wrap) return wrap.innerText.trim();
  const group = el.closest("fieldset, .field, [class*='field'], [class*='question']");
  const legend = group?.querySelector("legend, label, [class*='label']");
  return (legend?.innerText || el.placeholder || el.name || "").trim();
}

function visible(el) {
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== "hidden";
}

export function extractFields(root = document) {
  const els = root.querySelectorAll(
    "input:not([type=hidden]):not([type=submit]):not([type=button]), select, textarea, [contenteditable=true], [role=combobox]"
  );
  const fields = [];
  const seenRadioGroups = new Set();
  let n = 0;
  for (const el of els) {
    if (el.type !== "file" && !visible(el)) continue;
    if (el.type === "radio") {
      if (seenRadioGroups.has(el.name)) continue;
      seenRadioGroups.add(el.name);
    }
    const id = el.dataset.jarId || `jar-${n++}`;
    el.dataset.jarId = id;
    const type = el.getAttribute("role") === "combobox" ? "combobox"
      : el.isContentEditable ? "richtext"
      : el.tagName === "SELECT" ? "select"
      : el.tagName === "TEXTAREA" ? "textarea"
      : el.type || "text";
    const field = {
      id,
      label: labelFor(el).slice(0, 300),
      type,
      required: el.required || el.getAttribute("aria-required") === "true",
    };
    if (el.maxLength > 0) field.maxLength = el.maxLength;
    if (type === "select") field.options = [...el.options].map((o) => o.text.trim()).filter(Boolean);
    if (type === "radio") {
      field.options = [...root.querySelectorAll(`input[type=radio][name="${CSS.escape(el.name)}"]`)]
        .map((r) => labelFor(r));
    }
    fields.push(field);
  }
  return fields;
}

// Injected into every frame of the active tab. Reads the form, fills it, and
// reports back. Runs as a classic script and is injected again on every Fill,
// so each copy replaces the previous one (including copies orphaned by an
// extension reload, whose chrome.runtime no longer works).
(() => {
  try {
    window.__jarDispose?.();
  } catch {
    // The old copy's extension context is gone; nothing to remove.
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const norm = (s) => (s || "").replace(/\s+/g, " ").replace(/\s*\*\s*$/, "").trim();
  const low = (s) => norm(s).toLowerCase();

  // id -> { el, kind }. Ids live on the elements (data-jar-id) so they survive
  // re-injection; a per-copy prefix keeps new ids from colliding with old ones.
  const registry = new Map();
  const prefix = Math.random().toString(36).slice(2, 6);
  let counter = 0;

  // ---------- DOM helpers (open shadow roots included, for SmartRecruiters) ----------

  function roots() {
    const list = [document];
    for (let i = 0; i < list.length; i++) {
      for (const e of list[i].querySelectorAll("*")) if (e.shadowRoot) list.push(e.shadowRoot);
    }
    return list;
  }
  const qsa = (sel, scopes = roots()) => scopes.flatMap((r) => [...r.querySelectorAll(sel)]);
  const byId = (el, id) => el.getRootNode().getElementById?.(id) || document.getElementById(id);

  function visible(el) {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return false;
    const cs = getComputedStyle(el);
    return cs.visibility !== "hidden" && cs.display !== "none";
  }

  function textOf(el) {
    return norm(el?.innerText || el?.textContent || "");
  }

  const starred = (n) =>
    !!n && (/\*\s*$/.test((n.textContent || "").trim()) || !!n.querySelector?.("abbr[title*='required' i]"));

  // Returns { text, nodes } where nodes are the elements the label came from.
  function labelInfo(el) {
    const labs = [...(el.labels || [])].filter((l) => textOf(l));
    if (labs.length) return { text: textOf(labs[0]), nodes: labs };
    const by = el.getAttribute("aria-labelledby");
    if (by) {
      const nodes = by.split(/\s+/).map((id) => byId(el, id)).filter(Boolean);
      const text = norm(nodes.map(textOf).join(" "));
      if (text) return { text, nodes };
    }
    if (el.getAttribute("aria-label")) return { text: norm(el.getAttribute("aria-label")), nodes: [] };
    const wrap = el.closest("label");
    if (wrap && textOf(wrap)) return { text: textOf(wrap), nodes: [wrap] };
    const group = el.closest(
      "fieldset, [data-automation-id^='formField'], .field, .application-question, [class*='field'], [class*='question']"
    );
    const head = group?.querySelector("legend, label, [class*='label'], [data-automation-id='promptLabel']");
    if (textOf(head)) return { text: textOf(head), nodes: [head] };
    return { text: norm(el.placeholder) || norm(el.getAttribute("name")) || "", nodes: [] };
  }

  // Text of one radio option (not the question).
  function optionText(r) {
    const lab = [...(r.labels || [])].map(textOf).find(Boolean);
    if (lab) return lab;
    if (r.getAttribute("aria-label")) return norm(r.getAttribute("aria-label"));
    const by = r.getAttribute("aria-labelledby");
    if (by) return norm(by.split(/\s+/).map((id) => textOf(byId(r, id))).join(" "));
    const sib = r.nextElementSibling || r.parentElement?.nextElementSibling;
    return textOf(sib) || norm(r.value);
  }

  // Radios answer one question together. Grouped by name, or by container if unnamed.
  function radioGroup(el) {
    if (el.name) {
      const scope = el.form || el.getRootNode();
      return [...scope.querySelectorAll(`input[type=radio][name="${CSS.escape(el.name)}"]`)];
    }
    const box = el.closest("[role='radiogroup'], fieldset, [role='group']");
    return box ? [...box.querySelectorAll("input[type=radio]")] : [el];
  }

  // The question heading for a radio group (or a checkbox in a group): the
  // nearest preceding label-like element that isn't an option's own label.
  function questionNode(group, maxLevels = 4) {
    const first = group[0];
    const g = first.closest("[role='radiogroup'], [role='group']");
    const by = g?.getAttribute("aria-labelledby");
    if (by) {
      const n = byId(g, by.split(/\s+/)[0]);
      if (textOf(n)) return n;
    }
    const optionLabels = group.flatMap((r) => [...(r.labels || []), r.closest("label")]).filter(Boolean);
    let box = first.parentElement;
    while (box && !group.every((r) => box.contains(r))) box = box.parentElement;
    for (let level = 0; box && level < maxLevels; level++, box = box.parentElement) {
      let best = null;
      for (const n of box.querySelectorAll(
        "legend, label, [class*='label' i], [class*='question' i], [class*='title' i], [data-automation-id='promptLabel'], h2, h3, h4, h5, p"
      )) {
        if (!(n.compareDocumentPosition(first) & Node.DOCUMENT_POSITION_FOLLOWING)) break;
        if (n.querySelector("input, select, textarea")) continue;
        if (optionLabels.some((l) => l === n || l.contains(n) || n.contains(l))) continue;
        if (textOf(n)) best = n;
      }
      if (best) return best;
    }
    return null;
  }

  function kindOf(el) {
    if (el.tagName === "BUTTON") return el.getAttribute("aria-haspopup") === "listbox" ? "listbutton" : "button";
    if (el.tagName === "SELECT") return "select";
    if (el.isContentEditable) return "richtext";
    if (el.getAttribute("role") === "combobox") return "combobox";
    if (el.tagName === "TEXTAREA") return "textarea";
    const t = (el.type || "text").toLowerCase();
    if (["radio", "checkbox", "file", "date", "email", "tel", "url", "number"].includes(t)) return t;
    return "text";
  }

  function currentValue(el, kind) {
    if (kind === "checkbox" || kind === "radio") return el.checked ? "true" : "";
    if (kind === "select") return el.selectedIndex > 0 ? norm(el.options[el.selectedIndex].text) : "";
    if (kind === "listbutton") return textOf(el);
    if (kind === "combobox") {
      const box = el.closest("[class*='container'], [class*='select'], [data-automation-id^='formField']");
      const single = box?.querySelector(
        "[class*='singleValue'], [class*='single-value'], [class*='multiValue'], [data-automation-id='selectedItem']"
      );
      return textOf(single) || norm(el.value);
    }
    if (kind === "richtext") return textOf(el);
    if (kind === "file") return el.files?.length ? el.files[0].name : "";
    return norm(el.value);
  }

  function fireMouse(el) {
    for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"]) {
      const Ctor = type.startsWith("pointer") ? PointerEvent : MouseEvent;
      el.dispatchEvent(new Ctor(type, { bubbles: true, cancelable: true, composed: true, view: window }));
    }
  }

  function key(el, k) {
    const init = { key: k, code: k, bubbles: true, cancelable: true, composed: true };
    if (k === "Enter") Object.assign(init, { keyCode: 13, which: 13 });
    if (k === "Escape") Object.assign(init, { keyCode: 27, which: 27 });
    if (k === "ArrowDown") Object.assign(init, { keyCode: 40, which: 40 });
    el.dispatchEvent(new KeyboardEvent("keydown", init));
    el.dispatchEvent(new KeyboardEvent("keyup", init));
  }

  function listboxFor(el) {
    const id = el.getAttribute("aria-controls") || el.getAttribute("aria-owns");
    const own = id && byId(el, id);
    if (own && visible(own)) return own;
    return qsa("[role='listbox']").find(visible) || null;
  }

  function visibleOptions(el) {
    const lb = listboxFor(el);
    const scopes = lb ? [lb] : roots();
    let opts = qsa("[role='option'], [data-automation-id='promptOption']", scopes).filter(visible);
    // react-select builds without ARIA roles.
    if (!opts.length) opts = qsa("[class*='__option'], [id*='-option-']", scopes).filter(visible);
    opts = opts.filter((o) => o.getAttribute("aria-disabled") !== "true");
    return opts.filter((o) => !opts.some((p) => p !== o && p.contains(o)));
  }

  function closePopup(el) {
    key(el, "Escape");
    el.blur?.();
    // Workday-style popups ignore Escape on the button; an outside click closes them.
    if (qsa("[role='listbox']").some(visible)) fireMouse(document.body);
  }

  async function openAndReadOptions(el, kind) {
    try {
      el.scrollIntoView({ block: "center" });
      el.focus();
      fireMouse(el);
      if (kind === "combobox") key(el, "ArrowDown");
      await sleep(400);
      const opts = visibleOptions(el).map(textOf).filter(Boolean);
      closePopup(el);
      await sleep(100);
      return opts;
    } catch {
      return [];
    }
  }

  const ADD_BUTTON = /^\s*(\+\s*)?add( another)?\b/i;

  function newId(el) {
    let id = el.dataset.jarId;
    if (!id) {
      id = `${prefix}${counter++}`;
      el.dataset.jarId = id;
    }
    return id;
  }

  async function scan() {
    const seen = new Set();
    const fields = [];
    const els = qsa(
      "input:not([type=hidden]):not([type=submit]):not([type=button]):not([type=image]):not([type=reset]):not([type=password]):not([type=search])," +
        "select, textarea, [contenteditable]:not([contenteditable='false']), [role='combobox'], button"
    );
    for (const el of els) {
      if (seen.has(el)) continue;
      seen.add(el);
      const kind = kindOf(el);
      if (kind === "button" && !ADD_BUTTON.test(textOf(el))) continue;
      if (kind === "richtext" && el.parentElement?.isContentEditable) continue; // nested editable
      if (el.disabled) continue;
      if (el.readOnly && kind !== "combobox") continue; // non-searchable react-selects are readOnly
      if (kind !== "file" && el.closest("[aria-hidden='true']")) continue;
      // A combobox input inside react-select is the field; skip its wrapper divs.
      if (kind === "combobox" && el.tagName !== "INPUT" && el.querySelector("input[role='combobox']")) continue;

      const group = kind === "radio" ? radioGroup(el) : null;
      if (group) group.forEach((r) => seen.add(r));
      // Styled radios/checkboxes often hide the native input behind their label.
      const isShown =
        kind === "file" ||
        (group || [el]).some(
          (x) => visible(x) || ((kind === "radio" || kind === "checkbox") && [...(x.labels || [])].some(visible))
        );
      if (!isShown) continue;

      const id = newId(el);
      registry.set(id, { el, kind });

      const info = labelInfo(el);
      const field = { id, type: kind, label: info.text.slice(0, 400) };
      let required = el.required || el.getAttribute("aria-required") === "true" || info.nodes.some(starred);
      if (el.maxLength > 0 && el.maxLength < 100000) field.maxLength = el.maxLength;

      if (kind === "radio") {
        const q = questionNode(group);
        field.label = (textOf(q) || field.label).slice(0, 400);
        field.options = group.map(optionText);
        const chosen = group.find((r) => r.checked);
        if (chosen) field.current = optionText(chosen);
        required =
          group.some((r) => r.required || r.getAttribute("aria-required") === "true") ||
          el.closest("[role='radiogroup']")?.getAttribute("aria-required") === "true" ||
          starred(q);
      } else if (kind === "checkbox") {
        const inGroup =
          el.closest("fieldset, [role='group']") ||
          (el.name && el.getRootNode().querySelectorAll(`input[type=checkbox][name="${CSS.escape(el.name)}"]`).length > 1);
        const q = inGroup ? textOf(questionNode([el], 3)) : "";
        if (q && q !== field.label) field.question = q.slice(0, 300);
        if (el.checked) field.current = "true";
      } else if (kind === "select") {
        field.options = [...el.options].map((o) => norm(o.text)).filter(Boolean);
        const cur = currentValue(el, kind);
        if (cur) field.current = cur;
      } else if (kind === "combobox" || kind === "listbutton") {
        const cur = currentValue(el, kind);
        if (cur) field.current = cur.slice(0, 200);
        const opts = await openAndReadOptions(el, kind);
        if (opts.length) field.options = opts.slice(0, 250);
        if (opts.length > 250 || (kind === "combobox" && !opts.length)) field.typeahead = true;
      } else if (kind === "button") {
        field.label = norm(el.getAttribute("aria-label")) || textOf(el);
        const section = el.closest("section, fieldset, [data-automation-id]");
        const head = section?.querySelector("h2, h3, h4, legend");
        if (head) field.section = textOf(head);
      } else {
        const cur = currentValue(el, kind);
        if (cur) field.current = cur.slice(0, 500);
      }
      if (required && kind !== "button") field.required = true;
      registry.get(id).label = field.label;
      fields.push(field);
    }

    const bodyText = textOf(document.body);
    const captchaFrames = qsa("iframe[src*='recaptcha'], iframe[src*='hcaptcha'], iframe[src*='turnstile']");
    return {
      url: location.href,
      title: document.title,
      ats: detectAts(location.hostname),
      fields,
      pageText: bodyText.slice(0, 20000),
      flags: {
        login: qsa("input[type=password]").some(visible),
        // Invisible reCAPTCHA (on every Greenhouse form) doesn't need the user.
        captcha:
          captchaFrames.some((f) => visible(f) && !/size=invisible/.test(f.src) && f.offsetWidth > 60) ||
          qsa(".g-recaptcha:not([data-size='invisible']), .h-captcha:not([data-size='invisible'])").some(visible),
        submitted:
          /thank you for (applying|your application)|application (has been |was )?(submitted|received)|we('ve| have) received your application/i.test(
            bodyText.slice(0, 5000)
          ),
      },
    };
  }

  function detectAts(host) {
    if (/greenhouse\.io$/.test(host)) return "greenhouse";
    if (/myworkdayjobs\.com$|workday\.com$/.test(host)) return "workday";
    if (/smartrecruiters\.com$/.test(host)) return "smartrecruiters";
    if (/tal\.net$/.test(host)) return "oleeo";
    if (/lever\.co$/.test(host)) return "lever";
    if (/ashbyhq\.com$/.test(host)) return "ashby";
    return "generic";
  }

  // ---------- filling ----------

  const fire = (el, type) => el.dispatchEvent(new Event(type, { bubbles: true, composed: true }));

  // React tracks the last value it saw; the prototype setter bypasses that so
  // React notices the change and fires onChange.
  function setNative(el, value) {
    const proto =
      el.tagName === "TEXTAREA"
        ? HTMLTextAreaElement.prototype
        : el.tagName === "SELECT"
          ? HTMLSelectElement.prototype
          : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value").set;
    el.focus();
    setter.call(el, value);
    fire(el, "input");
    fire(el, "change");
  }

  const PLACEHOLDER = /^(-+|select\b.*|please select.*|choose\b.*|none selected|\.\.\.)$/i;
  // Words that flip or narrow an option's meaning ("No" vs "Not applicable",
  // "Ireland" vs "Northern Ireland"); an option with one the answer lacks loses.
  const QUALIFIERS = ["no", "not", "non", "northern", "never", "without", "dont", "don't", "un"];
  const words = (s) => s.split(/[^\p{L}\p{N}']+/u).filter(Boolean);
  const startsWord = (t, v) => t.startsWith(v) && !/[\p{L}\p{N}]/u.test(t[v.length] || "");
  const hasWords = (t, v) => ` ${words(t).join(" ")} `.includes(` ${words(v).join(" ")} `);

  // Returns { item, exact } or null.
  function bestMatch(items, value, getText = (x) => x) {
    const v = low(value);
    if (!v) return null;
    const texts = items.map((i) => low(getText(i)));
    const exact = texts.findIndex((t) => t === v);
    if (exact >= 0) return { item: items[exact], exact: true };
    const vw = new Set(words(v));
    const penalty = (t) => words(t).filter((w) => QUALIFIERS.includes(w) && !vw.has(w)).length;
    const tiers = [
      (t) => words(t).join(" ") === words(v).join(" "), // same words, different punctuation
      (t) => startsWord(t, v), // "Yes" -> "Yes, I am authorised"
      (t) => t.length >= 2 && startsWord(v, t), // "Yes, I am" -> "Yes"
      (t) => hasWords(t, v), // "Ireland" -> "Republic of Ireland"
      (t) => t.length >= 4 && hasWords(v, t),
    ];
    const usable = texts.map((t) => !!t && !PLACEHOLDER.test(t));
    for (const test of tiers) {
      const hits = texts.map((t, j) => j).filter((j) => usable[j] && test(texts[j]));
      if (hits.length) {
        hits.sort((a, b) => penalty(texts[a]) - penalty(texts[b]) || texts[a].length - texts[b].length);
        if (penalty(texts[hits[0]]) === 0 || hits.length === 1) return { item: items[hits[0]], exact: false };
      }
    }
    // Word overlap as a last resort.
    const vw3 = [...vw].filter((w) => w.length > 2);
    let best = -1;
    let bestScore = 0;
    texts.forEach((t, j) => {
      if (!usable[j]) return;
      const tw = words(t).filter((w) => w.length > 2);
      const hit = tw.filter((w) => vw3.includes(w)).length;
      const score = hit / Math.max(vw3.length, tw.length, 1) - 0.2 * penalty(t);
      if (score > bestScore) [best, bestScore] = [j, score];
    });
    return bestScore >= 0.5 ? { item: items[best], exact: false } : null;
  }

  const picked = (m, text) => (m.exact ? null : { warn: `Picked "${norm(text).slice(0, 60)}"` });

  // "White – Irish" -> ["White – Irish", "White"]: broader fallbacks for when a
  // form only offers the general option.
  function variants(value) {
    const broad = value.split(/\s+[–—-]\s+|\s*\(|\s*\/\s*|,\s*/)[0].trim();
    return broad.length >= 2 && broad !== value ? [value, broad] : [value];
  }

  function bestMatchAny(items, value, getText) {
    for (const v of variants(value)) {
      const m = bestMatch(items, v, getText);
      if (m) return v === value ? m : { ...m, exact: false };
    }
    return null;
  }

  async function pickFromPopup(el, value, kind) {
    el.scrollIntoView({ block: "center" });
    el.focus();
    fireMouse(el);
    const typeable = kind === "combobox" && el.tagName === "INPUT" && !el.readOnly && el.inputMode !== "none";
    const search = async (text) => {
      setNative(el, text);
      await sleep(700);
      if (!visibleOptions(el).length) {
        key(el, "Enter"); // Workday prompts only search on Enter
        await sleep(900);
      }
    };
    if (typeable) {
      await sleep(150);
      await search(value.slice(0, 40));
    } else {
      if (kind === "combobox") key(el, "ArrowDown");
      await sleep(450);
    }
    let m = bestMatchAny(visibleOptions(el), value, textOf);
    if (!m && typeable) {
      // Retry with the broader answer, then the first word, for typeaheads
      // that only match prefixes.
      for (const text of [...variants(value).slice(1), value.split(/[\s,(]/)[0]]) {
        if (!text || text === value) continue;
        await search(text);
        m = bestMatchAny(visibleOptions(el), value, textOf);
        if (m) break;
      }
    }
    if (!m) {
      if (typeable) setNative(el, "");
      closePopup(el);
      return `no option matched "${value}"`;
    }
    const text = textOf(m.item);
    m.item.scrollIntoView({ block: "nearest" });
    fireMouse(m.item);
    await sleep(300);
    if (listboxFor(el)) closePopup(el); // multi-select prompts stay open
    return picked(m, text);
  }

  function dataUrlToBytes(dataUrl) {
    const bin = atob(dataUrl.slice(dataUrl.indexOf(",") + 1));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  }

  function attachFile(el, file) {
    // Decoded here rather than fetch(dataUrl), which a strict page CSP can block.
    const dt = new DataTransfer();
    dt.items.add(new File([dataUrlToBytes(file.dataUrl)], file.name, { type: file.type || "application/pdf" }));
    el.files = dt.files;
    fire(el, "input");
    fire(el, "change");
    return el.files?.length ? null : "the upload box refused the file";
  }

  const TRUE = /^(true|yes|y|checked|1|on)$/i;

  // Returns null (ok), a string (error) or { warn } (filled, but worth a look).
  async function fillOne(id, value, files) {
    let entry = registry.get(id);
    if (!entry) {
      const el = qsa(`[data-jar-id="${CSS.escape(id)}"]`)[0];
      if (el) entry = { el, kind: kindOf(el) };
    }
    if (!entry || !entry.el.isConnected) return "field disappeared from the page";
    const { el, kind } = entry;
    switch (kind) {
      case "text":
      case "email":
      case "tel":
      case "url":
      case "number":
      case "date":
      case "textarea": {
        setNative(el, value);
        fire(el, "blur");
        el.dispatchEvent(new FocusEvent("focusout", { bubbles: true, composed: true }));
        if (low(el.value) === low(value)) return null;
        if (!el.value) return "the site rejected the value";
        return { warn: `The site changed it to "${norm(el.value).slice(0, 60)}"` };
      }
      case "select": {
        const m = bestMatchAny([...el.options].filter((o) => o.text.trim()), value, (o) => o.text);
        if (!m) return `no option matched "${value}"`;
        setNative(el, m.item.value);
        return picked(m, m.item.text);
      }
      case "radio": {
        const m = bestMatchAny(radioGroup(el), value, optionText);
        if (!m) return `no option matched "${value}"`;
        if (!m.item.checked) m.item.click();
        if (!m.item.checked) (m.item.labels?.[0] || m.item).click();
        return m.item.checked ? picked(m, optionText(m.item)) : "the option didn't stay selected";
      }
      case "checkbox": {
        const want = TRUE.test(value);
        if (el.checked !== want) el.click();
        return el.checked === want ? null : "checkbox didn't change";
      }
      case "richtext":
        el.focus();
        document.execCommand("selectAll", false);
        document.execCommand("insertText", false, value);
        return textOf(el) ? null : "the editor didn't accept the text";
      case "combobox":
      case "listbutton":
        return pickFromPopup(el, value, kind);
      case "file": {
        const file = files?.[value];
        if (!file) return `no ${String(value).replace("_", " ")} file available`;
        return attachFile(el, file);
      }
      case "button":
        return "buttons are clicked, not filled";
      default:
        return `unsupported field type ${kind}`;
    }
  }

  async function fill(answers, files) {
    const results = [];
    for (const a of answers) {
      let out = null;
      try {
        out = await fillOne(a.id, a.value, files);
      } catch (e) {
        out = String(e?.message || e);
      }
      if (out && typeof out === "object") results.push({ id: a.id, ok: true, warn: out.warn });
      else results.push({ id: a.id, ok: !out, error: out });
      await sleep(60);
    }
    return results;
  }

  async function clickButtons(ids) {
    for (const id of ids) {
      const entry = registry.get(id);
      if (entry?.kind === "button" && entry.el.isConnected) {
        entry.el.scrollIntoView({ block: "center" });
        entry.el.click();
        await sleep(700);
      }
    }
  }

  function focusField(id) {
    const el = registry.get(id)?.el || qsa(`[data-jar-id="${CSS.escape(id)}"]`)[0];
    if (!el) return false;
    const target = visible(el) ? el : el.closest("fieldset, label, div, section") || el;
    target.scrollIntoView({ block: "center", behavior: "smooth" });
    const prev = target.style.outline;
    target.style.outline = "3px solid #f59e0b";
    setTimeout(() => (target.style.outline = prev), 2500);
    return true;
  }

  // ---------- moving to the next page (never submitting) ----------

  const NEXT = /^(next|continue|next step|next page|proceed|save (and|&) continue|save (and|&) next|continue to next step)\b/i;
  const FINAL = /\b(submit|send|apply|finish|complete|confirm)\b/i;

  function nextButton() {
    const cands = qsa("button, input[type=submit], input[type=button], [role=button], a[role=button]").filter(
      (b) => visible(b) && !b.disabled && b.getAttribute("aria-disabled") !== "true"
    );
    const named = cands.map((b) => ({ b, t: norm(textOf(b) || b.value || b.getAttribute("aria-label") || "") }));
    return named.find(({ t }) => NEXT.test(t) && !FINAL.test(t))?.b || null;
  }

  // Labels of the visible form controls: identifies the page without opening any dropdowns.
  function signature() {
    const els = qsa("input:not([type=hidden]), select, textarea, [role='combobox']").filter(visible);
    return els.length ? els.map((el) => labelInfo(el).text).join("|") : "";
  }

  function advance() {
    const b = nextButton();
    if (!b) return false;
    b.scrollIntoView({ block: "center" });
    b.click();
    return true;
  }

  // ---------- learning: report the user's final answers on Submit / Next ----------

  function harvest() {
    const entries = [];
    for (const { el, kind, label } of registry.values()) {
      // Written answers are job-specific and files/consents aren't worth learning.
      if (!label || !el.isConnected || ["button", "file", "checkbox", "textarea", "richtext"].includes(kind)) continue;
      let value;
      if (kind === "radio") {
        const chosen = radioGroup(el).find((r) => r.checked);
        value = chosen ? optionText(chosen) : "";
      } else value = currentValue(el, kind);
      value = norm(value);
      if (value && value.length <= 200 && !PLACEHOLDER.test(value)) entries.push({ label: norm(label), value });
    }
    return entries;
  }

  const ADVANCE = /\b(submit|next|continue|save|review|apply)\b/i;
  let lastLearn = 0;
  function learn() {
    if (Date.now() - lastLearn < 1500) return;
    lastLearn = Date.now();
    const entries = harvest();
    if (entries.length) chrome.runtime.sendMessage({ type: "learn", entries }).catch(() => {});
  }
  const onClick = (e) => {
    const b = e
      .composedPath()
      .find((n) => n instanceof Element && n.matches("button, input[type=submit], input[type=button], [role=button], a"));
    if (b && ADVANCE.test(textOf(b) || b.value || b.getAttribute("aria-label") || "")) learn();
  };
  document.addEventListener("click", onClick, true);
  document.addEventListener("submit", learn, true);

  const listener = (msg, _sender, reply) => {
    if (msg?.type === "scan") {
      scan().then(reply, (e) => reply({ error: String(e?.message || e), fields: [] }));
      return true;
    }
    if (msg?.type === "fill") {
      fill(msg.answers || [], msg.files).then(reply);
      return true;
    }
    if (msg?.type === "click") {
      clickButtons(msg.ids || []).then(() => reply(true));
      return true;
    }
    if (msg?.type === "advance") reply(advance());
    if (msg?.type === "signature") reply(signature());
    if (msg?.type === "focus") reply(focusField(msg.id));
    return false;
  };
  chrome.runtime.onMessage.addListener(listener);
  window.__jarDispose = () => {
    chrome.runtime.onMessage.removeListener(listener);
    document.removeEventListener("click", onClick, true);
    document.removeEventListener("submit", learn, true);
  };
})();

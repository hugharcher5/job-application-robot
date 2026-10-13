# Job Application Robot: plan

An LLM version of Simplify. A Chrome extension that fills job application
forms from Hugh's profile, drafts written answers and cover letters, and leaves
the final Submit click to him.

## Principles

- **Speed first.** Fill everything it reasonably can, including sensitive and
  unusual questions, from the profile and Claude's reasoning.
- **Never invent facts.** Answers present true profile facts at their best.
  If a question genuinely needs something the profile doesn't hold, flag it.
- **Answer the question actually asked.** "Degree GPA" is 3.8/4.2. If a form
  asks specifically for cumulative GPA, answer that (≈3.73), don't swap in 3.8.
- **One click to submit, by Hugh.** No auto-submit.
- **Flag, don't bypass,** logins, CAPTCHAs and email codes.

## Architecture

```
side panel (UI) ── background service worker ── Claude API
       │                    │
       └──── content script (per page / frame): detect ATS, extract fields, fill
```

1. **Profile** (`chrome.storage.local`, never committed): a Markdown file with
   facts, rules and stored answers (diversity, disability, criminal record,
   relatives at firms, work authorisation: Irish citizen; eligible for British
   citizenship), plus CV, transcript and cover-letter files.
2. **Detect** the ATS from the URL/DOM: Greenhouse, Workday, SmartRecruiters,
   Oleeo (tal.net), Lever, Ashby, generic fallback.
3. **Extract** fields into a common shape:
   `{id, label, type, required, options[], maxLength, section}`.
   Custom dropdowns are opened to read their options.
4. **Answer** in one Claude call: profile + job description + fields →
   structured JSON `{fieldId: {value, confidence, note}}`. Dropdown answers must
   be one of the listed options. Answers over `maxLength` are rewritten, not cut.
5. **Fill** with adapter-specific setters: native value setter + input/change
   events (React), click-to-select for custom dropdowns, typeahead search,
   `DataTransfer` for file inputs, contenteditable for rich text, "Add another"
   buttons for repeated sections.
6. **Review panel** lists every field with its answer; low confidence and
   login/CAPTCHA steps are highlighted.
7. **Cover letters**: Claude writes the body from the job description, profile
   and past letters; rendered to PDF in the letterhead template; attached.
8. **Notion**: on the "thank you for applying" page, mark the role Done in the
   Summer 2027 Applications tracker.

## Phases

| Phase | Scope |
|---|---|
| 0 | Repo, build, MV3 skeleton, side panel, profile storage, ATS detection, field scan, API key + connection test |
| 1 | Greenhouse end to end: answers, dropdowns, CV upload, written answers, review panel |
| 2 | Cover-letter PDF generation and upload |
| 3 | Workday (multi-page, repeaters, date pickers, custom dropdowns) |
| 4 | SmartRecruiters, Oleeo, Lever, Ashby; Notion logging |
| 5 | Product version (backend for keys, accounts, billing): decide first |

## Model

`claude-opus-5-5` with low effort for form filling, higher for cover letters.
Server-side refusal fallback enabled. Calls go from the extension to the API
with Hugh's own key, stored in `chrome.storage.local`.

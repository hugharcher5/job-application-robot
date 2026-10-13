# Job Application Robot

A Chrome extension that fills job application forms with Claude, using your own
profile. It reads every field (including custom dropdowns), answers them, writes
and attaches a tailored cover letter when a form asks for one, and shows what's
done, what needs review and what it couldn't answer. You review and click
Submit. See [PLAN.md](PLAN.md).

## Setup

```bash
npm install
npm run build        # or: npm run watch
```

1. Chrome → `chrome://extensions` → enable Developer mode → **Load unpacked** →
   choose the `dist/` folder. After rebuilding, press the reload icon there.
2. Click the extension icon. The panel opens on the right.
3. **Settings**:
   - Claude API key (console.anthropic.com) → Save key → Test connection.
   - Profile: fill in `profile/profile.example.md`, keep your copy as
     `profile/profile.md` (git-ignored) and paste it in.
   - Optional: example cover letters (plain text), CV and transcript PDFs.
   - Optional: Notion integration token + database ID for "Mark applied".
     Share the database with the integration. Expects `Firm` (title),
     `Position` (text), `Status` (status with "Done") and `Applied on` (date).

## Use

1. Open an application form (Greenhouse, Workday, SmartRecruiters, Oleeo,
   Lever, Ashby or most plain forms).
2. Press **Fill this application**.
3. Check **Needs review** and **No answer**; click any item to jump to it.
4. Multi-page forms (Workday): press Fill again on each page.
5. Submit yourself, then **Mark applied**.

Your key, profile and files live only in this browser's extension storage.

# Job Application Robot

A Chrome extension that fills job application forms with Claude, using your own
profile. It drafts written answers and cover letters; you review and click
Submit. See [PLAN.md](PLAN.md).

## Setup

```bash
npm install
npm run build        # or: npm run watch
```

1. Chrome → `chrome://extensions` → enable Developer mode → **Load unpacked** →
   choose the `dist/` folder.
2. Click the extension icon to open the side panel.
3. Paste your Claude API key, **Save key**, then **Test connection**.
4. Fill in `profile/profile.example.md`, save it as `profile/profile.md`
   (git-ignored), and paste it into the side panel.

## Status

Phase 0: detects the application system and lists the form's fields.
Filling arrives in Phase 1 (Greenhouse).

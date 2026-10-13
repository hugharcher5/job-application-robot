import { PDFDocument, StandardFonts, rgb } from "pdf-lib";

// Renders a cover letter in the same letterhead style as the Word template:
// name in capitals, contact line, a rule, then date, recipient and body.
export async function letterPdf(letter, date = new Date()) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.TimesRoman);
  const W = 595.28;
  const H = 841.89;
  const M = 72;
  const width = W - 2 * M;
  let page = doc.addPage([W, H]);
  let y = H - M;

  // Standard fonts only cover WinAnsi; swap anything else for a safe character.
  const safe = (s) =>
    [...String(s)]
      .map((ch) => {
        try {
          font.widthOfTextAtSize(ch, 10);
          return ch;
        } catch {
          const mapped = { "‑": "-", "‒": "-", "−": "-", "≈": "~", "→": "->" }[ch];
          if (mapped) return mapped;
          // Accented letters outside WinAnsi: drop the accent rather than the letter.
          const plain = ch.normalize("NFKD").replace(/[̀-ͯ]/g, "");
          try {
            font.widthOfTextAtSize(plain, 10);
            return plain;
          } catch {
            return "";
          }
        }
      })
      .join("");

  function wrap(text, size) {
    const words = safe(text).split(/\s+/).filter(Boolean);
    const lines = [];
    let line = "";
    for (const w of words) {
      const next = line ? `${line} ${w}` : w;
      if (font.widthOfTextAtSize(next, size) > width && line) {
        lines.push(line);
        line = w;
      } else line = next;
    }
    if (line) lines.push(line);
    return lines;
  }

  function write(text, size, gapAfter = 0) {
    for (const line of wrap(text, size)) {
      if (y - size < M) {
        page = doc.addPage([W, H]);
        y = H - M;
      }
      page.drawText(line, { x: M, y: y - size, size, font, color: rgb(0, 0, 0) });
      y -= size * 1.25;
    }
    y -= gapAfter;
  }

  // Letterhead as in the Word template: name, a rule, then the contact line.
  write(letter.name.toUpperCase(), 22, 0);
  page.drawLine({ start: { x: M, y: y + 2 }, end: { x: W - M, y: y + 2 }, thickness: 0.8, color: rgb(0, 0, 0) });
  y -= 3;
  write(letter.contact_line, 9, 18);
  write(date.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" }), 11, 12);
  for (const l of letter.recipient_lines) write(l, 11);
  y -= 12;
  write(letter.greeting, 11, 9);
  for (const p of letter.paragraphs) write(p, 11, 9);
  write(letter.sign_off, 11, 24);
  write(letter.name.replace(/\b\w+/g, (w) => w[0].toUpperCase() + w.slice(1).toLowerCase()), 11);

  const bytes = await doc.save();
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return `data:application/pdf;base64,${btoa(bin)}`;
}

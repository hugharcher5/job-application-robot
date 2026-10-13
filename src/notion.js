// Marks a role as applied in the Notion tracker. Expects the database to have
// "Firm" (title), "Position" (text), "Status" (status) and "Applied on" (date).
const API = "https://api.notion.com/v1";

async function notion(path, token, body, method = "POST") {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Notion-Version": "2022-06-28",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message || `Notion error ${res.status}`);
  return data;
}

const words = (s) => new Set((s || "").toLowerCase().split(/\W+/).filter((w) => w.length > 2));

export async function markApplied(company, role) {
  const { notionToken, notionDatabaseId } = await chrome.storage.local.get(["notionToken", "notionDatabaseId"]);
  if (!notionToken || !notionDatabaseId) throw new Error("Add a Notion token and database ID under Settings.");
  const query = (text) =>
    notion(`/databases/${notionDatabaseId}/query`, notionToken, {
      filter: { property: "Firm", title: { contains: text } },
      page_size: 50,
    });
  // Try the full name first, then its most distinctive word ("Man Group" -> "Man").
  const longest = company.split(/\s+/).filter((w) => !/^(the|and|of|group|inc|ltd|llc|plc)$/i.test(w)).sort((a, b) => b.length - a.length)[0];
  let { results } = await query(company);
  if (!results.length && longest) ({ results } = await query(longest));
  const firm = company;
  if (!results.length) throw new Error(`No row for "${company}" in the tracker.`);
  const want = words(role);
  const score = (p) => {
    const pos = (p.properties.Position?.rich_text || []).map((t) => t.plain_text).join("");
    return [...words(pos)].filter((w) => want.has(w)).length;
  };
  const row = results.sort((a, b) => score(b) - score(a))[0];
  await notion(
    `/pages/${row.id}`,
    notionToken,
    {
      properties: {
        Status: { status: { name: "Done" } },
        "Applied on": { date: { start: new Date().toISOString().slice(0, 10) } },
      },
    },
    "PATCH"
  );
  const pos = (row.properties.Position?.rich_text || []).map((t) => t.plain_text).join("");
  return `${firm}: ${pos || "role"} marked applied`;
}

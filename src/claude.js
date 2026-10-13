import Anthropic from "@anthropic-ai/sdk";

export const MODEL = "claude-opus-5-5";

export async function getClient() {
  const { apiKey } = await chrome.storage.local.get("apiKey");
  if (!apiKey) throw new Error("No API key saved yet.");
  // The key is the user's own and stays in this browser's extension storage.
  return new Anthropic({ apiKey, dangerouslyAllowBrowser: true });
}

export async function testConnection() {
  const client = await getClient();
  const response = await client.beta.messages.create({
    model: MODEL,
    max_tokens: 1000,
    output_config: { effort: "low" },
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    messages: [{ role: "user", content: "Reply with exactly: connected" }],
  });
  if (response.stop_reason === "refusal") throw new Error("Request was declined.");
  const text = response.content.filter((b) => b.type === "text").map((b) => b.text).join("");
  return `${response.model}: ${text.trim()}`;
}

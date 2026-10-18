import Anthropic from "@anthropic-ai/sdk";
import { betaJSONSchemaOutputFormat } from "@anthropic-ai/sdk/helpers/beta/json-schema";

// The cheapest current model; fast enough to keep form filling quick.
export const MODEL = "claude-haiku-5-5";

export async function getClient() {
  const { apiKey } = await chrome.storage.local.get("apiKey");
  if (!apiKey) throw new Error("No Claude API key saved. Add one under Settings.");
  // The key is the user's own and stays in this browser's extension storage.
  return new Anthropic({ apiKey, dangerouslyAllowBrowser: true, maxRetries: 2 });
}

// parse() throws on unreadable JSON before we can look at stop_reason.
async function parsed(client, params) {
  try {
    return await client.beta.messages.parse(params);
  } catch (e) {
    if (/parse/i.test(e?.message || "") && !e?.status) {
      throw new Error("Claude's answer was cut off or unreadable. Try again.");
    }
    throw e;
  }
}

function checkStop(response) {
  if (response.stop_reason === "refusal") throw new Error("Claude declined this request.");
  if (response.stop_reason === "max_tokens") throw new Error("Claude's answer was cut off. Try again.");
}

export async function testConnection() {
  const client = await getClient();
  const response = await client.beta.messages.create({
    model: MODEL,
    max_tokens: 1000,
    output_config: { effort: "low" },
    messages: [{ role: "user", content: "Reply with exactly: connected" }],
  });
  checkStop(response);
  const text = response.content.filter((b) => b.type === "text").map((b) => b.text).join("");
  return `${response.model}: ${text.trim()}`;
}

const ANSWER_RULES = `You fill in job application forms on behalf of the candidate described in the profile. Work quickly and fill every field you can; the candidate reviews everything before submitting. Answer the way the candidate would if they looked at the question themselves: make the best decision from what you know rather than leaving it for them.

Rules:
- Choices between options (location, office, business area, division, desk, team, rotation, start date, programme track) follow the profile's "Decision rules". Reason about this firm and role: where the team actually sits, how competitive each option is, and what the job page says. Always pick one, with status "fill" (or "review" if the call is close, noting the runner-up).
- Every fact you state must come from the profile. Never invent employers, dates, grades, names, referrers or achievements. You may reason from profile facts: convert grade scales, work out eligibility, pick the closest dropdown option, infer country of residence, compute a cumulative figure from year-by-year results.
- Answer the question actually asked. "GPA" or "degree GPA" means the profile's degree GPA. If a form asks specifically for cumulative, overall or first-year results, give that figure instead.
- Sensitive questions (gender, ethnicity, religion, disability, criminal record, relatives at the firm, sexual orientation, veteran status, socio-economic background and similar) use the profile's stored answers, mapped to the closest listed option, with status "fill". Never leave these unanswered: if nothing fits, pick the "prefer not to say" option.
- Work authorisation and sponsorship: decide from the profile's citizenship and right-to-work facts for the country the job is in.
- select, radio, combobox and listbutton fields with an options list: value must be copied exactly from that list. If a field is marked typeahead, give the text to type into it (e.g. the university name).
- If the profile's answer is more specific than, or worded differently from, every option (e.g. "White – Irish" when only "White" is offered), pick the closest broader option with status "fill". Don't return no_answer when a sensible option exists.
- The profile may end with a "Learned answers" section: the candidate's own answers from earlier forms, written "question → answer". When a field asks the same thing (even worded differently), use that answer, adapted to this field's options, with status "fill". Learned answers override the rest of the profile for the same question.
- checkbox: "true" or "false". Privacy consents and "I certify this is accurate" boxes are "true" with status "review".
- file fields: "cv", "transcript", "cover_letter", or "" if none fits. Use "cover_letter" only for a field asking for a cover letter. Use "transcript" only if a transcript is available.
- Written questions: first person, the candidate's voice, specific and concrete, plain British English, no clichés or filler. If maxLength is set, stay at least 10% under it (count characters); rewrite rather than truncate.
- date fields (type "date"): YYYY-MM-DD.
- status: "fill" when confident; "review" for close judgement calls, written answers and legal ticks (these are still filled); "no_answer" only for things no reasoning can supply: one-time codes, passwords, a named referrer, an ID number the profile lacks (set value to ""); "skip" for things that should not be touched (fields already holding the right value, irrelevant optional fields, search boxes, add-row buttons). Optional fields that a reasonable candidate would answer, answer.
- A field may carry "previous": an earlier answer that the form wouldn't accept, with the reason. Choose again from the field's current options or wording; don't repeat a value that failed.
- Repeated sections (work experience, education, activities): fill rows in the order the profile gives; if the profile sets no order, most recent and most relevant first.
- clicks: "Add" buttons (Add another, Add Work Experience, Add Certification, Add Language…) to press so the form has a row for every matching profile entry. Count first: rows the profile needs in that section minus empty rows already shown, and repeat the button's id that many times (e.g. 3 more certifications → the id 3 times). Always add rows for every experience, education entry, certification and language in the profile unless the form caps them. Never list anything that submits or moves to the next page.
- note: at most 12 words, only when useful (why it needs review, or what is missing).
- company and role: read them from the page.`;

const ANSWER_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["company", "role", "answers", "clicks"],
  properties: {
    company: { type: "string" },
    role: { type: "string" },
    answers: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "value", "status", "note"],
        properties: {
          id: { type: "string" },
          value: { type: "string" },
          status: { type: "string", enum: ["fill", "review", "no_answer", "skip"] },
          note: { type: "string" },
        },
      },
    },
    clicks: { type: "array", items: { type: "string" } },
  },
};

export async function answerFields({ profile, page, fields, filesAvailable, alreadyFilled = [] }) {
  const client = await getClient();
  const response = await parsed(client, {
    model: MODEL,
    max_tokens: 16000,
    output_config: { effort: "medium", format: betaJSONSchemaOutputFormat(ANSWER_SCHEMA, { transform: false }) },
    system: [
      { type: "text", text: ANSWER_RULES },
      // The profile rarely changes, so cache it across applications.
      { type: "text", text: `<profile>\n${profile}\n</profile>`, cache_control: { type: "ephemeral" } },
    ],
    messages: [
      {
        role: "user",
        content: `Application page: ${page.title}\nURL: ${page.url}\nFiles available to upload: ${
          filesAvailable.join(", ") || "none"
        }\n\n<page_text>\n${page.text}\n</page_text>${
          alreadyFilled.length
            ? `\n\nAlready filled earlier on this form (don't repeat these entries in new rows):\n${JSON.stringify(alreadyFilled)}`
            : ""
        }\n\nAnswer every field below (one answers entry per id).\n<fields>\n${JSON.stringify(
          fields
        )}\n</fields>`,
      },
    ],
  });
  checkStop(response);
  if (!response.parsed_output) throw new Error("Claude's answer couldn't be read. Try again.");
  return response.parsed_output;
}

const LETTER_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["name", "contact_line", "recipient_lines", "greeting", "paragraphs", "sign_off"],
  properties: {
    name: { type: "string" },
    contact_line: { type: "string" },
    recipient_lines: { type: "array", items: { type: "string" } },
    greeting: { type: "string" },
    paragraphs: { type: "array", items: { type: "string" } },
    sign_off: { type: "string" },
  },
};

export async function writeCoverLetter({ profile, examples, page, company, role }) {
  const client = await getClient();
  const response = await parsed(client, {
    model: MODEL,
    max_tokens: 16000,
    output_config: { effort: "high", format: betaJSONSchemaOutputFormat(LETTER_SCHEMA, { transform: false }) },
    system: [
      {
        type: "text",
        text: `You write one-page cover letters for the candidate in the profile. Use only facts from the profile; never invent anything. Match the structure, tone and length of the example letters if given: an opening line naming the programme, three or four body paragraphs tailored to this role and firm, and a closing paragraph. Plain British English, specific, no clichés. Total body under 430 words so it fits one page.
name: the candidate's full name in capitals. contact_line: email | phone | website | LinkedIn from the profile, separated by "  |  ". recipient_lines: firm name, then team/division and city. greeting: "Dear Hiring Team,". sign_off: "Yours sincerely,".`,
      },
      { type: "text", text: `<profile>\n${profile}\n</profile>`, cache_control: { type: "ephemeral" } },
    ],
    messages: [
      {
        role: "user",
        content: `${examples ? `<example_letters>\n${examples}\n</example_letters>\n\n` : ""}Firm: ${company}\nRole: ${role}\nURL: ${page.url}\n\n<job_page>\n${page.text}\n</job_page>\n\nWrite the cover letter.`,
      },
    ],
  });
  checkStop(response);
  if (!response.parsed_output) throw new Error("The cover letter couldn't be read. Try again.");
  return response.parsed_output;
}

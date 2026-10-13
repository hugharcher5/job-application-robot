// Work out which applicant tracking system a page belongs to.
const RULES = [
  ["greenhouse", /(^|\.)greenhouse\.io$/],
  ["workday", /\.myworkdayjobs\.com$/],
  ["smartrecruiters", /\.smartrecruiters\.com$/],
  ["oleeo", /\.tal\.net$/],
  ["lever", /^jobs\.lever\.co$/],
  ["ashby", /^jobs\.ashbyhq\.com$/],
];

export function detectAts(hostname = location.hostname) {
  for (const [name, re] of RULES) if (re.test(hostname)) return name;
  return "generic";
}

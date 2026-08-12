import { strict as assert } from "node:assert";
import { test } from "node:test";
import { unsupportedSpecifics } from "./grounding.js";

// The fixture is the real failure this guards against: a "improve my resume"
// turn that read the actual PDF and then wrote a resume full of specifics
// from the model's weights instead.
const REAL_SOURCES = [
  "read 'Mariz/Mariz Melo Resume (revised).pdf' and improve it",
  `Mariz Melo — SUMMARY EXPERIENCE RECOGNITION SKILLS EDUCATION
   mariz@marizmelo.dev · San Francisco · Built the platform at Realtime Inc,
   raised conversion 12%, phone +1 415 555 0100`,
];

test("invented contact details and employers are flagged", () => {
  const reply = `# Mariz Melo
📞 (555) 123-4567 | 📧 mariz.melo@email.com | linkedin.com/in/marizmelo
## Professional Experience
### Senior Software Engineer, TechNova Solutions
- Improved system performance by 40% and reduced downtime by 60%.`;

  const flagged = unsupportedSpecifics(reply, REAL_SOURCES);
  const joined = flagged.join(" | ");
  assert.match(joined, /TechNova Solutions/);
  assert.match(joined, /mariz\.melo@email\.com/);
  assert.match(joined, /555.*123.*4567/);
  assert.match(joined, /40\s?%/);
  assert.match(joined, /60\s?%/);
});

test("specifics that appear in the sources pass, whatever their formatting", () => {
  const reply = `Contact: mariz@marizmelo.dev or (415) 555-0100. At Realtime Inc
he raised conversion by 12%.`;
  const flagged = unsupportedSpecifics(reply, REAL_SOURCES);
  assert.deepEqual(flagged, [], `should be clean, flagged: ${flagged.join(", ")}`);
});

test("phone numbers match on digits, not punctuation", () => {
  // Source has "+1 415 555 0100"; reply reformats it. Same digits = grounded.
  const flagged = unsupportedSpecifics("Call +1 (415) 555-0100.", REAL_SOURCES);
  assert.deepEqual(flagged, []);
});

test("document furniture is never flagged", () => {
  // Headings the model legitimately composes when writing a new document.
  const reply = `## Professional Summary
## Key Skills
## Work Experience
## Education`;
  const flagged = unsupportedSpecifics(reply, ["write me a resume skeleton"]);
  assert.deepEqual(flagged, [], `flagged: ${flagged.join(", ")}`);
});

test("names the user themselves typed are grounded", () => {
  const flagged = unsupportedSpecifics(
    "I'll tailor it for the Vercel Frontend Cloud role.",
    ["tailor my resume for the Vercel Frontend Cloud job posting"],
  );
  assert.deepEqual(flagged, []);
});

test("prose paraphrase alone trips nothing", () => {
  // No hard specifics at all: rewording is what a language model is for.
  const flagged = unsupportedSpecifics(
    "The resume is strong on outcomes but the summary buries the lede; lead with impact.",
    REAL_SOURCES,
  );
  assert.deepEqual(flagged, []);
});

test("each invention is reported once, not per occurrence", () => {
  const reply = "TechNova Solutions did X. Later, TechNova Solutions did Y.";
  const flagged = unsupportedSpecifics(reply, REAL_SOURCES);
  assert.equal(flagged.filter((f) => /TechNova/.test(f)).length, 1);
});

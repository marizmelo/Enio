import { strict as assert } from "node:assert";
import { describe, test } from "node:test";
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

describe("names the evidence never gave: a name is known by its words", () => {
  const PAGE =
    "For US fans, the Libertadores is South America's Champions League. " +
    "Copa Libertadores final 2026: date and tickets. Popular: Dell XPS 13 (2026), HP OmniBook 3 14 (2025). " +
    "The largest firms include Estúdio Verde Arquitetos and Casa Norte. Brazil ranks first.";

  test("another ending, another order and a parenthesis are the same name", async () => {
    const { namesWithoutEvidence } = await import("./grounding.js");
    // Each of these withdrew a correct answer when the phrase was wanted as
    // typed: the page says "South America's", "Copa Libertadores final 2026"
    // and "Dell XPS 13 (2026)".
    const reply =
      "CONMEBOL is the South American football body. In the **2026 Copa Libertadores** the final is set. " +
      "The **Dell XPS 13 2026** and the Brazilian side are both listed.";
    assert.deepEqual(namesWithoutEvidence(reply, [PAGE], "what happened"), []);
  });

  test("a name that brings a word the page does not have is still missing", async () => {
    const { namesWithoutEvidence } = await import("./grounding.js");
    const out = namesWithoutEvidence(
      "The best is **Von Buhler Arquitetos**, ahead of Estúdio Verde Arquitetos. Third is Rafael Romão Arquitetos.",
      [PAGE],
      "best architecture firm",
    );
    assert.deepEqual(out.sort(), ["Rafael Romão Arquitetos", "Von Buhler Arquitetos"]);
  });

  test("a short word must match whole, in both directions", async () => {
    const { namesWithoutEvidence } = await import("./grounding.js");
    // Nothing but the short word decides here: "Costa" is on both pages.
    assert.deepEqual(namesWithoutEvidence("It was built by Rui Costa.", ["Ruiz Costa built it."], "who built it"), ["Rui Costa"]);
    assert.deepEqual(namesWithoutEvidence("It was built by Ruiz Costa.", ["Rui Costa built it."], "who built it"), ["Ruiz Costa"]);
  });

  test("a hyphenated page word, a possessive and a curly apostrophe are the same name", async () => {
    const { namesWithoutEvidence } = await import("./grounding.js");
    const page = "Paris Saint-Germain won. Flamengo's Jorge Carrascal was sent off.";
    const reply = "Paris Saint Germain won after Flamengo’s Jorge Carrascal saw red, and Carrascal's Flamengo lost.";
    assert.deepEqual(namesWithoutEvidence(reply, [page], "what happened"), []);
  });

  test("the sentence around a name is taken off it, not used to discard it", async () => {
    const { namesWithoutEvidence } = await import("./grounding.js");
    // Discarding the run meant any invented name after "The" or "At" was
    // never checked, and a name followed by "designs" or "does" became
    // "… de" and was thrown away with it.
    assert.deepEqual(
      namesWithoutEvidence("The Von Buhler Arquitetos studio is the best. At Casa Norte they agree.", [PAGE], "best firm"),
      ["Von Buhler Arquitetos"],
    );
    assert.deepEqual(
      namesWithoutEvidence(
        "Von Buhler Arquitetos designs homes. Rafael Romão Arquitetos does interiors. Studio Kaza Arquitetura e Design then follows.",
        ["Nothing relevant here."],
        "best firm",
      ),
      ["Von Buhler Arquitetos", "Rafael Romão Arquitetos", "Studio Kaza Arquitetura e Design"],
    );
  });

  test("what is left after the sentence words is a name only with two capitals", async () => {
    const { namesWithoutEvidence } = await import("./grounding.js");
    // None of these names is in the evidence or the question, so only the
    // rule keeps them out: "Is Botafogo" and "The Santos" leave one word.
    const reply = "Important Note: this is unclear. Is Botafogo out? The Santos game was off. **not confirmed** **Key takeaways** **TL;DR**";
    assert.deepEqual(namesWithoutEvidence(reply, ["Nothing relevant here."], "what happened"), []);
  });

  test("an accented letter is a letter: not a word boundary, and not a reason to treat a word differently", async () => {
    const { namesWithoutEvidence } = await import("./grounding.js");
    // "Inês" does not begin with the word "in", nor "Forças" with "for".
    assert.deepEqual(
      namesWithoutEvidence("It was designed by Inês Costa Arquitetos for the Forças Armadas Brasileiras.", ["Nothing here."], "who"),
      ["Inês Costa Arquitetos", "Forças Armadas Brasileiras"],
    );
    // One capitalised word is skipped in any alphabet.
    assert.deepEqual(namesWithoutEvidence("**Conclusão** **Conclusion** **Grêmio** **Flamengo**", ["Nothing here."], "who"), []);
  });

  test("a run does not begin inside a token, and a unit glued to its number is still that unit", async () => {
    const { namesWithoutEvidence } = await import("./grounding.js");
    const page = "Specs: 16GB of RAM, runs macOS 15 Sequoia, sold as the iPhone 18 Pro Max.";
    // "16GB RAM" gave "GB RAM", "macOS Sequoia" gave "OS Sequoia".
    assert.deepEqual(namesWithoutEvidence("It has 16GB RAM and runs macOS Sequoia.", [page], "specs"), []);
    assert.deepEqual(namesWithoutEvidence("It has 16 GB RAM in every model.", [page], "specs"), []);
    assert.deepEqual(namesWithoutEvidence("It has 16 GB RAM in every model.", ["No specifications listed."], "specs"), ["GB RAM"]);
  });

  test("an acronym in parentheses after a name is part of the name", async () => {
    const { namesWithoutEvidence } = await import("./grounding.js");
    const page = "A decisão é da Confederação Brasileira de Futebol.";
    assert.deepEqual(namesWithoutEvidence("Decided by the **Confederação Brasileira de Futebol (CBF)**.", [page], "who decided"), []);
    assert.deepEqual(namesWithoutEvidence("Decided by the **Federação Paulista de Vôlei (FPV)**.", [page], "who decided"), ["Federação Paulista de Vôlei"]);
  });

  test("known limit: a name built only from words the page uses elsewhere passes", async () => {
    const { namesWithoutEvidence } = await import("./grounding.js");
    // Pinned so that closing this hole is a decision. Wanting the phrase
    // itself closed it and named 153 things that were not inventions.
    assert.deepEqual(namesWithoutEvidence("The winner is **Casa Verde Arquitetos**.", [PAGE], "who won"), []);
  });

  test("one missing name is enough to withdraw, none is not", async () => {
    const { withdrawsForNames } = await import("./grounding.js");
    assert.equal(withdrawsForNames([]), false);
    assert.equal(withdrawsForNames(["Von Buhler Arquitetos"]), true);
  });
});

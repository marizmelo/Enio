/**
 * Shared kit for adapter training scenarios — any specialist's module
 * (scripts/adapter-data/<name>.mjs) builds from these.
 *
 * Two contracts every module honors:
 *
 * 1. Tool-result strings mirror the real tools' output shapes (read_file's
 *    `   N | ` gutter, `Error: no file at …`, search_code's `No matches for
 *    …`). The model must learn to act on what the tools actually print — a
 *    training result in a shape a tool never produces teaches a reflex
 *    serving never triggers.
 *
 * 2. Error recovery is bounded by construction in recoveryScenarios():
 *    report the failure plainly and stop, or take at most TWO recovery
 *    steps (enough for the canonical repair — follow the error's own hint,
 *    e.g. re-read then re-edit — and nothing more) and then report. The
 *    live failure this guards against was open-ended: a git command in a
 *    non-repo folder sent the model looping on diagnostic variations for
 *    its whole turn budget. Rehearsing a bounded response is the fix; a
 *    framework that allowed long recovery chains would train the very
 *    meander it exists to remove.
 */

let callSeq = 0;

/** An assistant message that calls one tool. */
export function call(name, args) {
  callSeq += 1;
  return {
    role: "assistant",
    content: "",
    tool_calls: [
      {
        id: `call_${callSeq}`,
        type: "function",
        function: { name, arguments: JSON.stringify(args) },
      },
    ],
  };
}

/** The matching tool result. Pairs with the most recent call(). */
export function result(content) {
  return { role: "tool", tool_call_id: `call_${callSeq}`, content };
}

export const say = (content) => ({ role: "assistant", content });
export const user = (content) => ({ role: "user", content });

/** read_file output: the real gutter format. */
export const numbered = (text) =>
  text
    .split("\n")
    .map((l, i) => `${String(i + 1).padStart(4)} | ${l}`)
    .join("\n");

/** write_file's success line. */
export const wrote = (path, content) => `Wrote ${content.length} bytes to ${path}`;

/**
 * Dead-end scenarios from a declarative catalog. Each entry:
 *
 *   { ask,                      what the user requested
 *     call: [tool, args],       the reasonable first move
 *     error,                    what the tool actually printed
 *     recover?: { call: [tool, args], output },   one step, or an array of two
 *     reply }                   the honest close: what happened, in plain words
 *
 * The builder admits no other shape — a third recovery step throws — so
 * every entry trains "bounded response to a surprise" and nothing can
 * accidentally train a retry loop.
 */
export function recoveryScenarios(entries) {
  return entries.map((e) => () => {
    const steps = [user(e.ask), call(...e.call), result(e.error)];
    const recover = e.recover ? [e.recover].flat() : [];
    if (recover.length > 2) {
      throw new Error(
        `recovery for "${e.ask}" has ${recover.length} steps — the bound is 2; a longer chain trains the loop this family exists to remove`,
      );
    }
    for (const r of recover) {
      steps.push(call(...r.call), result(r.output));
    }
    steps.push(say(e.reply));
    return steps;
  });
}

/**
 * A mid-conversation golden task: the turn is already underway, a tool has
 * just failed, and what is scored is the very next move. `expect` names the
 * one recovery tool call that is right, or null when the right move is
 * answering plainly — which for a dead end it usually is.
 */
export function goldenRecovery({ prompt, call: c, error, expect = null }) {
  // prompt rides along for the eval's miss report, even though the
  // model-facing turn is the messages array.
  return { prompt, messages: [user(prompt), call(...c), result(error)], expect };
}

/**
 * An abstention probe: something absent from every scenario and any
 * plausible workspace, and the only right reply is to say so and stop.
 * Scored by the closed grammar in src/adapters.ts (ABSTAIN_PHRASES): no
 * tool call, and a phrase that admits the gap. For a specialist whose
 * honest shape is "I looked, and it is not here", pass `call`/`output` so
 * the look has already happened and the next move is what is scored.
 */
export function goldenAbstain({ prompt, call: c, output, looks }) {
  // `looks`: every reasonable look, already taken and already empty. For
  // the coder that is two — its curriculum teaches a bounded two-step
  // recovery, so a probe with one look done scores the trained second look
  // as "kept looking". The first gate run charged the adapter exactly that.
  const taken = looks ?? (c ? [[c[0], c[1], output]] : []);
  const messages = [user(prompt)];
  for (const [tool, args, out] of taken) messages.push(call(tool, args), result(out));
  return { prompt, messages, expect: "abstain" };
}

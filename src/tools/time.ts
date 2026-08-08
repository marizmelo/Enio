import type { ToolDef } from "../types.js";

/**
 * The time, as text and as something to look at.
 *
 * This is the first tool to return a widget, and it is here partly because it
 * is the cheapest honest proof of the channel: the answer is genuinely useful
 * as one sentence, so the text is not a consolation prize for clients that
 * cannot draw. That is the rule for every widget after it — if the text reads
 * like a placeholder, the widget is carrying information it should not be.
 *
 * A model asked the time answers from its weights, which is to say it invents
 * one. Being wrong about the time is unusually damaging because it is checkable
 * in a second, so this exists to keep the answer out of the model's hands.
 */
export const timeTools: ToolDef[] = [
  {
    name: "current_time",
    description: "The current date and time on this machine.",
    // No parameters at all, deliberately. With an optional `zone` the model
    // emitted the call twice in one block, and mlx-lm parses a tool block as a
    // single JSON document -- two objects make it throw
    // "Extra data: line 2 column 1", drop the whole thing, and return empty
    // content. The turn then looks like the model said nothing, with the only
    // evidence in the model server's log. A zero-argument schema gives it
    // nothing to vary.
    parameters: { type: "object", properties: {}, required: [] },
    origin: "builtin",
    async run() {
      const zone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
      const formatted = new Intl.DateTimeFormat("en-GB", {
        dateStyle: "full",
        timeStyle: "short",
        timeZone: zone,
      }).format(new Date());

      return {
        text: `It is ${formatted} (${zone}).`,
        widget: {
          type: "clock",
          label: formatted,
          iso: new Date().toISOString(),
          zone,
        },
      };
    },
  },
];

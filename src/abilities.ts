import { config } from "./config.js";
import { desktopEnabled } from "./tools/desktop.js";
import { loadSkills } from "./skills.js";
import { SPECIALISTS } from "./specialists.js";
import type { Registry } from "./tools/index.js";

/**
 * Abilities: the launcher's closed list of things Enio can do, named the way
 * a person thinks of them rather than the way the code is organised.
 *
 * An ability is user-side routing. The router is the harness's guess about
 * what a message wants; a tile the user picks removes the guess entirely --
 * it pins the specialist (and optionally a skill) through the same
 * `/skill @specialist` grammar the composer already parses, and it names the
 * expected outcome before the turn runs. Accuracy comes from the narrowing,
 * exactly as it does everywhere else in this codebase.
 *
 * The list is closed for the same reason every list here is closed: the
 * pipeline composer chooses abilities by id, and a 4B model choosing from a
 * short enum is reliable where a model inventing capabilities is not.
 *
 * Availability is *derived*, never stored. The registry is already the truth
 * about configuration -- an unconfigured mailer withholds `send_email`
 * entirely -- so a tile is "available" exactly when its tools exist. The
 * philosophy for the model is to withhold dead-end tools; the philosophy for
 * the *user* is the opposite: show the tile greyed with the setup path,
 * because a person can act on "configure SMTP" where a model can only fail.
 */

export const PORT_TYPES = [
  "text",
  "file",
  "document",
  "image",
  "email_draft",
  "url",
  "plan",
] as const;
export type PortType = (typeof PORT_TYPES)[number];

export type Availability = "available" | "setup" | "future";

export interface AbilitySetup {
  summary: string;
  steps: string[];
  /** Repo-relative docs path, opened via the docs site / GitHub. */
  docs: string;
}

export interface Ability {
  /** Closed-list id; what the pipeline composer's enum is built from. */
  id: string;
  title: string;
  description: string;
  /** A lucide icon name; the client maps names to components statically. */
  icon: string;
  specialist: string;
  /** Skill pinned alongside the specialist, when installed. */
  skill?: string;
  /** Composer prefill; "___" is where the user's own words go. */
  promptTemplate: string;
  /** Three worked openings, shown when the tile is picked. Each fills the
   *  template's slot, so what a click produces is exactly what typing it
   *  would have -- suggestions are slot-fillers, not a second grammar. */
  suggestions?: string[];
  inputs: PortType[];
  outputs: PortType[];
  /** Every one of these must be in the live registry to count as available. */
  requiredTools?: string[];
  requiredFlag?: "browserAct" | "desktopEnabled";
  /** An MCP server name that must be connected (prefix match). */
  requiredServer?: string;
  /** Not buildable yet at all -- the tile is a signpost. */
  future?: boolean;
  /** Real ability, but not a launcher tile -- it exists for the pipeline
   *  canvas and composer (e.g. a bare instruction step). */
  launcherHidden?: boolean;
  setup?: AbilitySetup;
}

export const ABILITIES: Ability[] = [
  {
    // A pipeline step that is nothing but an instruction: shape, summarize
    // or decide from what flowed in. Hidden from the launcher (there it
    // would just be Chat again) but first-class on the canvas -- it is what
    // lets a flow say "and now do THIS with the results" between two
    // tool-bearing steps.
    id: "prompt",
    title: "Prompt",
    description: "A plain instruction — shape, summarize or decide from what the previous steps produced.",
    icon: "pencil-line",
    specialist: "generalist",
    promptTemplate: "___",
    inputs: ["text", "document", "image"],
    outputs: ["text"],
    launcherHidden: true,
  },
  {
    id: "chat",
    title: "Chat",
    description: "Talk it through — questions, reasoning, writing.",
    icon: "message-circle",
    specialist: "generalist",
    promptTemplate: "___",
    suggestions: [
      "What tools do you have available right now?",
      "Summarise what you know about me so far.",
      "Help me think through a decision I'm weighing.",
    ],
    inputs: ["text"],
    outputs: ["text"],
  },
  {
    id: "web-search",
    title: "Web search",
    description: "Search the web and read pages for current answers.",
    icon: "globe",
    specialist: "researcher",
    promptTemplate: "@researcher Search the web for ___",
    suggestions: [
      "the latest news about AI models that run locally",
      "what changed in the newest macOS update",
      "reviews before I buy a standing desk",
    ],
    inputs: ["text"],
    outputs: ["text", "url"],
    requiredTools: ["web_search"],
    setup: {
      summary: "Web search needs a search backend.",
      steps: ["Check docs/browsing.md for the search configuration."],
      docs: "docs/browsing.md",
    },
  },
  {
    id: "file-search",
    title: "Find in files",
    description: "Find where something lives in your project or code — by name or exact text.",
    icon: "file-search",
    specialist: "coder",
    promptTemplate: "@coder Search my files for ___",
    suggestions: [
      "the notes I wrote about my project goals",
      "every file that mentions an invoice",
      "where my resume drafts are saved",
    ],
    inputs: ["text"],
    outputs: ["text", "file"],
    requiredTools: ["search_code"],
  },
  {
    id: "library",
    title: "My library",
    description:
      "Ask your saved documents — and what enio wrote for you — by meaning, cited by file.",
    icon: "library",
    specialist: "librarian",
    promptTemplate: "@librarian Search my library for ___",
    suggestions: [
      "the paper about context windows",
      "my apartment lease terms",
      "notes from the January planning doc",
    ],
    inputs: ["text"],
    outputs: ["text"],
    requiredTools: ["library_search"],
  },
  {
    id: "create-document",
    title: "Create document",
    description: "Write a document and save it as a markdown file.",
    icon: "file-pen",
    specialist: "coder",
    promptTemplate: "@coder Write a document about ___ and save it as a markdown file.",
    suggestions: [
      "this week's project status, one page",
      "a checklist for onboarding someone new",
      "a meeting-notes template with action items",
    ],
    inputs: ["text", "document"],
    outputs: ["document", "file"],
    requiredTools: ["write_file"],
  },
  {
    id: "develop-app",
    title: "Develop an app",
    description: "Read, write and run code in your project folders.",
    icon: "code",
    specialist: "coder",
    skill: "delegate-coding",
    promptTemplate: "@coder ___",
    suggestions: [
      "Set up a script that renames my screenshots by date",
      "Run my project's tests and explain any failure",
      "Read my project and describe how it is structured",
    ],
    inputs: ["text", "file"],
    outputs: ["file", "text"],
    requiredTools: ["run_command"],
  },
  {
    id: "ask-bigger-model",
    title: "Ask a bigger model",
    description:
      "Too big for the local model? Prepare a complete prompt to paste into Claude or ChatGPT.",
    // The honest half of running a small model: the long tail it cannot do
    // is real, and the graceful answer is packaging, not pretending. The
    // handoff file carries everything the frontier model cannot see from
    // here -- and nothing calls any cloud API; pasting is the user's act,
    // which is the whole privacy story.
    icon: "arrow-up-right",
    specialist: "coder",
    skill: "ask-bigger-model",
    promptTemplate: "/ask-bigger-model @coder ___",
    suggestions: [
      "write a 5,000-word strategy memo from my notes",
      "design the architecture for my app idea in depth",
      "rework my resume with detailed feedback on every section",
    ],
    inputs: ["text", "document"],
    outputs: ["document"],
    requiredTools: ["write_file"],
  },
  {
    id: "read-email",
    title: "Read email",
    description: "Search and read your mailbox.",
    icon: "inbox",
    specialist: "mail",
    promptTemplate: "@mail ___",
    suggestions: [
      "Did anything important arrive today?",
      "Find the last email from my accountant",
      "Summarise this week's unread messages",
    ],
    inputs: ["text"],
    outputs: ["text"],
    requiredTools: ["search_email"],
    setup: {
      summary: "Reading mail needs IMAP configured.",
      steps: [
        "Set ENIO_IMAP_HOST, ENIO_IMAP_USER and ENIO_IMAP_PASS.",
        "Restart Enio; the mail tools appear once the account connects.",
      ],
      docs: "docs/configuration.md",
    },
  },
  {
    id: "send-email",
    title: "Send email",
    description: "Draft and send email — dry-run until you enable real sending.",
    icon: "send",
    specialist: "mail",
    promptTemplate: "@mail Send an email to ___",
    suggestions: [
      "my accountant asking for the Q3 documents",
      "the team with a summary of today's progress",
      "myself with a reminder about tomorrow's deadline",
    ],
    inputs: ["text", "document"],
    outputs: ["email_draft"],
    requiredTools: ["send_email"],
    setup: {
      summary: "Sending mail needs SMTP configured.",
      steps: [
        "Set ENIO_SMTP_HOST, ENIO_SMTP_USER, ENIO_SMTP_PASS and ENIO_EMAIL_FROM.",
        "Drafts stay dry-run until ENIO_EMAIL_SEND=1.",
      ],
      docs: "docs/configuration.md",
    },
  },
  {
    id: "control-mac",
    title: "Control my Mac",
    description: "Propose app automations you approve before anything runs.",
    icon: "app-window",
    specialist: "operator",
    promptTemplate: "@operator ___",
    suggestions: [
      "Create a note with my grocery list",
      "Add lunch with Ana to my calendar, Friday noon",
      "What is on my calendar this week?",
    ],
    inputs: ["text"],
    outputs: ["plan", "text"],
    requiredTools: ["propose_plan"],
    requiredFlag: "desktopEnabled",
    setup: {
      summary: "Desktop control is off until you opt in.",
      steps: [
        "Click Enable desktop control below (or set ENIO_DESKTOP=1).",
        "macOS will still ask for Automation access per app.",
      ],
      docs: "docs/mac-control.md",
    },
  },
  {
    id: "screenshot",
    title: "Screenshot",
    description: "Capture the screen and read what's on it.",
    icon: "camera",
    specialist: "operator",
    promptTemplate: "@operator Take a screenshot ___",
    suggestions: [
      "of the whole screen and describe what's on it",
      "and read the error message in it",
      "and save it with today's date in the name",
    ],
    inputs: ["text"],
    outputs: ["image", "file"],
    requiredTools: ["take_screenshot"],
    requiredFlag: "desktopEnabled",
    setup: {
      summary: "Screenshots ride the desktop-control opt-in.",
      steps: [
        "Click Enable desktop control below (or set ENIO_DESKTOP=1).",
        "Grant Screen Recording when macOS asks.",
      ],
      docs: "docs/mac-control.md",
    },
  },
  {
    id: "remember",
    title: "Remember",
    description: "Pin a fact so every future conversation knows it.",
    icon: "brain",
    specialist: "librarian",
    promptTemplate: "@librarian Remember that ___",
    suggestions: [
      "I prefer short, direct answers",
      "my team demo is every Thursday",
      "I'm preparing for a job change this year",
    ],
    inputs: ["text"],
    outputs: ["text"],
    requiredTools: ["remember"],
  },
  {
    id: "automate-house",
    title: "Automate my house",
    description: "Lights, scenes and sensors through Home Assistant.",
    icon: "house",
    specialist: "operator",
    promptTemplate: "@operator ___",
    suggestions: [
      "Turn off every light downstairs",
      "Set the living room to movie mode",
      "Which doors are open right now?",
    ],
    inputs: ["text"],
    outputs: ["text"],
    requiredServer: "home",
    setup: {
      summary: "Home automation arrives as a Home Assistant MCP server.",
      steps: [
        "Add a Home Assistant MCP server to ~/.enio/mcp.json (enio mcp-init writes a starter).",
        "Restart Enio; its tools attach to the operator.",
      ],
      docs: "docs/mcp.md",
    },
  },
  {
    id: "shopping",
    title: "Shopping",
    description: "Research products and prices; act on sites you've logged into.",
    icon: "shopping-cart",
    specialist: "researcher",
    promptTemplate: "@researcher ___",
    suggestions: [
      "Find the best current price for AirPods Pro",
      "Compare robot vacuums under $400",
      "Is the Kindle Paperwhite cheaper anywhere this week?",
    ],
    inputs: ["text"],
    outputs: ["text", "url"],
    requiredTools: ["browse"],
    requiredFlag: "browserAct",
    setup: {
      summary: "Acting on shop pages is off until you opt in.",
      steps: [
        "Set ENIO_BROWSER_ACT=1 to allow clicking and typing on pages.",
        "Log in to shops with: enio login <url> — the password never passes through Enio.",
      ],
      docs: "docs/browsing.md",
    },
  },
  {
    id: "create-image",
    title: "Create image",
    description: "Generate images locally. Not built yet.",
    icon: "image",
    specialist: "generalist",
    promptTemplate: "___",
    inputs: ["text"],
    outputs: ["image"],
    future: true,
    setup: {
      summary: "Local image generation is on the roadmap, not in the build.",
      steps: ["Follow the repository for when a local MLX image model lands."],
      docs: "docs/README.md",
    },
  },
  {
    id: "create-video",
    title: "Create video",
    description: "Generate video. Not built yet.",
    icon: "clapperboard",
    specialist: "generalist",
    promptTemplate: "___",
    inputs: ["text"],
    outputs: ["file"],
    future: true,
    setup: {
      summary: "Local video generation is beyond what this hardware class can do today.",
      steps: ["Follow the repository; this tile exists so the answer is honest."],
      docs: "docs/README.md",
    },
  },
];

export function getAbility(id: string): Ability | null {
  return ABILITIES.find((a) => a.id === id) ?? null;
}

/** Availability, derived per request against the live registry -- cheap, and
 *  it cannot go stale the way a stored flag would. */
export function abilityAvailability(
  ability: Ability,
  registry: Registry,
  servers: string[],
): Availability {
  if (ability.future) return "future";
  if (ability.requiredTools?.some((t) => !registry.byName.has(t))) return "setup";
  if (ability.requiredFlag === "browserAct" && !config.browserAct) return "setup";
  if (ability.requiredFlag === "desktopEnabled" && !desktopEnabled()) return "setup";
  if (
    ability.requiredServer &&
    !servers.some((s) => s.toLowerCase().startsWith(ability.requiredServer!))
  ) {
    return "setup";
  }
  return "available";
}

/** The ability's skill, when it is actually installed -- pinning a missing
 *  skill would put an unresolvable /name into the composer. */
export function abilitySkill(ability: Ability): string | null {
  if (!ability.skill) return null;
  const { skills } = loadSkills();
  return skills.some((s) => s.name === ability.skill) ? ability.skill : null;
}

/** Ability ids the pipeline composer may choose from: available only. */
export function composableAbilityIds(registry: Registry, servers: string[]): string[] {
  return ABILITIES.filter(
    (a) => a.id !== "chat" && abilityAvailability(a, registry, servers) === "available",
  ).map((a) => a.id);
}

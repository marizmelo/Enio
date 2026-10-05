/**
 * Requests to open a part of the app — "open accounts", "let's set up a
 * new email account", "show my automations" — answered by the harness,
 * without the model.
 *
 * Watched happen: asked to set up a new email account, the mail agent
 * replied that it cannot create email accounts and offered to read Enio's.
 * It was right that it holds no such tool; it was wrong that nothing could
 * be done. Opening a settings panel is a user act with no blast radius, so
 * it is the same closed-list move as `open <app>`: a short grammar over a
 * fixed set of panels, resolved before routing, with one sentence back.
 */

export const PANELS = {
  accounts: { label: "Accounts", path: "Connections → Accounts" },
  connections: { label: "Connections", path: "Connections" },
  models: { label: "Models", path: "the model picker, top right" },
  memory: { label: "Memory", path: "Memory" },
  agents: { label: "Agents", path: "Agents" },
  skills: { label: "Skills", path: "Skills" },
  automations: { label: "Automations", path: "Automations" },
  projects: { label: "Projects", path: "Projects" },
  notes: { label: "Notes", path: "Notes" },
  history: { label: "History", path: "History" },
  files: { label: "Files", path: "Files" },
  avatar: { label: "Avatar", path: "the face button in the status bar" },
  settings: { label: "Settings", path: "the gear in the toolbar" },
} as const;
export type Panel = keyof typeof PANELS;

export interface PanelRequest {
  panel: Panel;
  /** A view inside the panel: "add" opens the connect flow directly. */
  view?: "add";
  /** The reply: what is opening, and where it lives for a client without a window. */
  reply: string;
}

const ALIASES: Record<string, Panel> = {
  settings: "settings",
  setting: "settings",
  integrations: "connections",
  integration: "connections",
  connections: "connections",
  connection: "connections",
  accounts: "accounts",
  account: "accounts",
  models: "models",
  model: "models",
  memory: "memory",
  agents: "agents",
  agent: "agents",
  skills: "skills",
  skill: "skills",
  automations: "automations",
  automation: "automations",
  projects: "projects",
  project: "projects",
  notes: "notes",
  note: "notes",
  history: "history",
  files: "files",
  file: "files",
  avatar: "avatar",
  face: "avatar",
};

/** The panel's name as a link the desktop can act on again later — closing
 *  a dialog by accident should cost a click, not a second request. A client
 *  without a window shows it as text, beside the path in words. */
const linkTo = (panel: Panel, view?: "add"): string =>
  `[${PANELS[panel].label}](enio://panel/${panel}${view ? `/${view}` : ""})`;

const reply = (panel: Panel, view?: "add"): string => {
  const p = PANELS[panel];
  if (panel === "accounts" && view === "add") {
    return `Opening ${linkTo(panel, view)} — your own account connects there; Enio's own account lives under Settings. In the app: ${p.path}.`;
  }
  if (panel === "connections" && view === "add") {
    return `Opening ${linkTo(panel, view)} — add the server there. In the app: ${p.path}.`;
  }
  return `Opening ${linkTo(panel)}. In the app: ${p.path}.`;
};

/** The request, or null. Short messages only: a panel name inside a
 *  paragraph about something else is not a request to open it. */
export function panelRequest(text: string): PanelRequest | null {
  const t = text.trim();
  if (t.length === 0 || t.length > 120) return null;
  const open = /^(?:please\s+)?(?:can you\s+|could you\s+)?(?:open|show|go to|take me to|bring up|launch)\s+(?:the\s+|my\s+|your\s+)?([a-z]+)(?:\s+(?:panel|dialog|page|settings|section))?\s*[.!?]?$/i.exec(t);
  if (open) {
    const panel = ALIASES[open[1]!.toLowerCase()];
    if (panel) return { panel, reply: reply(panel) };
  }
  if (/\b(?:set\s?up|setup|connect|add|link|configure)\b.{0,30}\b(?:e-?mail|mail|gmail|google|work|personal|new)?\s*(?:account|inbox)\b/i.test(t) ||
      // "set up my calendar" is a request to connect one, not to read it:
      // with nothing of the person's connected, the planner read Enio's own
      // calendar and called it "yours". Anchored to the end, so "set up my
      // calendar with a 3pm meeting" still reaches the planner.
      /\b(?:set\s?up|setup|connect|link|configure)\s+(?:my\s+|a\s+|another\s+)?(?:gmail|google|e-?mail|mail|calendar|drive)(?:\s+account)?\s*[.!?]?$/i.test(t)) {
    return { panel: "accounts", view: "add", reply: reply("accounts", "add") };
  }
  if (/\b(?:add|set\s?up|setup|connect|configure)\s+(?:a\s+|an\s+|another\s+)?(?:new\s+)?(?:mcp\s+)?(?:server|connection|integration)\b/i.test(t)) {
    return { panel: "connections", view: "add", reply: reply("connections", "add") };
  }
  return null;
}

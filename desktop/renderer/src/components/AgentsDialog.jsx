import { useEffect, useState } from "react";
import { BookOpen, Copy, Pencil, Plug, Plus, Trash2, Workflow } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { deleteAgent, fetchAgents, saveAgent, setAgentSkills } from "@/lib/agents";

/**
 * The agents: looked at for the built-ins, editable for the user's own.
 *
 * Everything shown is derived live — the tools an agent holds RIGHT NOW
 * (a mail tool without an account simply is not there), the skills whose
 * allowed-tools it can actually act on, the automations with a step that
 * runs as it. Built-in tool sets stay uneditable: six disjoint tools per
 * agent is the invariant that makes a small model pick tools well, and each
 * built-in's routing was earned by measured failures. A custom agent is the
 * same bargain chosen by the user — its own prompt and description over up
 * to five tools picked from the catalog, read_skill riding along — so
 * creating one never breaks the property, and only custom cards carry Edit
 * and Delete.
 */
export function AgentsDialog({ open, onOpenChange, onOpenSkills, onOpenPipelines }) {
  const [agents, setAgents] = useState([]);
  const [catalog, setCatalog] = useState([]);
  const [skillCatalog, setSkillCatalog] = useState([]);
  const [error, setError] = useState("");
  // Which card's skill picker is open. One at a time: it sits under the row.
  const [pinning, setPinning] = useState(null);
  // null = list; {} = creating; {name...} = editing that custom agent.
  const [editing, setEditing] = useState(null);

  useEffect(() => {
    if (!open) return;
    setEditing(null);
    (async () => {
      try {
        const body = await fetchAgents();
        setAgents(body.agents ?? []);
        setCatalog(body.catalog ?? []);
        setSkillCatalog(body.skillCatalog ?? []);
        setError("");
      } catch (err) {
        setError(String(err.message ?? err));
      }
    })();
  }, [open]);

  const remove = async (name) => {
    try {
      const body = await deleteAgent(name);
      setAgents(body.agents ?? []);
      setError("");
    } catch (err) {
      setError(String(err.message ?? err));
    }
  };

  const pin = async (name, skills) => {
    try {
      const body = await setAgentSkills(name, skills);
      setAgents(body.agents ?? []);
      setError("");
    } catch (err) {
      setError(String(err.message ?? err));
    }
  };

  // Duplicate starts a custom agent from any card, built-in included. The
  // name is cleared so it must be chosen, and the editor warns while the
  // description still matches the parent: two agents the router cannot
  // tell apart is the one way a fork makes things worse.
  const duplicate = (a) =>
    setEditing({
      forkedFrom: a.name,
      description: a.description,
      example: a.example ?? "",
      systemPrompt: a.systemPrompt ?? "",
      tools: a.tools,
      skills: a.pinnedSkills ?? [],
    });

  // The panel is a door into the places these are managed, not a second
  // manager: a skill or automation is edited where it lives.
  const jump = (opener) => {
    if (!opener) return;
    onOpenChange(false);
    opener();
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[80vh] flex-col gap-3 sm:max-w-2xl">
        <DialogHeader className="shrink-0">
          <DialogTitle>Agents</DialogTitle>
          <DialogDescription>
            Who answers what, and what each can reach right now. Memory is shared — every agent
            recalls the same facts. Routing picks the agent; @name in a message overrides it.
          </DialogDescription>
        </DialogHeader>

        {error && <p className="shrink-0 text-xs text-destructive">{error}</p>}

        {editing ? (
          <AgentEditor
            initial={editing}
            catalog={catalog}
            skillCatalog={skillCatalog}
            onDone={(nextAgents) => {
              if (nextAgents) setAgents(nextAgents);
              setEditing(null);
            }}
          />
        ) : (
          <>
            <div className="min-h-0 flex-1 space-y-3 overflow-y-auto">
              {agents.map((a) => (
                <div key={a.name} className="rounded-md border p-3">
                  <div className="flex items-baseline gap-2">
                    <span className="font-mono text-sm font-medium">@{a.name}</span>
                    {a.custom && <Badge variant="outline" className="text-[10px]">yours</Badge>}
                    <span className="ml-auto flex gap-1">
                      <Button
                        variant="ghost"
                        size="icon"
                        className="size-6"
                        title="Duplicate into a new agent of your own"
                        onClick={() => duplicate(a)}
                      >
                        <Copy className="size-3" />
                      </Button>
                      {a.custom && (
                        <>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="size-6"
                            title="Edit this agent"
                            onClick={() => setEditing(a)}
                          >
                            <Pencil className="size-3" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="size-6 text-destructive"
                            title="Delete this agent — its conversations stay"
                            onClick={() => remove(a.name)}
                          >
                            <Trash2 className="size-3" />
                          </Button>
                        </>
                      )}
                    </span>
                  </div>
                  <p className="mt-0.5 text-xs text-muted-foreground">{a.description}</p>
                  {a.custom && !a.example && (
                    <p className="mt-0.5 text-[11px] text-amber-600 dark:text-amber-500">
                      No example request yet — routing finds agents mostly by example. Edit to add one.
                    </p>
                  )}

                  <div className="mt-2 flex flex-wrap gap-1">
                    {a.tools.map((t) => (
                      <Badge
                        key={t.name}
                        variant="secondary"
                        className={`font-mono text-[10px] ${t.available ? "" : "opacity-40 line-through"}`}
                        title={t.description}
                      >
                        {t.name}
                      </Badge>
                    ))}
                    {a.mcpServers.map((m) => (
                      <Badge key={m} variant="outline" className="text-[10px]" title="MCP connection this agent may use when connected">
                        <Plug className="mr-1 size-2.5" />
                        {m}
                      </Badge>
                    ))}
                  </div>

                  <div className="mt-2 space-y-1 text-[11px] text-muted-foreground">
                    <p className="flex flex-wrap items-center gap-1">
                      <BookOpen className="size-3" />
                      {a.skills.length === 0 && <span className="italic">no skills</span>}
                      {a.skills.map((s) => (
                        <button
                          key={s}
                          className="underline-offset-2 hover:underline"
                          title="Open Skills to read or edit"
                          onClick={() => jump(onOpenSkills)}
                        >
                          {s}
                        </button>
                      ))}
                      {/* Pinning is the one edit every card accepts: know-how
                          is not capability, so attaching a skill to a built-in
                          breaks nothing the tool invariant protects. */}
                      <button
                        className="ml-1 rounded border px-1 text-[10px] hover:bg-muted"
                        title="Choose which skills this agent's prompt lists"
                        onClick={() => setPinning(pinning === a.name ? null : a.name)}
                      >
                        {pinning === a.name ? "done" : "pin…"}
                      </button>
                    </p>
                    {pinning === a.name && (
                      <SkillPicker
                        catalog={skillCatalog}
                        picked={a.pinnedSkills ?? []}
                        effective={a.skills}
                        onChange={(skills) => pin(a.name, skills)}
                      />
                    )}
                    {(a.automations.length > 0) && (
                      <div>
                        <p className="flex flex-wrap items-center gap-1">
                          <Workflow className="size-3" />
                          {a.automations.map((p) => (
                            <button
                              key={p}
                              className="underline-offset-2 hover:underline"
                              title="Open Automations to run or edit"
                              onClick={() => jump(onOpenPipelines)}
                            >
                              {p}
                            </button>
                          ))}
                        </p>
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>

            <div className="flex shrink-0 items-center justify-between gap-3">
              <p className="text-[11px] text-muted-foreground">
                A crossed-out tool is withheld until its setup exists. Tool sets are fixed at six;
                skills attach to any agent, and a skill pinned nowhere belongs to everyone.
              </p>
              <Button variant="outline" size="sm" className="shrink-0" onClick={() => setEditing({})}>
                <Plus className="mr-1 size-3" />
                New agent
              </Button>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

/**
 * Create or edit one custom agent. The same closed-list bargain as the
 * built-ins, chosen by hand: up to five tools from the catalog plus
 * read_skill. The server refuses rather than truncates, so every rule shows
 * up here as its actual error message.
 */
function AgentEditor({ initial, catalog, skillCatalog, onDone }) {
  const isNew = !initial.name;
  const [name, setName] = useState(initial.name ?? "");
  const [description, setDescription] = useState(initial.description ?? "");
  const [example, setExample] = useState(initial.example ?? "");
  const [systemPrompt, setSystemPrompt] = useState(initial.systemPrompt ?? "");
  const [tools, setTools] = useState(
    (initial.tools ?? []).map((t) => t.name ?? t).filter((t) => t !== "read_skill"),
  );
  const [skills, setSkills] = useState(initial.skills ?? []);
  // A fork that keeps its parent's description is two agents the router
  // cannot tell apart -- and at this model size it then picks one at random.
  const sameAsParent = Boolean(initial.forkedFrom) && description.trim() === (initial.description ?? "").trim();
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  const toggle = (toolName) =>
    setTools((prev) =>
      prev.includes(toolName) ? prev.filter((t) => t !== toolName) : [...prev, toolName],
    );

  const save = async () => {
    setSaving(true);
    try {
      const body = await saveAgent({ name, description, example, systemPrompt, tools, skills });
      onDone(body.agents ?? null);
    } catch (err) {
      setError(String(err.message ?? err));
      setSaving(false);
    }
  };

  const field =
    "w-full rounded-md border bg-transparent px-2 py-1.5 text-sm outline-none focus:ring-1 focus:ring-ring";

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto pr-1">
      {error && <p className="text-xs text-destructive">{error}</p>}
      {initial.forkedFrom && (
        <p className="text-[11px] text-muted-foreground">
          Duplicating <span className="font-mono">@{initial.forkedFrom}</span>. Give it a name, and
          a description that says how it differs — the router reads the description.
        </p>
      )}

      <label className="text-xs font-medium">
        Name
        <input
          className={`${field} mt-1 font-mono`}
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="editor"
          disabled={!isNew}
          title={isNew ? "" : "Names are fixed — make a new agent to rename"}
        />
      </label>

      <label className="text-xs font-medium">
        What requests should come here
        <input
          className={`${field} mt-1`}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Proofreading, rewording or tightening text the user pastes or points at."
        />
        <span className={`mt-0.5 block font-normal text-[11px] ${sameAsParent ? "text-amber-600 dark:text-amber-500" : "text-muted-foreground"}`}>
          {sameAsParent
            ? `Same as @${initial.forkedFrom} — the router will not be able to tell them apart.`
            : "Routing reads this — write it the way you'd describe the request."}
        </span>
      </label>

      <label className="text-xs font-medium">
        Example request
        <input
          className={`${field} mt-1`}
          value={example}
          onChange={(e) => setExample(e.target.value)}
          placeholder="tighten up this paragraph for me"
        />
        <span className="mt-0.5 block font-normal text-[11px] text-muted-foreground">
          A message that should land on this agent. Routing learns far more from one example
          than from the description.
        </span>
      </label>

      <label className="text-xs font-medium">
        Instructions
        <textarea
          className={`${field} mt-1 min-h-24 resize-y`}
          value={systemPrompt}
          onChange={(e) => setSystemPrompt(e.target.value)}
          placeholder="You edit text. Keep the author's voice; fix grammar quietly; never pad."
        />
      </label>

      <div className="text-xs font-medium">
        Tools — {tools.length} of 5 picked
        <span className="ml-1 font-normal text-muted-foreground">(read_skill is always included)</span>
        <div className="mt-1 max-h-48 space-y-0.5 overflow-y-auto rounded-md border p-2">
          {/* read_skill is not offered because it is not a choice — it rides
              along on every agent, and an unchecked box for it would say
              otherwise. */}
          {catalog.filter((t) => t.name !== "read_skill").map((t) => {
            const checked = tools.includes(t.name);
            const full = !checked && tools.length >= 5;
            return (
              <label
                key={t.name}
                className={`flex items-start gap-2 rounded px-1 py-0.5 text-xs ${full ? "opacity-40" : "cursor-pointer hover:bg-muted"}`}
                title={t.description}
              >
                <input
                  type="checkbox"
                  className="mt-0.5"
                  checked={checked}
                  disabled={full}
                  onChange={() => toggle(t.name)}
                />
                <span className="shrink-0 whitespace-nowrap font-mono">{t.name}</span>
                {t.server && (
                  <Badge variant="outline" className="text-[9px]">
                    <Plug className="mr-0.5 size-2" />
                    {t.server}
                  </Badge>
                )}
                <span className="truncate text-muted-foreground">{t.description}</span>
              </label>
            );
          })}
        </div>
      </div>

      <div className="text-xs font-medium">
        Skills
        <span className="ml-1 font-normal text-muted-foreground">
          (know-how this agent's prompt lists; unpinned skills that name no agent come along anyway)
        </span>
        <SkillPicker catalog={skillCatalog} picked={skills} onChange={setSkills} />
      </div>

      <div className="mt-1 flex shrink-0 justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={() => onDone(null)}>
          Cancel
        </Button>
        <Button size="sm" onClick={save} disabled={saving}>
          {isNew ? "Create agent" : "Save changes"}
        </Button>
      </div>
    </div>
  );
}

/**
 * Checkboxes over the installed skills. `picked` are the explicit pins;
 * `effective`, when given, is what the prompt will actually list after the
 * rule runs -- a skill that is in effective but not picked is there by
 * front matter or by the everyone default, and is shown as such rather
 * than as unchecked, which would invite a pointless click.
 */
function SkillPicker({ catalog, picked, effective = null, onChange }) {
  const toggle = (name) =>
    onChange(picked.includes(name) ? picked.filter((s) => s !== name) : [...picked, name]);
  if (catalog.length === 0) {
    return <p className="mt-1 text-[11px] italic text-muted-foreground">No skills installed.</p>;
  }
  return (
    <div className="mt-1 max-h-40 space-y-0.5 overflow-y-auto rounded-md border p-2">
      {catalog.map((s) => {
        const pinned = picked.includes(s.name);
        const inherited = !pinned && effective?.includes(s.name);
        return (
          <label
            key={s.name}
            className="flex cursor-pointer items-start gap-2 rounded px-1 py-0.5 text-xs hover:bg-muted"
            title={s.description}
          >
            <input type="checkbox" className="mt-0.5" checked={pinned} onChange={() => toggle(s.name)} />
            <span className="shrink-0 whitespace-nowrap font-mono">{s.name}</span>
            {inherited && (
              <span className="text-[10px] text-muted-foreground" title="Listed by its own front matter, or because no agent pins it">
                (included)
              </span>
            )}
            <span className="truncate text-muted-foreground">{s.description}</span>
          </label>
        );
      })}
    </div>
  );
}

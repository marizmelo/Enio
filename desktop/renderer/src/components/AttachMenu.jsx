import { Paperclip, Briefcase, FileText, Folder, FolderOpen, Plug, Sparkles, Users } from "lucide-react";
import { TipButton } from "@/components/TipButton";
import { useThumbnail } from "@/components/AttachmentChips";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

/**
 * The "+" menu.
 *
 * Every item writes mention syntax into the composer rather than inventing a
 * parallel protocol -- the server resolves "@file" and "/skill" for both
 * clients now, so the menu is a way to type them without knowing them.
 *
 * The listings are what the agent can actually address: the open project's
 * attached folders (by alias) and the workspace. The native dialog stays
 * first for everything else, and what it returns depends on where the file
 * lives — inside a project folder it is referenced, from anywhere else it is
 * copied in, because the filesystem tools only reach granted roots and
 * offering a path that silently fails would be worse than not offering it.
 */
export function AttachMenu({
  capabilities,
  conversationAttachments = [],
  onInsertMention,
  onInsertSkill,
  onPickFiles,
  onBrowseProject,
  onAttachStanding,
  onManageConnections,
  disabled,
}) {
  const { files = [], servers = [], skills = [], agents = [], project = null } = capabilities;

  // Project files and workspace files are one flat list from the server, but
  // they are not one idea: the project's are the folders this work is about,
  // the workspace's are conversation leftovers. Split by alias so the
  // project's get their own entry -- listed together, three hundred images
  // from one attached folder buried everything else.
  // Mount aliases — the project's AND the conversation's — are excluded from
  // the workspace-derived listings below: their files arrive in the same flat
  // list from the server, and deriving a "folder" from them would list every
  // mount twice.
  const aliases = new Set(
    [...(project?.attachments ?? []), ...conversationAttachments].map((a) => a.alias),
  );
  const workspaceFiles = [];
  let projectFileCount = 0;
  for (const f of files) {
    if (aliases.has(f.split("/")[0])) projectFileCount++;
    else workspaceFiles.push(f);
  }

  const folders = [...new Set(
    workspaceFiles.filter((f) => f.includes("/")).map((f) => f.split("/")[0]),
  )].sort();

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <TipButton tip="Attach a file, skill or agent" disabled={disabled}>
          <Paperclip className="size-4" />
        </TipButton>
      </DropdownMenuTrigger>

      <DropdownMenuContent align="start" side="top" className="w-64">
        {/* Standing scope first: files and folders granted for the whole
            project or conversation, not one message. The label names where
            the grant lands so the same gesture never surprises. */}
        <DropdownMenuItem onSelect={onAttachStanding}>
          <FolderOpen className="mr-2 size-4" />
          {project ? "Add to project…" : "Add to conversation…"}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuLabel>Add to this message</DropdownMenuLabel>
        <DropdownMenuSeparator />

        {/* Browsing the disk comes first. The workspace list below is only
            useful once something is already in there, which on a fresh install
            is never — the menu used to open onto "Workspace is empty" with no
            way to put anything in it. */}
        <DropdownMenuItem onSelect={onPickFiles}>
          <FileText className="mr-2 size-4" />
          Choose file or image…
        </DropdownMenuItem>

        {/* A modal rather than a submenu, and labelled by the *idea* rather
            than the project's name: one attached folder here holds hundreds
            of files, which a menu can only truncate and cannot search or
            walk into. Above the workspace, because with a project open these
            are what the work is about. */}
        {projectFileCount > 0 && (
          <DropdownMenuItem onSelect={onBrowseProject}>
            <Briefcase className="mr-2 size-4" />
            From project…
            <span className="ml-auto pl-2 text-[10px] text-muted-foreground">
              {projectFileCount}
            </span>
          </DropdownMenuItem>
        )}

        <DropdownMenuSub>
          <DropdownMenuSubTrigger>
            <FileText className="mr-2 size-4" />
            From workspace
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent className="max-h-72 overflow-y-auto">
            {workspaceFiles.length === 0 ? (
              <DropdownMenuItem disabled>Workspace is empty</DropdownMenuItem>
            ) : (
              workspaceFiles.slice(0, 100).map((f) => (
                <FileItem key={f} path={f} onSelect={() => onInsertMention(f)} />
              ))
            )}
          </DropdownMenuSubContent>
        </DropdownMenuSub>

        <DropdownMenuSub>
          <DropdownMenuSubTrigger>
            <Folder className="mr-2 size-4" />
            Folder
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent className="max-h-72 overflow-y-auto">
            {/* Folders the user granted come first, straight from live state
                rather than the capabilities cache — the workspace subfolders
                below only exist once something created them, which on a
                fresh install is never. */}
            {[
              ...(project?.attachments ?? []),
              ...conversationAttachments,
            ]
              .filter((a) => a.kind === "folder")
              .map((a) => (
                <DropdownMenuItem key={`mount-${a.alias}`} onSelect={() => onInsertMention(a.alias)}>
                  <span className="truncate font-mono text-xs">{a.alias}/</span>
                </DropdownMenuItem>
              ))}
            {folders.map((d) => (
              <DropdownMenuItem key={d} onSelect={() => onInsertMention(d)}>
                <span className="truncate font-mono text-xs">{d}/</span>
              </DropdownMenuItem>
            ))}
            {/* Empty is a dead end unless it says how to stop being empty. */}
            {folders.length === 0 &&
              ![...(project?.attachments ?? []), ...conversationAttachments].some(
                (a) => a.kind === "folder",
              ) && (
                <DropdownMenuItem onSelect={onAttachStanding}>
                  <FolderOpen className="mr-2 size-4" />
                  Attach a folder…
                </DropdownMenuItem>
              )}
          </DropdownMenuSubContent>
        </DropdownMenuSub>

        <DropdownMenuSub>
          <DropdownMenuSubTrigger>
            <Plug className="mr-2 size-4" />
            Connection
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent>
            {servers.length === 0 ? (
              <DropdownMenuItem disabled>No connections yet</DropdownMenuItem>
            ) : (
              servers.map((s) => (
                <DropdownMenuItem key={s} onSelect={() => onInsertMention(s)}>
                  {s}
                </DropdownMenuItem>
              ))
            )}
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={onManageConnections}>
              Manage connections…
            </DropdownMenuItem>
          </DropdownMenuSubContent>
        </DropdownMenuSub>

        <DropdownMenuSeparator />

        <DropdownMenuSub>
          <DropdownMenuSubTrigger>
            <Sparkles className="mr-2 size-4" />
            Skill
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent className="w-72">
            {skills.length === 0 ? (
              <DropdownMenuItem disabled>No skills installed</DropdownMenuItem>
            ) : (
              skills.map((s) => (
                <DropdownMenuItem
                  key={s.name}
                  onSelect={() => onInsertSkill(s.name)}
                  className="flex-col items-start gap-0.5"
                >
                  <span className="font-medium">{s.name}</span>
                  <span className="line-clamp-2 text-xs text-muted-foreground">
                    {s.description}
                  </span>
                </DropdownMenuItem>
              ))
            )}
          </DropdownMenuSubContent>
        </DropdownMenuSub>

        {/* Routing is normally the router's call. This is an override for when
            it picks wrong, which is why it sits last rather than first. */}
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>
            <Users className="mr-2 size-4" />
            Send to agent
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent className="w-72">
            {agents.map((s) => (
              <DropdownMenuItem
                key={s.name}
                onSelect={() => onInsertMention(s.name)}
                className="flex-col items-start gap-0.5"
              >
                <span className="font-medium">{s.name}</span>
                <span className="text-xs text-muted-foreground">
                  {s.tools?.length ?? 0} tools
                </span>
              </DropdownMenuItem>
            ))}
          </DropdownMenuSubContent>
        </DropdownMenuSub>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * One workspace file, with a thumbnail when it is an image.
 *
 * A list of names is enough to pick `budget.csv` out of and useless for
 * picking between four screenshots — which is exactly the case where a file
 * gets attached from this menu. The thumbnail loads through the same bridge
 * the chips use and simply does not appear for anything that is not a
 * previewable image, so the row never waits on it.
 */
function FileItem({ path, onSelect }) {
  const src = useThumbnail(path);

  return (
    <DropdownMenuItem onSelect={onSelect} className="gap-2">
      {src ? (
        <img src={src} alt="" className="size-7 shrink-0 rounded object-cover" />
      ) : (
        <span className="flex size-7 shrink-0 items-center justify-center rounded bg-muted">
          <FileText className="size-3.5 text-muted-foreground" />
        </span>
      )}
      <span className="truncate font-mono text-xs">{path}</span>
    </DropdownMenuItem>
  );
}

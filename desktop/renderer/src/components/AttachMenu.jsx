import { Paperclip, FileText, Folder, Plug, Sparkles, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
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
 * Files come from the workspace listing rather than a native file dialog. The
 * filesystem tools are hard-scoped to the workspace, so a file chosen from
 * anywhere else could not be read anyway; offering the whole disk would be an
 * invitation to pick something that silently fails.
 */
export function AttachMenu({ capabilities, onInsertMention, onInsertSkill, disabled }) {
  const { files = [], servers = [], skills = [], agents = [] } = capabilities;

  const folders = [...new Set(
    files.filter((f) => f.includes("/")).map((f) => f.split("/")[0]),
  )].sort();

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button size="icon" variant="ghost" disabled={disabled} title="Attach">
          <Paperclip className="size-4" />
        </Button>
      </DropdownMenuTrigger>

      <DropdownMenuContent align="start" side="top" className="w-64">
        <DropdownMenuLabel>Add to this message</DropdownMenuLabel>
        <DropdownMenuSeparator />

        <DropdownMenuSub>
          <DropdownMenuSubTrigger>
            <FileText className="mr-2 size-4" />
            File or image
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent className="max-h-72 overflow-y-auto">
            {files.length === 0 ? (
              <DropdownMenuItem disabled>Workspace is empty</DropdownMenuItem>
            ) : (
              files.slice(0, 100).map((f) => (
                <DropdownMenuItem key={f} onSelect={() => onInsertMention(f)}>
                  <span className="truncate font-mono text-xs">{f}</span>
                </DropdownMenuItem>
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
            {folders.length === 0 ? (
              <DropdownMenuItem disabled>No folders</DropdownMenuItem>
            ) : (
              folders.map((d) => (
                <DropdownMenuItem key={d} onSelect={() => onInsertMention(d)}>
                  <span className="truncate font-mono text-xs">{d}/</span>
                </DropdownMenuItem>
              ))
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
              <DropdownMenuItem disabled>No MCP servers configured</DropdownMenuItem>
            ) : (
              servers.map((s) => (
                <DropdownMenuItem key={s} onSelect={() => onInsertMention(s)}>
                  {s}
                </DropdownMenuItem>
              ))
            )}
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

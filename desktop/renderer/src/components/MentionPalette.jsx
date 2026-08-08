import { Command, CommandGroup, CommandItem, CommandList } from "@/components/ui/command";

/**
 * The "@" palette: agents, workspace files, and MCP connections.
 *
 * All three share one prefix because the server resolves them from one
 * namespace — parseMentions checks agents, then servers, then files, and the
 * first match wins. Splitting them across different trigger characters in the
 * UI would invent a distinction the grammar does not have.
 */
export function MentionPalette({ groups, onPick }) {
  return (
    <div className="absolute bottom-full left-3 right-3 z-20 mb-2">
      <Command className="rounded-lg border bg-popover shadow-md" shouldFilter={false}>
        <CommandList className="max-h-64">
          {groups.map((group) => (
            <CommandGroup key={group.heading} heading={group.heading}>
              {group.items.map((item) => (
                <CommandItem
                  key={`${group.heading}-${item.token}`}
                  value={`${group.heading}-${item.token}`}
                  onSelect={() => onPick(item.token)}
                  className="flex-col items-start gap-0.5"
                >
                  <span className="font-medium">@{item.token}</span>
                  {item.hint && (
                    <span className="line-clamp-2 text-xs text-muted-foreground">
                      {item.hint}
                    </span>
                  )}
                </CommandItem>
              ))}
            </CommandGroup>
          ))}
        </CommandList>
      </Command>
    </div>
  );
}

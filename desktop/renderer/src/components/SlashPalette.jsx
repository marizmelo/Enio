import { Command, CommandEmpty, CommandGroup, CommandItem, CommandList } from "@/components/ui/command";

/**
 * The "/" palette.
 *
 * Opens only while the whole box is a single "/word", which is the same rule
 * the server applies: a slash is a command as the first token and a path
 * separator everywhere else. Matching that exactly means the palette never
 * offers something the server would then refuse to resolve.
 */
export function SlashPalette({ matches, onPick }) {
  return (
    <div className="absolute bottom-full left-3 right-3 z-20 mb-2">
      <Command className="rounded-lg border bg-popover shadow-md" shouldFilter={false}>
        <CommandList className="max-h-64">
          <CommandEmpty>No skill matches.</CommandEmpty>
          <CommandGroup heading="Skills — Enter takes the first">
            {matches.map((s) => (
              <CommandItem
                key={s.name}
                value={s.name}
                onSelect={() => onPick(s.name)}
                className="flex-col items-start gap-0.5"
              >
                <span className="font-medium">/{s.name}</span>
                <span className="line-clamp-2 text-xs text-muted-foreground">
                  {s.description}
                </span>
              </CommandItem>
            ))}
          </CommandGroup>
        </CommandList>
      </Command>
    </div>
  );
}

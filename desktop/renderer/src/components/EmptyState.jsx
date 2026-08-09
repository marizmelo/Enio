import { Button } from "@/components/ui/button";
// The same file the app icon and the menu bar icon are built from, so the
// three cannot disagree about what the mark looks like.
import logo from "../../../assets/enio-logo.svg";

const EXAMPLES = [
  "What tools do you have available right now?",
  "Remember that I prefer concise answers.",
  "Summarise what you know about me so far.",
];

export function EmptyState({ onPick, disabled }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-6 px-6 text-center">
      <div className="space-y-4">
        {/* Inlined rather than an <img> so it renders as vector rather than a
            rasterised copy scaled to fit — the outlines are hairlines and stair
            -step otherwise. Two-tone and outlined, so it needs no surface
            behind it, the same property that let the app icon drop its
            container. */}
        <div
          aria-hidden="true"
          className="mx-auto [&>svg]:mx-auto [&>svg]:h-24 [&>svg]:w-auto"
          dangerouslySetInnerHTML={{ __html: logo }}
        />
        <h1 className="text-2xl font-semibold tracking-tight">Enio</h1>
        <p className="text-sm text-muted-foreground">
          A local agent with tools and memory. Nothing leaves your machine.
        </p>
      </div>

      <div className="flex w-full max-w-md flex-col gap-2">
        {EXAMPLES.map((prompt) => (
          <Button
            key={prompt}
            variant="outline"
            disabled={disabled}
            className="h-auto justify-start whitespace-normal px-3.5 py-2.5 text-left text-sm font-normal"
            onClick={() => onPick(prompt)}
          >
            {prompt}
          </Button>
        ))}
      </div>
    </div>
  );
}

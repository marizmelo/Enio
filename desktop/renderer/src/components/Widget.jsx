import { ClockWidget } from "@/components/widgets/ClockWidget";
import { WeatherWidget } from "@/components/widgets/WeatherWidget";
import { PlanWidget } from "@/components/widgets/PlanWidget";
import { ImageWidget } from "@/components/widgets/ImageWidget";

/**
 * Dispatches a widget payload to its renderer.
 *
 * An unknown type renders nothing, deliberately. The tool's text has already
 * been streamed into the bubble above, so a widget this client cannot draw
 * costs the user nothing — which is what lets a newer server talk to an older
 * app without a version negotiation. The same property is why the CLI needs no
 * fallback code at all: it never subscribes to the channel.
 */
const RENDERERS = {
  clock: ClockWidget,
  weather: WeatherWidget,
  plan: PlanWidget,
  image: ImageWidget,
};

export function Widget({ widget, onOpenFile }) {
  const Renderer = RENDERERS[widget?.type];
  if (!Renderer) return null;
  return <Renderer {...widget} onOpenFile={onOpenFile} />;
}

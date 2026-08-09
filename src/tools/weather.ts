import { config } from "../config.js";
import type { ToolDef } from "../types.js";

/**
 * Where the user is, and what the weather is doing there.
 *
 * Location is guessed from the machine's own time zone rather than an IP
 * lookup. An IP geolocation service would be a request to a third party on
 * every turn that mentions the weather, revealing roughly where someone lives
 * to a company they never chose — which is a strange thing for an agent whose
 * entire claim is that nothing leaves your machine. A time zone is already on
 * the machine, needs no request, and names a city directly.
 *
 * It is a guess, so it is overridable: ENIO_LOCATION wins, and so does the user
 * naming a place in the question.
 *
 * The forecast itself does need the network — weather is not a local fact. It
 * uses Open-Meteo, which needs no key and no account, so nothing about this
 * requires signing up for anything.
 */

const GEOCODE = "https://geocoding-api.open-meteo.com/v1/search";
const FORECAST = "https://api.open-meteo.com/v1/forecast";

/** WMO weather codes. The API returns a number; people want a word. */
const CONDITIONS: Record<number, string> = {
  0: "clear sky",
  1: "mainly clear",
  2: "partly cloudy",
  3: "overcast",
  45: "fog",
  48: "freezing fog",
  51: "light drizzle",
  53: "drizzle",
  55: "heavy drizzle",
  56: "freezing drizzle",
  57: "heavy freezing drizzle",
  61: "light rain",
  63: "rain",
  65: "heavy rain",
  66: "freezing rain",
  67: "heavy freezing rain",
  71: "light snow",
  73: "snow",
  75: "heavy snow",
  77: "snow grains",
  80: "light showers",
  81: "showers",
  82: "violent showers",
  85: "snow showers",
  86: "heavy snow showers",
  95: "thunderstorm",
  96: "thunderstorm with hail",
  99: "thunderstorm with heavy hail",
};

/**
 * The best guess at where this machine is, without asking anyone.
 *
 * A zone like "Europe/Lisbon" carries the city in its second half. Underscores
 * become spaces so "America/New_York" geocodes as a place rather than a token.
 */
export function guessedLocation(): string {
  if (config.location) return config.location;

  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone ?? "";
  const city = zone.split("/").pop() ?? "";
  return city.replace(/_/g, " ");
}

async function geocode(place: string): Promise<{
  name: string;
  country: string;
  latitude: number;
  longitude: number;
} | null> {
  const url = new URL(GEOCODE);
  url.searchParams.set("name", place);
  url.searchParams.set("count", "1");

  const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) return null;

  const data = (await res.json()) as {
    results?: { name: string; country: string; latitude: number; longitude: number }[];
  };
  return data.results?.[0] ?? null;
}

export const weatherTools: ToolDef[] = [
  {
    name: "weather",
    description:
      "Current weather and today's forecast for a place. Omit the location to use where this machine is. " +
      "Use whenever the user asks about weather, temperature, rain, or what to wear.",
    origin: "builtin",
    parameters: {
      type: "object",
      properties: {
        location: {
          type: "string",
          description:
            "City or place name, e.g. Lisbon. Omit to use the machine's own location.",
        },
      },
      required: [],
    },
    async run(args) {
      const asked = typeof args.location === "string" ? args.location.trim() : "";
      const place = asked || guessedLocation();

      if (!place) {
        return "I could not work out a location. Ask again with a city name, or set ENIO_LOCATION.";
      }

      try {
        const found = await geocode(place);
        if (!found) {
          return `I could not find a place called "${place}".`;
        }

        const url = new URL(FORECAST);
        url.searchParams.set("latitude", String(found.latitude));
        url.searchParams.set("longitude", String(found.longitude));
        url.searchParams.set(
          "current",
          "temperature_2m,apparent_temperature,relative_humidity_2m,precipitation,weather_code,wind_speed_10m",
        );
        url.searchParams.set("daily", "temperature_2m_max,temperature_2m_min,precipitation_probability_max");
        url.searchParams.set("timezone", "auto");
        url.searchParams.set("forecast_days", "1");

        const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
        if (!res.ok) return `The weather service returned ${res.status}.`;

        const data = (await res.json()) as {
          current?: Record<string, number>;
          daily?: Record<string, number[]>;
        };
        const now = data.current ?? {};
        const day = data.daily ?? {};

        const condition = CONDITIONS[now.weather_code ?? -1] ?? "unclear conditions";
        const where = `${found.name}, ${found.country}`;

        // Written as a sentence rather than a table: this gets read aloud as
        // often as it gets read, and a table does not survive being spoken.
        const text =
          `${where}: ${condition}, ${Math.round(now.temperature_2m ?? 0)}°C ` +
          `(feels like ${Math.round(now.apparent_temperature ?? 0)}°C). ` +
          `Humidity ${Math.round(now.relative_humidity_2m ?? 0)}%, ` +
          `wind ${Math.round(now.wind_speed_10m ?? 0)} km/h. ` +
          `Today ${Math.round(day.temperature_2m_min?.[0] ?? 0)} to ` +
          `${Math.round(day.temperature_2m_max?.[0] ?? 0)}°C, ` +
          `${Math.round(day.precipitation_probability_max?.[0] ?? 0)}% chance of rain.` +
          (asked ? "" : `\n(Location guessed from this machine's time zone.)`);

        return {
          text,
          widget: {
            type: "weather",
            place: where,
            condition,
            temperature: Math.round(now.temperature_2m ?? 0),
            feelsLike: Math.round(now.apparent_temperature ?? 0),
            high: Math.round(day.temperature_2m_max?.[0] ?? 0),
            low: Math.round(day.temperature_2m_min?.[0] ?? 0),
            rainChance: Math.round(day.precipitation_probability_max?.[0] ?? 0),
          },
        };
      } catch (err) {
        // Offline is the normal case for a laptop, not an exception worth
        // making a fuss about.
        return `Could not reach the weather service (${(err as Error).message}).`;
      }
    },
  },
];

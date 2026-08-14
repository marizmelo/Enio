/**
 * Structured schedules ⇄ cron, so the UI never shows a cron expression.
 *
 * The builder is a closed form — repeat kind, time, days — and composes to
 * cron only because that is what the tasks table stores. The describer reads
 * back exactly the shapes the builder writes, nothing more: this is not a
 * general cron parser, and anything authored outside these shapes (the CLI
 * accepts arbitrary cron) displays as "Custom schedule", with the next-run
 * tooltip carrying the real information. Raw cron in the chip was tried and
 * rejected on sight — it is a storage format, not an interface.
 */

export const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** {repeat, time, days, dayOfMonth} → cron. Unknown repeat returns null. */
export function composeSchedule({ repeat, time = "09:00", days = [], dayOfMonth = 1 }) {
  const [h, m] = time.split(":").map(Number);
  if (repeat !== "hourly" && (!Number.isInteger(h) || !Number.isInteger(m))) return null;
  switch (repeat) {
    case "hourly":
      return "0 * * * *";
    case "daily":
      return `${m} ${h} * * *`;
    case "weekdays":
      return `${m} ${h} * * 1-5`;
    case "weekly": {
      const list = [...new Set(days)]
        .filter((d) => Number.isInteger(d) && d >= 0 && d <= 6)
        .sort((a, b) => a - b)
        .join(",");
      return list ? `${m} ${h} * * ${list}` : null;
    }
    case "monthly": {
      const dom = Number(dayOfMonth);
      if (!Number.isInteger(dom) || dom < 1 || dom > 31) return null;
      return `${m} ${h} ${dom} * *`;
    }
    default:
      return null;
  }
}

/** cron → the builder's form, or null when the shape is not one it writes. */
export function parseSchedule(cron) {
  const parts = String(cron ?? "").trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const [m, h, dom, mon, dow] = parts;
  if (cron.trim() === "0 * * * *") return { repeat: "hourly", time: "09:00", days: [], dayOfMonth: 1 };
  if (!/^\d{1,2}$/.test(m) || !/^\d{1,2}$/.test(h) || mon !== "*") return null;
  const time = `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
  if (dom === "*" && dow === "*") return { repeat: "daily", time, days: [], dayOfMonth: 1 };
  if (dom === "*" && dow === "1-5") return { repeat: "weekdays", time, days: [1, 2, 3, 4, 5], dayOfMonth: 1 };
  if (dom === "*" && /^[0-6](,[0-6])*$/.test(dow)) {
    return { repeat: "weekly", time, days: dow.split(",").map(Number), dayOfMonth: 1 };
  }
  if (dow === "*" && /^\d{1,2}$/.test(dom) && Number(dom) >= 1 && Number(dom) <= 31) {
    return { repeat: "monthly", time, days: [], dayOfMonth: Number(dom) };
  }
  return null;
}

function formatTime(time) {
  const [h, m] = time.split(":").map(Number);
  try {
    return new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(
      new Date(2000, 0, 1, h, m),
    );
  } catch {
    return time;
  }
}

function ordinal(n) {
  const rem10 = n % 10;
  const rem100 = n % 100;
  if (rem10 === 1 && rem100 !== 11) return `${n}st`;
  if (rem10 === 2 && rem100 !== 12) return `${n}nd`;
  if (rem10 === 3 && rem100 !== 13) return `${n}rd`;
  return `${n}th`;
}

/** Plain words for the chip. Falls back to "Custom schedule", never to cron. */
export function describeSchedule(cron) {
  const form = parseSchedule(cron);
  if (!form) return "Custom schedule";
  switch (form.repeat) {
    case "hourly":
      return "Every hour";
    case "daily":
      return `Daily at ${formatTime(form.time)}`;
    case "weekdays":
      return `Weekdays at ${formatTime(form.time)}`;
    case "weekly":
      return `${form.days.map((d) => DAY_NAMES[d]).join(", ")} at ${formatTime(form.time)}`;
    case "monthly":
      return `Monthly on the ${ordinal(form.dayOfMonth)} at ${formatTime(form.time)}`;
    default:
      return "Custom schedule";
  }
}

import { test, describe } from "node:test";
import assert from "node:assert/strict";

/**
 * The structured-schedule ⇄ cron mapping behind the desktop's schedule
 * editor. The invariant that matters: describeSchedule never outputs a cron
 * expression — the raw string is storage, and anything the closed shapes
 * don't cover reads "Custom schedule" rather than leaking syntax.
 */
const LIB = "../desktop/renderer/src/lib/schedule.js";
const { composeSchedule, parseSchedule, describeSchedule } = await import(LIB);

describe("composeSchedule", () => {
  test("writes the closed shapes", () => {
    assert.equal(composeSchedule({ repeat: "hourly" }), "0 * * * *");
    assert.equal(composeSchedule({ repeat: "daily", time: "09:00" }), "0 9 * * *");
    assert.equal(composeSchedule({ repeat: "weekdays", time: "08:30" }), "30 8 * * 1-5");
    assert.equal(
      composeSchedule({ repeat: "weekly", time: "17:15", days: [5, 1] }),
      "15 17 * * 1,5",
    );
    assert.equal(
      composeSchedule({ repeat: "monthly", time: "07:00", dayOfMonth: 15 }),
      "0 7 15 * *",
    );
  });

  test("refuses what would fire wrong instead of guessing", () => {
    assert.equal(composeSchedule({ repeat: "weekly", time: "09:00", days: [] }), null);
    assert.equal(composeSchedule({ repeat: "monthly", time: "09:00", dayOfMonth: 42 }), null);
    assert.equal(composeSchedule({ repeat: "fortnightly", time: "09:00" }), null);
    assert.equal(composeSchedule({ repeat: "daily", time: "not-a-time" }), null);
  });
});

describe("parseSchedule", () => {
  test("round-trips everything the builder writes", () => {
    for (const form of [
      { repeat: "hourly", time: "09:00", days: [], dayOfMonth: 1 },
      { repeat: "daily", time: "06:45", days: [], dayOfMonth: 1 },
      { repeat: "weekdays", time: "09:00", days: [1, 2, 3, 4, 5], dayOfMonth: 1 },
      { repeat: "weekly", time: "17:15", days: [1, 5], dayOfMonth: 1 },
      { repeat: "monthly", time: "07:00", days: [], dayOfMonth: 15 },
    ] as const) {
      const cron = composeSchedule(form);
      assert.ok(cron, `${form.repeat} must compose`);
      assert.deepEqual(parseSchedule(cron), form, `${form.repeat} must round-trip`);
    }
  });

  test("a shape the builder cannot write parses to null, not to a wrong form", () => {
    for (const cron of ["*/5 * * * *", "0 9 * 6 *", "0 9 1 * 1", "0 22 29-31 * *", "garbage", ""]) {
      assert.equal(parseSchedule(cron), null, cron);
    }
  });
});

describe("describeSchedule", () => {
  test("speaks plain words, never cron", () => {
    assert.equal(describeSchedule("0 * * * *"), "Every hour");
    assert.match(describeSchedule("0 9 * * *"), /^Daily at /);
    assert.match(describeSchedule("30 8 * * 1-5"), /^Weekdays at /);
    assert.match(describeSchedule("15 17 * * 1,5"), /^Mon, Fri at /);
    assert.match(describeSchedule("0 7 15 * *"), /^Monthly on the 15th at /);
    // Ordinals that trip naive suffixing.
    assert.match(describeSchedule("0 7 1 * *"), /the 1st/);
    assert.match(describeSchedule("0 7 2 * *"), /the 2nd/);
    assert.match(describeSchedule("0 7 3 * *"), /the 3rd/);
    assert.match(describeSchedule("0 7 11 * *"), /the 11th/);
    assert.match(describeSchedule("0 7 21 * *"), /the 21st/);
  });

  test("a CLI-authored exotic cron shows as Custom schedule, not as syntax", () => {
    for (const cron of ["*/10 * * * *", "0 9 * 6 1", "not cron at all"]) {
      const label = describeSchedule(cron);
      assert.equal(label, "Custom schedule");
      assert.ok(!label.includes("*"), "no cron syntax may leak into the chip");
    }
  });
});

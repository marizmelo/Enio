/**
 * The Google path that needs no Google Cloud project.
 *
 * The OAuth route works, but every user has to register their own client
 * first -- five Console steps -- and that cost exists only because Google
 * ties Gmail and Calendar scopes to a registered application. An Apps Script
 * sidesteps it entirely: the script runs *inside the user's own account*,
 * authorized by them in Google's own consent flow, so there is no client to
 * register, no consent screen to publish, no verification, and no seven-day
 * refresh-token expiry.
 *
 * Enio cannot deploy it for them, and that is not an oversight: deploying a
 * script through the Apps Script API needs a Cloud project and OAuth
 * credentials, which is exactly the thing this avoids. So enio ships the
 * source -- with a secret already baked in -- and the user pastes and
 * deploys it. One paste, six clicks, nothing depending on whoever published
 * enio.
 *
 * What it costs, stated plainly because it is a real trade: the deployment
 * URL is a bearer credential. Whoever holds it can call whatever the script
 * exposes, and revoking means deleting the deployment rather than turning
 * off one grant. The mitigations are that the script only ever exposes the
 * operations below -- a closed list, the same transformation as everywhere
 * else here -- and that every call carries a shared secret, so a leaked URL
 * alone is not enough.
 */

/** Bumped whenever OPERATIONS change, so a stale deployment is detected
 *  rather than failing on an unknown op with a confusing error. */
export const SCRIPT_VERSION = 2;

/** What the script can do. The model never picks from this freely -- the
 *  harness calls one by name -- but it is the whole surface of what a
 *  deployment URL can be made to do, which is why it is short and why
 *  nothing here deletes anything. */
export const OPERATIONS = [
  "ping",
  "mail.recent",
  "mail.read",
  "mail.send",
  "calendar.upcoming",
  "calendar.add",
  "drive.find",
  "drive.read",
] as const;

export type Operation = (typeof OPERATIONS)[number];

/**
 * The script source, with the caller's secret embedded.
 *
 * Written to be readable by the person pasting it: they are about to grant
 * it their mailbox, and code they cannot follow is code they cannot consent
 * to. Every operation is a named function; there is no eval, no dynamic
 * dispatch beyond a lookup table, and nothing that deletes.
 */
export function scriptSource(secret: string): string {
  return `/**
 * Enio bridge — v${SCRIPT_VERSION}
 *
 * Runs in YOUR Google account. Enio calls it over HTTPS with the secret
 * below; nothing else can use it without that secret.
 *
 * Deploy: Deploy > New deployment > Web app
 *   Execute as: Me
 *   Who has access: Anyone
 * Then copy the /exec URL back into Enio.
 *
 * To revoke: Deploy > Manage deployments > Archive, or delete this project.
 */

const SECRET = ${JSON.stringify(secret)};
const VERSION = ${SCRIPT_VERSION};

// The self-check: open the /exec URL in a private browser window and this
// line is what you should see. It proves anonymous access reaches the
// script -- the exact thing a misconfigured deployment silently lacks --
// and it exposes nothing, least of all the secret.
function doGet() {
  return ContentService.createTextOutput(
    "Enio bridge v" + VERSION + " is running. This deployment is reachable."
  );
}

function doPost(e) {
  var body;
  try {
    body = JSON.parse(e.postData.contents);
  } catch (err) {
    return reply({ error: "bad request" });
  }
  // Constant-ish comparison: the URL may leak (it rides in a browser bar
  // during setup), so the secret is what actually authorizes a call.
  if (!body || body.secret !== SECRET) return reply({ error: "unauthorized" });

  var op = OPS[body.op];
  if (!op) return reply({ error: "unknown operation: " + body.op });
  try {
    return reply({ ok: op(body.args || {}) });
  } catch (err) {
    return reply({ error: String(err && err.message ? err.message : err) });
  }
}

function reply(payload) {
  return ContentService.createTextOutput(JSON.stringify(payload)).setMimeType(
    ContentService.MimeType.JSON
  );
}

var OPS = {
  "ping": function () {
    return { version: VERSION, email: Session.getActiveUser().getEmail() };
  },

  "mail.recent": function (a) {
    var max = Math.min(a.max || 10, 25);
    var threads = GmailApp.search(a.query || "in:inbox", 0, max);
    return threads.map(function (t) {
      var m = t.getMessages()[t.getMessageCount() - 1];
      return {
        id: m.getId(),
        from: m.getFrom(),
        to: m.getTo(),
        subject: m.getSubject(),
        date: m.getDate().toISOString(),
        unread: t.isUnread(),
        snippet: m.getPlainBody().slice(0, 300),
      };
    });
  },

  "mail.read": function (a) {
    var m = GmailApp.getMessageById(a.id);
    return {
      id: m.getId(),
      from: m.getFrom(),
      to: m.getTo(),
      subject: m.getSubject(),
      date: m.getDate().toISOString(),
      body: m.getPlainBody().slice(0, 20000),
    };
  },

  "mail.send": function (a) {
    if (!a.to || !a.subject) throw new Error("to and subject are required");
    GmailApp.sendEmail(a.to, a.subject, a.body || "");
    return { sent: true, to: a.to };
  },

  "calendar.upcoming": function (a) {
    var days = Math.min(a.days || 7, 60);
    var now = new Date();
    var end = new Date(now.getTime() + days * 86400000);
    return CalendarApp.getDefaultCalendar()
      .getEvents(now, end)
      .slice(0, 50)
      .map(function (ev) {
        return {
          id: ev.getId(),
          title: ev.getTitle(),
          start: ev.getStartTime().toISOString(),
          end: ev.getEndTime().toISOString(),
          location: ev.getLocation(),
        };
      });
  },

  "calendar.add": function (a) {
    if (!a.title || !a.start || !a.end) throw new Error("title, start and end are required");
    var ev = CalendarApp.getDefaultCalendar().createEvent(
      a.title,
      new Date(a.start),
      new Date(a.end),
      { description: a.description || "", location: a.location || "" }
    );
    return { id: ev.getId(), title: ev.getTitle() };
  },

  "drive.find": function (a) {
    var files = DriveApp.searchFiles(
      'title contains "' + String(a.query || "").replace(/"/g, '') + '"'
    );
    var out = [];
    while (files.hasNext() && out.length < 20) {
      var f = files.next();
      out.push({ id: f.getId(), name: f.getName(), type: f.getMimeType(), url: f.getUrl() });
    }
    return out;
  },

  "drive.read": function (a) {
    var f = DriveApp.getFileById(a.id);
    var type = f.getMimeType();
    // A Google Doc has no plain bytes; export it as text instead of
    // returning something unreadable.
    if (type === "application/vnd.google-apps.document") {
      return { name: f.getName(), text: DocumentApp.openById(a.id).getBody().getText().slice(0, 20000) };
    }
    if (type.indexOf("text/") === 0 || type === "application/json") {
      return { name: f.getName(), text: f.getBlob().getDataAsString().slice(0, 20000) };
    }
    return { name: f.getName(), type: type, note: "Not a text file; nothing was read." };
  },
};
`;
}

/**
 * Call a deployed script.
 *
 * Errors come back as values rather than thrown, for the same reason the
 * cloud send does: a failure here is "this did not work", which the caller
 * shows, not an exception that reads as enio being broken.
 */
export async function callScript(
  url: string,
  secret: string,
  op: Operation,
  args: Record<string, unknown> = {},
): Promise<{ ok: true; result: unknown } | { ok: false; error: string }> {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ secret, op, args }),
      // Apps Script answers a web app call with a 302 to a googleusercontent
      // URL; without following it the body never arrives.
      redirect: "follow",
    });
    // 401/403 from a web app is nearly always one setting, so the error says
    // which one. "The script returned 403" is true and useless -- it sends
    // someone back to a deploy screen with nothing to look for.
    if (res.status === 401 || res.status === 403) {
      return {
        ok: false,
        error:
          `Google refused the call (${res.status}). Check the deployment's "Who has access" ` +
          `is "Anyone" — "Only myself" and "Anyone with a Google account" both require a ` +
          `signed-in browser. If it already says Anyone, make a NEW deployment (Deploy > New ` +
          `deployment) and paste its fresh URL: access edited on an existing deployment ` +
          `sometimes never takes effect. A working one shows "Enio bridge is running" when ` +
          `its URL is opened in a private browser window.`,
      };
    }
    if (!res.ok) return { ok: false, error: `The script returned ${res.status}.` };
    const text = await res.text();
    let body: { ok?: unknown; error?: string };
    try {
      body = JSON.parse(text) as { ok?: unknown; error?: string };
    } catch {
      // An HTML body here is nearly always Google's sign-in page, which
      // means the deployment is not set to "Anyone".
      return {
        ok: false,
        error: /<html/i.test(text)
          ? "The script asked for a sign-in, so its deployment is not set to Anyone."
          : "The script returned something that was not JSON.",
      };
    }
    if (body.error) return { ok: false, error: body.error };
    return { ok: true, result: body.ok };
  } catch (err) {
    return { ok: false, error: `Could not reach the script: ${(err as Error).message}` };
  }
}

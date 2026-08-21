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
 *  rather than failing on an unknown op with a confusing error. Tracks the
 *  operation surface only -- cosmetic fixes to the source (the ping email
 *  lookup, say) do not bump it, because forcing a redeploy has a real cost
 *  and an old deployment still serves every operation correctly. */
export const SCRIPT_VERSION = 5;

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
  // v3: documents and todos. Keep is absent because Google's Keep API is
  // enterprise-only -- a consumer account cannot reach it by any route, so
  // offering it would be a dead-end op. Enio's own Notes covers that need
  // locally.
  "docs.create",
  "docs.append",
  "slides.create",
  "sheets.append",
  "tasks.list",
  "tasks.add",
  // v4: forms with their responses, contacts, translation, and Meet links.
  // Deliberately absent, each for a hard reason: Google Vids and Keep have
  // no API a consumer can reach; the Photos API stopped serving anything an
  // app did not itself upload (2025); Chat needs its own Cloud-project app
  // config, the exact dependency this path exists to avoid; and UrlFetch is
  // never exposed -- it would turn the deployment into an open proxy
  // authenticated as the user.
  "forms.create",
  "forms.responses",
  "contacts.find",
  "translate",
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

// Tasks is an "advanced service" rather than a built-in, so a deployment
// that never enabled it would throw a bare "Tasks is not defined" from deep
// inside an op. Checked up front instead, with the fix in the error.
function needTasks() {
  if (typeof Tasks === "undefined") {
    throw new Error(
      'The Tasks service is not enabled for this script. In the Apps Script editor, ' +
      'click the + next to "Services", choose Tasks, press Add, then deploy a new version.'
    );
  }
}

function needPeople() {
  if (typeof People === "undefined") {
    throw new Error(
      'The People API service is not enabled for this script. In the Apps Script editor, ' +
      'click the + next to "Services", choose "Peopleapi", press Add, then deploy a new version.'
    );
  }
}

function needCalendarAPI() {
  if (typeof Calendar === "undefined") {
    throw new Error(
      'Meet links need the Calendar API service. In the Apps Script editor, click the + ' +
      'next to "Services", choose "Calendar API", press Add, then deploy a new version.'
    );
  }
}

var OPS = {
  "ping": function () {
    // Effective user, not active: on an anonymous call getActiveUser() is
    // empty (the caller is nobody), while the effective user is the account
    // the deployment executes as -- the owner, which is the label wanted.
    // Learned from the first live connect, which saved "unknown".
    var email = Session.getEffectiveUser().getEmail() || Session.getActiveUser().getEmail() || "";
    return { version: VERSION, email: email };
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
    // meet: true attaches a Google Meet link, which the built-in service
    // cannot do -- it needs the advanced Calendar API, so only that variant
    // asks for it.
    if (a.meet) {
      needCalendarAPI();
      var created = Calendar.Events.insert(
        {
          summary: String(a.title),
          description: a.description || "",
          location: a.location || "",
          start: { dateTime: new Date(a.start).toISOString() },
          end: { dateTime: new Date(a.end).toISOString() },
          conferenceData: { createRequest: { requestId: Utilities.getUuid() } },
        },
        "primary",
        { conferenceDataVersion: 1 }
      );
      var entry = ((created.conferenceData || {}).entryPoints || [])[0] || {};
      return { id: created.id, title: created.summary, meet: entry.uri || null };
    }
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

  "docs.create": function (a) {
    if (!a.title) throw new Error("title is required");
    var doc = DocumentApp.create(String(a.title));
    if (a.text) doc.getBody().appendParagraph(String(a.text));
    var url = doc.getUrl();
    doc.saveAndClose();
    return { id: doc.getId(), url: url };
  },

  "docs.append": function (a) {
    if (!a.id || !a.text) throw new Error("id and text are required");
    var doc = DocumentApp.openById(a.id);
    var url = doc.getUrl();
    doc.getBody().appendParagraph(String(a.text));
    doc.saveAndClose();
    return { id: a.id, url: url };
  },

  "slides.create": function (a) {
    if (!a.title) throw new Error("title is required");
    var pres = SlidesApp.create(String(a.title));
    var wanted = a.slides || [];
    for (var i = 0; i < Math.min(wanted.length, 30); i++) {
      var slide = pres.appendSlide(SlidesApp.PredefinedLayout.TITLE_AND_BODY);
      var title = slide.getPlaceholder(SlidesApp.PlaceholderType.TITLE);
      if (title) title.asShape().getText().setText(String(wanted[i].title || ""));
      var body = slide.getPlaceholder(SlidesApp.PlaceholderType.BODY);
      if (body) body.asShape().getText().setText(String(wanted[i].body || ""));
    }
    return { id: pres.getId(), url: pres.getUrl(), slides: wanted.length };
  },

  "sheets.append": function (a) {
    // Append-only on purpose: a row added is visible and reversible by hand,
    // where a cell overwrite silently destroys what was there.
    if (!a.id || !a.row) throw new Error("id and row are required");
    var sheet = SpreadsheetApp.openById(a.id).getSheets()[0];
    sheet.appendRow((a.row || []).map(String).slice(0, 26));
    return { id: a.id, appended: true };
  },

  "tasks.list": function () {
    needTasks();
    var lists = Tasks.Tasklists.list().items || [];
    var out = [];
    for (var i = 0; i < lists.length && i < 5; i++) {
      var items = (Tasks.Tasks.list(lists[i].id, { showCompleted: false, maxResults: 20 }).items) || [];
      out.push({
        list: lists[i].title,
        listId: lists[i].id,
        tasks: items.map(function (t) {
          return { id: t.id, title: t.title, due: t.due || null, notes: (t.notes || "").slice(0, 200) };
        }),
      });
    }
    return out;
  },

  "tasks.add": function (a) {
    needTasks();
    if (!a.title) throw new Error("title is required");
    var listId = a.listId || ((Tasks.Tasklists.list().items || [])[0] || {}).id;
    if (!listId) throw new Error("no task list found");
    var task = Tasks.Tasks.insert({ title: String(a.title), notes: a.notes || "", due: a.due || undefined }, listId);
    return { id: task.id, title: task.title, list: listId };
  },

  "forms.create": function (a) {
    if (!a.title || !a.questions) throw new Error("title and questions are required");
    var form = FormApp.create(String(a.title));
    if (a.description) form.setDescription(String(a.description));
    var qs = (a.questions || []).slice(0, 30);
    for (var i = 0; i < qs.length; i++) {
      var q = qs[i] || {};
      var type = String(q.type || "text");
      var title = String(q.title || "");
      if (type === "text") form.addTextItem().setTitle(title);
      else if (type === "paragraph") form.addParagraphTextItem().setTitle(title);
      else if (type === "choice")
        form.addMultipleChoiceItem().setTitle(title).setChoiceValues((q.options || []).map(String));
      else if (type === "checkbox")
        form.addCheckboxItem().setTitle(title).setChoiceValues((q.options || []).map(String));
      else if (type === "scale")
        form.addScaleItem().setTitle(title).setBounds(1, Math.min(Number(q.max) || 5, 10));
      else throw new Error("unknown question type: " + type + " (text, paragraph, choice, checkbox, scale)");
    }
    return { id: form.getId(), url: form.getPublishedUrl(), editUrl: form.getEditUrl(), questions: qs.length };
  },

  "forms.responses": function (a) {
    if (!a.id) throw new Error("id is required");
    var form = FormApp.openById(a.id);
    var all = form.getResponses();
    return {
      title: form.getTitle(),
      count: all.length,
      responses: all.slice(-50).map(function (r) {
        return {
          at: r.getTimestamp().toISOString(),
          answers: r.getItemResponses().map(function (ir) {
            return { question: ir.getItem().getTitle(), answer: String(ir.getResponse()).slice(0, 300) };
          }),
        };
      }),
    };
  },

  "contacts.find": function (a) {
    needPeople();
    if (!a.query) throw new Error("query is required");
    var result = People.People.searchContacts({
      query: String(a.query),
      readMask: "names,emailAddresses,phoneNumbers",
      pageSize: 10,
    });
    return (result.results || []).map(function (m) {
      var person = m.person || {};
      return {
        name: (((person.names || [])[0]) || {}).displayName || "",
        emails: (person.emailAddresses || []).map(function (e) { return e.value; }),
        phones: (person.phoneNumbers || []).map(function (n) { return n.value; }),
      };
    });
  },

  "translate": function (a) {
    if (!a.text || !a.to) throw new Error("text and to are required");
    // Free, built-in, and worth its slot twice over: the local model is
    // weakest exactly where a translator is strongest.
    return { text: LanguageApp.translate(String(a.text).slice(0, 5000), String(a.from || ""), String(a.to)) };
  },

  "drive.read": function (a) {
    var f = DriveApp.getFileById(a.id);
    var type = f.getMimeType();
    // Google's own formats have no plain bytes; each is exported as text
    // instead of returning something unreadable. v5 added Slides and Sheets,
    // because "verify this deck" is the same request as "verify this doc".
    if (type === "application/vnd.google-apps.document") {
      return { name: f.getName(), text: DocumentApp.openById(a.id).getBody().getText().slice(0, 20000) };
    }
    if (type === "application/vnd.google-apps.presentation") {
      var slides = SlidesApp.openById(a.id).getSlides();
      var parts = [];
      for (var i = 0; i < Math.min(slides.length, 50); i++) {
        var texts = [];
        var shapes = slides[i].getShapes();
        for (var j = 0; j < shapes.length; j++) {
          try {
            var t = shapes[j].getText().asString().trim();
            if (t) texts.push(t);
          } catch (ignored) {}
        }
        parts.push("— slide " + (i + 1) + " —\n" + texts.join("\n"));
      }
      return { name: f.getName(), text: parts.join("\n\n").slice(0, 20000) };
    }
    if (type === "application/vnd.google-apps.spreadsheet") {
      var rows = SpreadsheetApp.openById(a.id).getSheets()[0].getDataRange().getValues().slice(0, 100);
      var lines = rows.map(function (r) { return r.join("\t"); });
      return { name: f.getName(), text: lines.join("\n").slice(0, 20000) };
    }
    if (type.indexOf("text/") === 0 || type === "application/json") {
      return { name: f.getName(), text: f.getBlob().getDataAsString().slice(0, 20000) };
    }
    return { name: f.getName(), type: type, note: "Not a readable document; nothing was read." };
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

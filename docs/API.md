# WA Box API

Schedule WhatsApp group messages from a Google Sheet, Zapier, a CRM or your own script.

The API is not a side door. Every message goes through the **same code path as the app**:
the same daily and hourly limits, the same random gaps between groups, the same duplicate
guard, the same image-link checks, and the same 30-second undo window. API messages show up
in the app's *Scheduled* list like any other, labelled with the key's name, so your team
always sees what is about to go out.

<img src="media/api.gif" alt="A new Google Sheet row becomes a scheduled message in WA Box through the API" width="720">

- Base address: `https://<your-wa-box>/api/v1` (for example `https://wabox.example.com/api/v1`)
- Machine-readable spec: `https://<your-wa-box>/openapi.yaml` (OpenAPI 3.1, imports into Postman, Insomnia, Bruno)
- Times: India time (Asia/Kolkata) unless you give a timezone

---

## Contents

1. [Quick start (2 minutes)](#quick-start-2-minutes)
2. [Keys and what they can do](#keys-and-what-they-can-do)
3. [Endpoints](#endpoints)
4. [Scheduling a message: every field](#scheduling-a-message-every-field)
5. [Never schedule twice: Idempotency-Key](#never-schedule-twice-idempotency-key)
6. [Errors](#errors)
7. [Webhooks](#webhooks)
8. [Examples: curl, JavaScript, Python, Google Sheets](#examples)
9. [Limits and safety rules](#limits-and-safety-rules)
10. [FAQ](#faq)

---

## Quick start (2 minutes)

**1. Make a key.** Sign in as an admin, open **API & webhooks**, press **New API key**, give it a
name ("Google Sheet") and pick **Schedule**. Copy the key; it is shown once.

**2. Check it works.**

```bash
curl -H "Authorization: Bearer wbx_YOUR_KEY" https://<your-wa-box>/api/v1/status
```

```json
{
  "whatsapp": "connected",
  "sending": "on",
  "practiceMode": false,
  "limits": { "perDay": 30, "perHour": 20, "sentToday": 4, "minGapSeconds": 30 },
  "key": { "name": "Google Sheet", "scope": "schedule", "limitedToLists": null },
  "timezone": "Asia/Kolkata"
}
```

**3. See your groups and lists.**

```bash
curl -H "Authorization: Bearer wbx_YOUR_KEY" https://<your-wa-box>/api/v1/lists
```

**4. Schedule a message.**

```bash
curl -X POST https://<your-wa-box>/api/v1/messages \
  -H "Authorization: Bearer wbx_YOUR_KEY" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: 2026-11-01-reminder" \
  -d '{
        "text": "Hi {group} 👋\n*Class at 11 AM today.* See you there!",
        "list": "Weekend cohorts",
        "sendAt": { "date": "2026-11-01", "time": "09:30" }
      }'
```

You get `201 Created` with the full message, including each group and its status. It appears
in the app straight away and can be undone there for 30 seconds.

> **Tip:** turn on **Practice mode** in *Safety & settings* while you wire things up. Everything
> runs, nothing is sent to WhatsApp.

---

## Keys and what they can do

Send the key in either header:

```
Authorization: Bearer wbx_7hQk...        (recommended)
X-API-Key: wbx_7hQk...
```

| Scope | Can |
| --- | --- |
| `read` | Status, groups, lists, messages. Cannot schedule. |
| `schedule` | Everything in `read`, plus schedule messages and cancel **the messages this key scheduled**. |
| `full` | Everything in `schedule`, plus cancel **any** message. |

**Limit a key to group lists.** When making a key you can tick one or more saved lists. The key
then only sees those groups, can only send to them, and only sees messages whose groups are all
inside them. Good for giving a partner or a single automation a narrow key.

**Safety of keys.** WA Box stores only a SHA-256 fingerprint of each key, never the key itself.
Revoking a key stops it immediately; messages it already scheduled still go out (cancel them
in the app if needed). The *Last used* column shows when each key was last seen.

---

## Endpoints

| Method | Path | Scope | What it does |
| --- | --- | --- | --- |
| `GET` | `/status` | read | WhatsApp connection, sending on/paused, practice mode, limits, this key |
| `GET` | `/groups` | read | Saved groups this key may use: `[{ id, name }]` |
| `GET` | `/lists` | read | Saved group lists with their groups |
| `GET` | `/messages?status=upcoming\|history&limit=50` | read | Upcoming (default) or past messages |
| `GET` | `/messages/{id}` | read | One message with each group's status and ticks |
| `POST` | `/messages` | schedule | Schedule a message |
| `DELETE` | `/messages/{id}` | schedule / full | Cancel a message that hasn't finished |

### The message object

```json
{
  "id": 42,
  "title": "Saturday reminder",
  "text": "Hi {group} 👋 Class at 11 AM today!",
  "status": "scheduled",
  "note": null,
  "sendAt": "2026-11-01T04:00:00.000Z",
  "startsAt": "2026-11-01T04:01:12.000Z",
  "date": "2026-11-01", "time": "09:30", "dow": 0,
  "timezone": "Asia/Kolkata",
  "repeat": [],
  "pacing": { "minSeconds": 40, "maxSeconds": 120 },
  "imageUrl": null,
  "hasUploadedImage": false,
  "linkPreview": true,
  "createdBy": "api:Google Sheet",
  "createdAt": "2026-10-28T11:02:45.120Z",
  "groups": [
    { "id": "1203...@g.us", "name": "Weekend Cohort 3", "status": "sent", "sentAt": "2026-11-01T04:01:15.000Z", "delivery": "delivered", "error": null },
    { "id": "1203...@g.us", "name": "Weekend Cohort 4", "status": "pending", "sentAt": null, "delivery": null, "error": null }
  ]
}
```

- `status`: `scheduled` → `running` → `done` or `done_with_errors`; or `cancelled`. A weekly
  message goes back to `scheduled` with the next date after each run.
- `startsAt` is `sendAt` plus a small random offset (so messages never go out on the exact minute).
- `note` explains any wait in plain words, for example *"Daily limit of 30 reached. The rest go out tomorrow around 09:12."*
- `groups[].status`:

| Status | Meaning |
| --- | --- |
| `pending` | Not tried yet |
| `sending`, `retry`, `uncertain` | In progress, retrying once, or checking the chat to see if it arrived |
| `sent` | WhatsApp accepted it. `delivery` then moves through `sent` → `delivered` → `read` |
| `dry_run` | Practice mode: recorded, not sent |
| `failed` | WhatsApp refused it (for example the number was removed from the group) |
| `unconfirmed` | No clear answer and it isn't in the chat. **Never resent automatically**: someone decides in the app |
| `missed` | Too late to send (WA Box was off for longer than the late window) |
| `skipped` | The group is no longer in the saved list |
| `blocked_duplicate` | The same text already went to this group recently |

---

## Scheduling a message: every field

`POST /messages`

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `text` | string | yes | Up to 4000 characters. WhatsApp formatting works: `*bold*`, `_italic_`, `~strike~`, ```` ```mono``` ````. |
| `groups` | string[] | one of `groups`/`list`/`lists` | Group ids (`...@g.us`) **or exact group names** (case doesn't matter). |
| `list` | string | | A saved list's name or id. |
| `lists` | string[] | | Several lists. Groups are merged and de-duplicated. |
| `sendAt` | see below | yes | When to start. |
| `repeat` | string[] | no | `["sat", "sun"]`: repeat every week on those days at the same time. Full names work too. |
| `pacing` | string or object | no | `"standard"` (40–120 s between groups, default), `"gentle"` (60–180 s), or `{ "minSeconds": 90, "maxSeconds": 240 }`. Never below the safety minimum. |
| `imageUrl` | string | no | Public `https` link to a JPG, PNG or WebP under 5 MB. Google Drive share links are converted automatically. Checked now, sent by link, nothing stored. |
| `linkPreview` | boolean | no | Default `true`. Set `false` to send links without the preview card. |
| `title` | string | no | Up to 80 characters, shown in the app instead of the first line. |

**`sendAt` takes three shapes:**

```jsonc
"sendAt": "now"                                        // starts after the 30-second undo window
"sendAt": "2026-11-01T10:00:00+05:30"                  // ISO 8601, timezone REQUIRED
"sendAt": { "date": "2026-11-01", "time": "10:00" }    // India time, 24-hour
```

A time without a timezone (`"2026-11-01T10:00:00"`) is refused on purpose. It's the most common
way a message goes out 5½ hours early.

**Placeholders** are filled in per group at send time:

| Placeholder | Becomes |
| --- | --- |
| `{group}` | The group's name, e.g. *Weekend Cohort 3* |
| `{day}` | The weekday it sends, e.g. *Saturday* |
| `{date}` | The date it sends, e.g. *31 Oct* |

Use `{day}` and `{date}` in weekly messages so "Saturday" never goes out on a Sunday.

---

## Never schedule twice: Idempotency-Key

Networks drop replies. If your script times out and retries, it could schedule the same message
twice. Add an `Idempotency-Key` header (any string up to 100 characters) to `POST /messages`:

```
Idempotency-Key: sheet-row-17
```

- Same key **and** same body within 24 hours → you get the first response back (with
  `Idempotent-Replayed: true`). Nothing new is scheduled.
- Same key, **different** body → `409 idempotency_conflict`. Nothing is scheduled.

Good keys come from your side: a sheet row number, a CRM record id, `date + purpose`.

On top of this, WA Box's duplicate guard blocks the same text going to the same group twice
within 20 hours (configurable), even across different messages.

---

## Errors

Every error has the same shape, with a sentence you can show a person as-is:

```json
{ "error": { "code": "unknown_group", "message": "Not found in the saved groups: Weekend Cohort 9. GET /api/v1/groups lists them." } }
```

| HTTP | `code` | When | Was anything scheduled? |
| --- | --- | --- | --- |
| 400 | `invalid_request` | Empty text, past time, missing timezone, bad image link, malformed JSON… | No |
| 400 | `unknown_group` | A group or list name isn't saved (or this key may not use it) | No |
| 401 | `unauthorized` | Missing, wrong or revoked key | No |
| 403 | `forbidden` | The key's scope doesn't allow it | No |
| 404 | `not_found` | No such message or endpoint | — |
| 409 | `idempotency_conflict` | Same Idempotency-Key, different body | No |
| 409 | `not_active` | Cancelling a message that already finished or was cancelled | — |
| 429 | `rate_limited` | Over 60 requests a minute for this key | No |
| 500 | `server_error` | Something broke on our side | No |

**Any 4xx means nothing was scheduled**, so it is safe to fix the request and send it again.

---

## Webhooks

Add an address under **API & webhooks → Add a webhook**. WA Box POSTs JSON to it when:

| Event | When |
| --- | --- |
| `message.started` | The first group of a message is about to be sent |
| `group.failed` | A group did not get it: `failed`, `unconfirmed`, `missed`, `skipped` or `blocked_duplicate` |
| `message.finished` | Every group has been tried. For weekly messages, once per week. Includes every group's result. |
| `ping` | You pressed *Send a test* |

### Payload

```http
POST /your/endpoint
Content-Type: application/json
X-WABox-Event: message.finished
X-WABox-Delivery: evt_118
X-WABox-Signature: t=1761980000,v1=5f2c...e9
```

```json
{
  "id": "evt_118",
  "event": "message.finished",
  "createdAt": "2026-11-01T04:12:40.511Z",
  "data": {
    "message": { "id": 42, "title": "Saturday reminder", "preview": "Hi Weekend Cohort 3 👋", "runAt": "2026-11-01T04:00:00.000Z", "repeat": [], "createdBy": "api:Google Sheet" },
    "status": "done_with_errors",
    "groups": [
      { "id": "1203...@g.us", "name": "Weekend Cohort 3", "status": "sent", "sentAt": "2026-11-01T04:01:15.000Z", "error": null },
      { "id": "1203...@g.us", "name": "Weekend Cohort 4", "status": "failed", "sentAt": null, "error": "This number is not in the group (or was removed)" }
    ]
  }
}
```

### Check the signature

The header is `t=<unix seconds>,v1=<hex>`, where `v1 = HMAC-SHA256(secret, "<t>.<raw body>")`.
The secret (`whsec_...`) is shown once when you add the webhook. Compare in constant time and
reject anything older than 5 minutes.

**Node.js**

```js
import crypto from 'node:crypto';

function verify(rawBody, header, secret) {
  const { t, v1 } = Object.fromEntries(header.split(',').map(p => p.split('=')));
  if (Math.abs(Date.now() / 1000 - Number(t)) > 300) return false;
  const want = crypto.createHmac('sha256', secret).update(`${t}.${rawBody}`).digest('hex');
  return crypto.timingSafeEqual(Buffer.from(want), Buffer.from(v1));
}
```

**Python**

```python
import hmac, hashlib, time

def verify(raw_body: bytes, header: str, secret: str) -> bool:
    parts = dict(p.split("=", 1) for p in header.split(","))
    if abs(time.time() - int(parts["t"])) > 300:
        return False
    want = hmac.new(secret.encode(), f'{parts["t"]}.'.encode() + raw_body, hashlib.sha256).hexdigest()
    return hmac.compare_digest(want, parts["v1"])
```

Use the **raw** request body, not a re-serialised JSON object.

### Retries

Answer with any `2xx` within 10 seconds. Anything else is retried after **1 min, 5 min, 30 min,
2 h and 6 h** (about 9 hours in all). After that the delivery is marked *Gave up*, shown under
*Recent deliveries*, and raised as a WA Box alert, so a broken receiver never goes unnoticed.
The `id` stays the same across retries: store it and ignore repeats.

Webhook addresses must be `https://`.

---

## Examples

### curl

```bash
KEY=wbx_YOUR_KEY
BASE=https://<your-wa-box>/api/v1

# Weekly: every Saturday and Sunday at 09:00, gentle pacing
curl -X POST $BASE/messages -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"text":"{day} class at 11 AM. See you, {group}!","list":"Weekend cohorts","sendAt":{"date":"2026-10-31","time":"09:00"},"repeat":["sat","sun"],"pacing":"gentle"}'

# With an image from Google Drive (file shared as "Anyone with the link")
curl -X POST $BASE/messages -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"text":"*New batch* starts Monday 🚀","groups":["Weekend Cohort 3"],"sendAt":"now","imageUrl":"https://drive.google.com/file/d/FILE_ID/view"}'

# What's coming up
curl -H "Authorization: Bearer $KEY" "$BASE/messages?status=upcoming"

# Cancel
curl -X DELETE -H "Authorization: Bearer $KEY" $BASE/messages/42
```

### JavaScript (Node 18+ or the browser of your own backend)

```js
const BASE = 'https://<your-wa-box>/api/v1';
const KEY = process.env.WABOX_KEY;

async function schedule(body, idempotencyKey) {
  const res = await fetch(`${BASE}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`${data.error.code}: ${data.error.message}`);
  return data.message;
}

const m = await schedule({
  text: 'Hi {group} 👋 Class at 11 AM today!',
  list: 'Weekend cohorts',
  sendAt: { date: '2026-11-01', time: '09:30' },
}, 'reminder-2026-11-01');
console.log(`Scheduled #${m.id} to ${m.groups.length} groups, starts ${m.startsAt}`);
```

Never put a key in code that runs in someone else's browser.

### Python

```python
import os, requests

BASE = "https://<your-wa-box>/api/v1"
H = {"Authorization": f"Bearer {os.environ['WABOX_KEY']}"}

r = requests.post(f"{BASE}/messages", headers={**H, "Idempotency-Key": "reminder-2026-11-01"}, json={
    "text": "Hi {group} 👋 Class at 11 AM today!",
    "list": "Weekend cohorts",
    "sendAt": "2026-11-01T09:30:00+05:30",
}, timeout=30)
if not r.ok:
    raise SystemExit(r.json()["error"]["message"])
print("Scheduled", r.json()["message"]["id"])
```

### Google Sheets (Apps Script)

A sheet with columns **A: Date (YYYY-MM-DD) · B: Time (HH:MM) · C: List · D: Message · E: Status**.
*Extensions → Apps Script*, paste, set the key under *Project settings → Script properties*
(`WABOX_KEY`), then run `scheduleRows`. Re-running is safe: each row uses its own Idempotency-Key.

```js
const BASE = 'https://<your-wa-box>/api/v1';

function scheduleRows() {
  const key = PropertiesService.getScriptProperties().getProperty('WABOX_KEY');
  const sheet = SpreadsheetApp.getActiveSheet();
  const rows = sheet.getDataRange().getDisplayValues();
  for (let i = 1; i < rows.length; i++) {
    const [date, time, list, text, status] = rows[i];
    if (!text || status.startsWith('Scheduled')) continue;
    const res = UrlFetchApp.fetch(`${BASE}/messages`, {
      method: 'post', contentType: 'application/json', muteHttpExceptions: true,
      headers: { Authorization: `Bearer ${key}`, 'Idempotency-Key': `${sheet.getSheetId()}-row-${i + 1}-${date}-${time}` },
      payload: JSON.stringify({ text, list, sendAt: { date, time } }),
    });
    const body = JSON.parse(res.getContentText());
    sheet.getRange(i + 1, 5).setValue(res.getResponseCode() === 201 ? `Scheduled #${body.message.id}` : `Error: ${body.error.message}`);
  }
}
```

### Zapier / Make / n8n

Use a **Webhooks / HTTP** step: `POST` to `.../api/v1/messages`, header
`Authorization: Bearer wbx_...`, JSON body as above. Map a unique field from the trigger
(row id, record id) into `Idempotency-Key`. To react to sends, add a WA Box webhook pointing
at a *Catch Hook* URL.

---

## Limits and safety rules

These apply to the API exactly as they do in the app, and an API key cannot turn them off.

| Rule | Default | Where to change |
| --- | --- | --- |
| Messages per day | 30 | Safety & settings |
| Messages per hour | 20 | Safety & settings |
| Gap between groups | random, at least the safety minimum | `pacing` per message |
| Duplicate guard | same text to same group within 20 h is blocked | Safety & settings |
| Late window | a message more than 120 min late is marked missed, not sent at an odd hour | `MAX_LATE_MINUTES` |
| Undo window | nothing starts sooner than 30 s after it is scheduled | — |
| Groups per message | 50 | — |
| API requests | 60 a minute per key | `WABOX_API_RATE` |

If the day's limit is reached, the rest of the groups go out the next morning (about 09:00–09:30
India time) and `note` says so. If WhatsApp disconnects, messages wait and alerts go to the
admins; nothing is lost and nothing is sent twice.

---

## FAQ

**Can I send to a group that isn't in WA Box yet?** No. Groups must be synced and match the
group keywords in *WhatsApp & groups*. This keeps an automation from messaging the wrong chat.

**Can I send to a person instead of a group?** No. WA Box is for groups only, on purpose.

**Does the API upload images?** No. Give a public `imageUrl`. WA Box checks it when you
schedule (so a broken link fails now, not on Saturday morning) and sends it by link.

**How do I test without sending?** Turn on *Practice mode*. Everything runs and is recorded as
`dry_run`; nothing reaches WhatsApp. `GET /status` shows `"practiceMode": true`.

**What happens if WA Box restarts mid-send?** It checks the chat history before doing anything,
marks what already went out as sent, and never resends blindly. Anything it can't confirm
becomes `unconfirmed` for a person to decide.

---

Designed by [Bhavishya](https://www.linkedin.com/in/bhavishyabharadwaj/).

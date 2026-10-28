# WA Box runbook

What to do when something goes wrong. Everything below is done at **wabox.example.com/wabox** unless it says Coolify.

## Where to look first

<img src="docs/media/alerts.gif" alt="Alerts in the team channel: morning check-in, done note, and a warning when WhatsApp needs attention" width="640">

**System & logs** (admins) shows, in this order:
1. **Health**: scheduler, WhatsApp, sending mode, last 24 h.
2. **Needs your decision**: sends where WA Box couldn't confirm the result.
3. **Open issues**: everything that was alerted and isn't resolved.
4. **Event log**: every send, retry, check, connection change and error, newest first. Filter to *Errors*.

## Alerts and what they mean

| Alert | What happened | What to do |
|---|---|---|
| WhatsApp is not connected / got logged out | The linked device dropped. Nothing is being sent; scheduled messages wait. | WhatsApp & groups → Show QR code → scan from the phone. Late messages beyond the "skip if late" window are marked missed, not sent hours late. |
| Not sure if "Group X" got the message | WhatsApp's reply was lost and the message wasn't found in the chat. WA Box did **not** resend. | Open the group on the phone. If the message is there, press **It was sent**. If not, press **Send again** (admins). |
| 3 sends in a row failed, sending paused | Circuit breaker tripped to protect the number. | Check WhatsApp & groups and the event log. Fix the cause, then Safety & settings → turn off **Pause all sending**. |
| Blocked a duplicate | The same text was about to go to the same group within the duplicate window. | Usually correct. If it really should go again, open the message → **Send again** for that group. |
| Message was not sent: more than N min late | The server or WhatsApp was down at send time. | Re-schedule it if it still matters (open it → Duplicate). |
| A weekly message was stopped | Its next date looked wrong, so it was stopped instead of risking repeats. | Re-create it. |
| A webhook stopped answering | Another system didn't accept WA Box's events for ~9 hours. Sending is not affected. | API & webhooks → Recent deliveries shows the error. Fix the receiver, press **Send a test**. |
| No morning check-in arrived | The app or server may be down. | Open the site. If it doesn't load, see "Site is down". |

## Site is down / nobody is around
- An **outside uptime monitor** is the only thing that can warn you when the whole server is down. Point a free monitor (UptimeRobot, Better Stack) at `https://wabox.example.com/wabox/health/monitor`. It returns 200 when healthy and 503 when the scheduler stalled, sending is paused, or WhatsApp has been disconnected for 10+ minutes.
- In Coolify: WA Box → wabox → Logs (`wabox` and `engine` services). Both containers restart automatically if they crash.
- After any restart, WA Box checks every send that was in flight against the group's chat before doing anything. It never resends blindly.

## WhatsApp Web changed and nothing sends
The engine automatically retries on the last WhatsApp Web version that worked. If sends still fail: in `engine/package.json` bump `whatsapp-web.js` to the latest release (`npm view whatsapp-web.js version`), push, and Coolify rebuilds. To force a specific WhatsApp Web build, set `WA_WEB_VERSION` in Coolify's environment variables and redeploy.

## Updates
Push to `main` → Coolify builds. The build runs the safety tests; **if any test fails, the deploy stops and the current version keeps running.** During a redeploy the old copy finishes the message it is sending, then stops; only one copy can send at a time.

## Backups and archive
- System & logs → Archive: download every send, every message, and the event log as CSV.
- Coolify volumes `wabox-data` (jobs, users, logs) and `engine-data` (WhatsApp login). Back them up with Coolify's volume backups.

## API problems
- **401 unauthorized**: the key is wrong or was revoked. API & webhooks → Keys shows when each key was last used. Make a new key if needed.
- **A script scheduled the same message twice**: it didn't send an `Idempotency-Key`. Cancel the extra in Scheduled (or let the duplicate guard block it), and add the header (see docs/API.md).
- **Someone shouldn't have API access any more**: revoke their key. Messages it already scheduled stay in Scheduled; cancel them there if needed.

## Running a copy on your own computer
See the README's "Get started". `make status` and `make logs` show what's happening. A local copy always starts in practice mode and only runs while the computer is awake.

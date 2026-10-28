# Changelog

## 1.0.0 (28 Oct 2026)

The first complete version.

### Writing
- Live WhatsApp phone preview that steps through each group.
- `{group}`, `{day}` and `{date}` placeholders, filled in per group at send time.
- Date sense-check: flags "today" + the wrong weekday, a time that has already passed, last week's date, and fixed days in weekly messages. One-click fix.
- Formatting toolbar and shortcuts; paste or drop images; images by link (nothing stored, Google Drive links work); link preview on/off.
- Templates, saved group lists, and "Send a test to my WhatsApp".

### Scheduling
- One-off or weekly. Lists remember their usual time and pacing.
- Quiet-hours warning.
- 30-second undo on every new message; "Skip this time" for weekly messages.
- "Send these again?" brings last week's messages back on Today.

### Sending
- Own WhatsApp engine on `whatsapp-web.js`: keeps the login, reconnects, restarts Chrome when it misbehaves, falls back to the last WhatsApp Web version that worked.
- One group at a time with random gaps (30 s minimum), typing indicator, start jitter.
- Daily and hourly limits; overflow continues the next morning.
- Write-ahead send log, chat-history check after any unclear result, never a blind resend.
- Duplicate guard across messages, circuit breaker, late-send cut-off, practice mode.
- Delivery ticks (✓ / ✓✓ / read) per group.

### Knowing what happened
- Today page with live progress; Sent with per-group results and reasons.
- Alerts to Slack, Google Chat, Discord or WhatsApp; morning check-in with a Monday week preview; "done" notes.
- `/health/monitor` for an outside uptime monitor. System page with health, decisions, issues, event log and CSV archive.

### API
- `/api/v1` with scoped keys (read / schedule / full), optional list limits, hashed storage.
- `Idempotency-Key`, per-key rate limit, one error shape.
- Signed webhooks (`message.started`, `message.finished`, `group.failed`) with retries and alerts.
- API & webhooks page, `docs/API.md`, `openapi.yaml`.

### Running it
- Coolify / Docker Compose deploy; safety tests run during every build.
- Run on your own computer: `scripts/setup.sh`, `scripts/setup.ps1`, `docker-compose.local.yml`, Makefile. Local copies always start in practice mode.
- `AGENTS.md` so coding assistants can install, deploy and change it safely.

### Team
- Admin and member roles, own passwords, lockout, activity log.

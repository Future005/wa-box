# Contributing to WA Box

Thanks for helping. WA Box sends real messages to real groups, so the bar is simple: **every change keeps people's numbers safe and never fails quietly.**

## Before you start

- **Bugs:** open an issue with the *Bug report* form. Screenshots and the event log lines (System & logs) help most.
- **Ideas:** open an issue with the *Feature idea* form first, so we can agree it fits before you build it. WA Box stays focused: scheduling messages to groups, done safely. Bots, personal chats and bulk marketing are out of scope.
- **Security problems:** don't open an issue; see [SECURITY.md](SECURITY.md).

## Set up

You need Node 22 (and Docker to run the whole thing).

```bash
git clone <repo-url> wabox && cd wabox
cd app && npm ci && npm test        # app tests
cd ../engine && npm ci && npm test  # engine tests
```

To run it: `sh scripts/setup.sh` (or `scripts\setup.ps1` on Windows). It starts in practice mode, so nothing reaches WhatsApp.

## Making a change

1. Read [AGENTS.md](AGENTS.md): the code map and the rules every change must keep (the send contract, write-ahead records, `createJob()` as the only way to schedule, no inline styles).
2. Add or update a test that acts out the real situation. The style is in `app/test/scheduler.test.js`: describe what goes wrong in real life, then assert nothing was sent twice and nothing failed silently.
3. Run both test suites. They also run on every pull request and in the Docker build.
4. Keep the words in the app plain and short. Say what happened and what to do.
5. If you change behaviour people see, update `docs/USER-GUIDE.md`, `docs/API.md` and `CHANGELOG.md`.

## Pull requests

- One topic per pull request, with a short description of the *why*.
- Screenshots for anything visual.
- New dependencies need a good reason; pin exact versions.

## Never commit

`.env`, anything in `data/`, database files, WhatsApp session folders, real phone numbers, real group names, API keys or webhook secrets.

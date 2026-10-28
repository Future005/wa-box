# Keeping the public repo clean

WA Box is public. Before every push, make sure nothing personal or secret goes in.

## Never commit

- `.env`, anything under `data/`, database files (`*.db`), WhatsApp session folders
- Real admin logins or email addresses, real phone numbers, real group names
- API keys (`wbx_…`), webhook secrets (`whsec_…`), passwords

Your own settings (admin email, organisation name, group keywords, the app's address) live in your
hosting platform's environment variables, never in `docker-compose.yml`.

## Check before pushing

```bash
git status --ignored     # no .env, data/, *.db, session folders staged
git grep -nE "wbx_[A-Za-z0-9]{32}|whsec_[0-9a-f]{48}|SERVICE_PASSWORD_[A-Z0-9_]+=[^$]"
git grep -nE "\+?91[0-9]{10}|@gmail\.com|@[a-z0-9-]+\.(co|in)\b" -- ':!LICENSE'   # review every hit
```

Screenshots and animations must use sample data only ("Weekend Cohort 1", `admin@example.com`).
To retake them, run a local copy with sample groups (see `media/README.md`).

## Releasing a version

1. Update `CHANGELOG.md` and the version shown in `docs/badges/version.svg`.
2. Tests pass: `cd app && npm test` and `cd engine && npm test` (CI runs them on every push).
3. Tag it: `git tag v1.x.y && git push --tags`, then create a GitHub release with the changelog entry.

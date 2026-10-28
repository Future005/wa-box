# Making WA Box public

This repo is private and its history contains real setup details from the proof of concept.
**Don't make this repo public.** Publish a fresh copy instead, so no old commit can leak anything.

Tick every box, in order.

## 1. Prepare a clean copy

- [ ] Make a new, empty **private** repository (e.g. `wabox`). Keep it private until step 5.
- [ ] Copy the current files without history:
  ```bash
  git clone <this-private-repo> wabox-public-src
  cd wabox-public-src && rm -rf .git && git init -b main
  ```

## 2. Remove personal and organisation details

- [ ] `docker-compose.yml`: set `ADMIN_USER=admin@example.com`, `ORG_NAME=` (empty), `GROUP_KEYWORDS=` (empty). Remove the domain from the header comment.
- [ ] `RUNBOOK.md`: replace `wabox.example.com/wabox` with `<your WA Box address>`.
- [ ] `docs/API.md`: replace the `wabox.example.com` example address with `<your-wa-box>`.
- [ ] Search and review every hit (keep the "Designed by Bhavishya" credit and LinkedIn link):
  ```bash
  grep -rniE "gateway|acme|example\.com|info@|@acme|919[0-9]{9}|coolify\.example" --exclude-dir=node_modules .
  ```
- [ ] Screenshots in `docs/screenshots/` use sample group names ("Weekend Cohort 1"…) and a fake number. Retake them with neutral names if you prefer: run a local copy with `ORG_NAME=` and sample groups.
- [ ] Make sure nothing secret or personal is present:
  ```bash
  git status --ignored            # no .env, data/, *.db, session folders
  grep -rnE "wbx_[A-Za-z0-9]{32}|whsec_[0-9a-f]{48}|SERVICE_PASSWORD_[A-Z0-9_]+=.+" --exclude-dir=node_modules .
  ```

## 3. Add what a public project needs

- [ ] `LICENSE` is MIT. Keep it, or swap for AGPL-3.0 if you want hosted copies to share their changes (update the README badge and footer).
- [ ] In the new repo's settings, turn on **Private vulnerability reporting** (Security tab), which SECURITY.md points to.
- [ ] Tests run on GitHub Actions for free once the repo is public. After the first green run, add the CI badge at the start of the README badge row:
  `<a href="https://github.com/<owner>/<repo>/actions/workflows/ci.yml"><img src="https://github.com/<owner>/<repo>/actions/workflows/ci.yml/badge.svg" alt="CI"></a>`
- [ ] Replace `Future005/wa-box` in `.github/ISSUE_TEMPLATE/config.yml` and CONTRIBUTING.md with the public repo's path.
- [ ] Replace `<your-repo-link>` in `README.md` (3 places in "Get started" and "Install with your AI assistant") with the public repo's URL.
- [ ] README: keep the "Is this allowed by WhatsApp?" FAQ and the not-affiliated sentence.

## 4. Clean-install test (on a machine that has never run WA Box)

- [ ] `git clone <public-repo-url> && cd wabox && sh scripts/setup.sh` (and `scripts\setup.ps1` on Windows if you can).
- [ ] The build passes (all tests run inside it).
- [ ] It prints the address, username and one-time password; sign-in works and asks for a new password.
- [ ] The page says **Local copy** and practice mode is on.
- [ ] Link a spare WhatsApp number, sync groups, schedule a message in practice mode, see it in Sent as *Practice*.
- [ ] `docker compose -f docker-compose.local.yml down` then `up -d`: messages and users are still there, WhatsApp is still linked, practice mode is on again.
- [ ] `cd app && npm ci && npm test` and `cd engine && npm ci && npm test` pass on Node 22.
- [ ] Paste the "Run it on my computer" prompt from the README into an AI coding assistant in an empty folder and check it gets to a running copy without help.

## 5. Publish

- [ ] First commit as yourself, e.g. `git commit -m "WA Box 1.0.0"`. No other attribution.
- [ ] Push, then switch the repository to **public**.
- [ ] Add a description ("Schedule WhatsApp group messages safely, as a team") and topics (`whatsapp`, `scheduler`, `whatsapp-web-js`, `self-hosted`).
- [ ] Create release `v1.0.0` with the CHANGELOG entry.

## 6. After publishing

- [ ] Your own deployment keeps using this private repo (or switch Coolify to the public one; your secrets stay in Coolify).
- [ ] When this proof-of-concept data is no longer needed: in Coolify, back up then delete the `wabox-data` volume to clear test messages and users, and unlink the device from the phone if you're moving numbers.

# Security

WA Box sends messages from a real WhatsApp number, so security reports matter a lot. Thank you for taking the time.

## Reporting a problem

**Please don't open a public issue for a security problem.**

Use GitHub's private reporting instead: **Security → Report a vulnerability** on this repository.
Include what you found, how to reproduce it, and what someone could do with it.

You'll get a reply within 5 working days. Once it's fixed, you'll be credited in the changelog unless you'd rather not be.

## What's in scope

- Signing in, sessions, roles (a member doing admin things)
- The public API: keys, scopes, list limits, idempotency
- Webhooks: signatures, where they can be sent
- Anything that could send a message twice, to the wrong group, or without the safety checks
- Reaching the WhatsApp engine from outside, or reading another person's data

## Supported versions

Only the latest version on `main` gets security fixes.

## How WA Box protects itself

A short list, so you know what's intended:

- Passwords hashed with bcrypt; lockout after 5 wrong tries; sessions expire after 12 hours idle.
- `HttpOnly; Secure; SameSite=Strict` cookie, a custom header against cross-site requests, strict Content Security Policy, no framing.
- API keys stored only as SHA-256 hashes, shown once. Webhooks signed with HMAC-SHA256.
- The WhatsApp engine has no public port and needs a key on every call. Image links to private network addresses are refused.
- Both containers drop all Linux capabilities and run as non-root; the app's filesystem is read-only.
- Secrets live in the environment, never in git.

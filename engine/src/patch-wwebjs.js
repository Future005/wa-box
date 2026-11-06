// A one-line fix to whatsapp-web.js 1.34.7 for a WhatsApp Web change (Nov 2026).
//
// Sending an image failed with "Data passed to getter must include an id property (it's how we
// memoize) but got undefined": the media object WhatsApp Web returns now carries an internal
// `__x_id`, which the library spreads into the outgoing message and which overwrites the message's
// real id. Removing it right after the message is built makes image sends work again.
// Community fix: wwebjs/whatsapp-web.js PR #201938 (issue #201921). Not released yet, so we apply it
// here, at build time (Dockerfile) and again when the engine loads (in case of a fresh npm install).
const fs = require('node:fs');
const path = require('node:path');

const MARK = '/* wabox: drop media __x_id */';
const ANCHOR = "        // Bot's won't reply if canonicalUrl is set (linking)";

function file() { return path.join(path.dirname(require.resolve('whatsapp-web.js/package.json')), 'src/util/Injected/Utils.js'); }

/** Returns 'patched', 'already' or throws (strict) / returns 'skipped: <why>' when it can't. */
function apply({ strict = false } = {}) {
  const f = file();
  const src = fs.readFileSync(f, 'utf8');
  if (src.includes(MARK)) return 'already';
  const fail = why => { if (strict) throw new Error(`whatsapp-web.js patch: ${why}`); return `skipped: ${why}`; };
  if (!src.includes(ANCHOR)) return fail('anchor not found (library changed? check if the fix is now upstream)');
  try {
    fs.writeFileSync(f, src.replace(ANCHOR, `        delete message.__x_id; ${MARK}\n\n${ANCHOR}`));
  } catch (e) { return fail(`can't write ${f}: ${e.message}`); }
  return 'patched';
}

module.exports = { apply, MARK, file };
if (require.main === module) console.log(apply({ strict: true }));

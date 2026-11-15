// Generates docs/STATE-MACHINES.md from public/machines.js. Run: npm run states:doc
// A test fails if the committed doc is out of date, so the diagrams always match the code.
const fs = require('node:fs');
const path = require('node:path');
const M = require('../public/machines');

const HOW = {
  database: 'Checked by the database on every change (a test fails on anything not listed; production logs it under System → Events).',
  engine: 'Checked by the WhatsApp engine on every change (`engine/src/states.js`, kept equal to this one by a test). Unexpected changes are logged.',
  code: 'Held in memory or worked out from other data; the code that changes it uses these names.',
};

function diagram(name) {
  const def = M.machines[name];
  const edges = new Map();
  // A state whose ways out are exactly those of a brand-new record is drawn once, with a note.
  const outs = f => def.transitions.filter(x => x[0] === f).map(([, e, t]) => `${e}>${t}`).sort().join(',');
  const sameAsNew = Object.keys(def.states).filter(st => outs(st) && outs(st) === outs(M.NEW));
  for (const [f, e, t] of def.transitions) {
    if (sameAsNew.includes(f)) continue;
    const k = `${f || '[*]'} --> ${t}`;
    edges.set(k, [...(edges.get(k) || []), e]);
  }
  const lines = ['```mermaid', 'stateDiagram-v2', '  direction LR'];
  for (const [s, st] of Object.entries(def.states)) lines.push(`  ${s} : ${st.label.replace(/[:;]/g, ' ')}`);
  for (const [k, events] of edges) lines.push(`  ${k} : ${[...new Set(events)].join(' / ')}`);
  for (const [s, st] of Object.entries(def.states)) if (st.final) lines.push(`  ${s} --> [*]`);
  for (const st of sameAsNew) lines.push(`  note left of ${st} : same ways out as a new ${def.title.toLowerCase()}`);
  lines.push('```');
  return lines.join('\n');
}

function render() {
  const out = [
    '# State machines',
    '',
    '<!-- Generated from app/public/machines.js by `cd app && npm run states:doc`. Do not edit by hand. -->',
    '',
    'Everything in WA Box that moves through steps is written down as a state machine in',
    '[`app/public/machines.js`](../app/public/machines.js): which states exist, what each one means to a person',
    '(the app shows these words and, on hover, the meaning), and which changes are allowed.',
    'The server, the browser and the tests all read that one file.',
    '',
    '**Changing one:** add the state or transition in `machines.js` first, then use it in code, then run',
    '`npm run states:doc`. Never rename a stored state: the names are in the database and the public API.',
    '',
    '| Machine | What it is | How it is checked |',
    '|---|---|---|',
    ...Object.entries(M.machines).map(([n, d]) => `| [${d.title}](#${d.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/-$/, '')}) (\`${n}\`) | ${d.about} | ${d.enforced} |`),
    '',
  ];
  for (const [name, def] of Object.entries(M.machines)) {
    out.push(`## ${def.title}`, '', `\`${name}\` · ${def.about}`, '', `*${HOW[def.enforced]}*`, '', diagram(name), '',
      '| State | Shown as | What it means |', '|---|---|---|',
      ...Object.entries(def.states).map(([s, st]) => `| \`${s}\`${st.final ? ' (final)' : ''}${st.app ? ' (app only)' : ''} | ${st.label} | ${st.help} |`), '');
    const groups = Object.entries(def.groups || {});
    if (groups.length) {
      out.push('Named groups (use these in code instead of listing states):', '', '| Group | States |', '|---|---|',
        ...groups.map(([g, ss]) => `| \`${g}\` | ${ss.map(x => `\`${x}\``).join(', ')} |`), '');
    }
  }
  return out.join('\n');
}

const DOC = path.join(__dirname, '../../docs/STATE-MACHINES.md');
module.exports = { render, DOC };
if (require.main === module) { fs.writeFileSync(DOC, render()); console.log(`wrote ${path.relative(process.cwd(), DOC)}`); }

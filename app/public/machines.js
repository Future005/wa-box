// WA Box state machines: the one place that says which states exist, what each one means to a
// person, and which changes are allowed. Shared by the server (require), the browser
// (window.WABoxMachines) and the tests. docs/STATE-MACHINES.md is generated from this file
// (`npm run states:doc`), so the diagrams can't drift from the code.
//
// How each machine is kept honest (`enforced`):
//   database  every status change is checked by a SQLite trigger against `transitions` below;
//             anything else is recorded in `state_violations` (tests fail on it, production logs it).
//   engine    the WhatsApp engine checks its own status changes against `transitions` and logs
//             anything unexpected (engine/src/states.js mirrors this one; a test keeps them equal).
//   code      held in memory or derived; the code that changes it uses this definition.
//
// The state names are stored in the database and returned by the public API, so never rename one.
// Add a state or transition here first, then use it.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.WABoxMachines = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const NEW = '';   // "no row yet": the from-state of a transition that creates the record
  // Events only a person can cause. A state marked `final` changes only through one of these:
  // nothing more happens to it by itself.
  const PERSON_EVENTS = ['send_again', 'mark_sent', 'all_resolved'];

  const machines = {
    // ---------------------------------------------------------------------------------------
    job: {
      title: 'Message',
      about: 'A scheduled message (one-off or weekly). Stored in jobs.status.',
      enforced: 'database', table: 'jobs',
      states: {
        draft: { label: 'Draft', tone: 'neutral', help: 'No time yet, so nothing is sent. Open it to finish it and schedule it.' },
        scheduled: { label: 'Scheduled', tone: 'neutral', help: 'Waiting for its time. You can still edit, reschedule or abort it.' },
        running: { label: 'Sending', tone: 'active', help: 'Going out group by group, with gaps in between. You can abort it or change the rest.' },
        done: { label: 'Done', tone: 'good', final: true, help: 'Every group got it.' },
        done_with_errors: { label: 'Done, with errors', tone: 'bad', final: true, help: "Some groups didn't get it. Open it to see which, then send again or mark as sent." },
        cancelled: { label: 'Aborted', tone: 'warn', final: true, help: 'Aborted before it finished. Groups that already got it keep it.' },
      },
      transitions: [
        [NEW, 'schedule', 'scheduled'],
        [NEW, 'save_draft', 'draft'],                          // also: what's left of an aborted message
        ['draft', 'schedule', 'scheduled'],
        ['scheduled', 'unschedule', 'draft'],                  // only before any group got it
        ['scheduled', 'start', 'running'],
        ['running', 'finish', 'done'],
        ['running', 'finish_with_problems', 'done_with_errors'],
        ['scheduled', 'finish', 'done'],                       // late: marked missed without starting
        ['scheduled', 'finish_with_problems', 'done_with_errors'],
        ['running', 'next_week', 'scheduled'],                 // a weekly message finished this time
        ['running', 'abort_this_time', 'scheduled'],           // weekly: aborted this time, repeat carries on
        ['scheduled', 'abort', 'cancelled'],
        ['running', 'abort', 'cancelled'],
        ['done_with_errors', 'all_resolved', 'done'],          // every problem group marked as sent
        ['done', 'send_again', 'running'],
        ['done_with_errors', 'send_again', 'running'],
      ],
      groups: {
        active: ['scheduled', 'running'],
        final: ['done', 'done_with_errors', 'cancelled'],
        canSendAgain: ['scheduled', 'running', 'done', 'done_with_errors'],
        drafts: ['draft'],
      },
    },

    // ---------------------------------------------------------------------------------------
    send: {
      title: 'Send to one group',
      about: 'One message to one group, for one date. Stored in sends.status. Written ahead: "sending" is recorded before the request leaves.',
      enforced: 'database', table: 'sends',
      states: {
        pending: { label: 'Waiting', tone: 'neutral', help: 'Not sent yet. It goes out in turn.' },
        retry: { label: 'Retrying', tone: 'warn', help: 'WhatsApp wasn\'t ready a moment ago. WA Box tries once more shortly.' },
        sending: { label: 'Sending', tone: 'active', help: 'Going out right now.' },
        uncertain: { label: 'Checking', tone: 'active', help: 'WhatsApp gave no clear answer, so WA Box is looking in the group to see if it arrived. It never resends blindly.' },
        sent: { label: 'Sent', tone: 'good', final: true, help: 'The group got it.' },
        dry_run: { label: 'Practice', tone: 'neutral', final: true, help: 'Practice mode: nothing was actually sent.' },
        failed: { label: 'Failed', tone: 'bad', help: "WhatsApp said no, so the group didn't get it. Send again, or mark as sent if it did arrive." },
        unconfirmed: { label: 'Unconfirmed', tone: 'bad', help: 'Unclear if it arrived and WA Box could not check. Look in the group, then mark as sent or send again.' },
        skipped: { label: 'Skipped', tone: 'warn', help: "This number isn't in the group any more (left it, removed, or another number is linked)." },
        missed: { label: 'Missed', tone: 'bad', help: 'Its time passed by more than the late limit while WA Box or WhatsApp was offline, so it was not sent late.' },
        blocked_duplicate: { label: 'Duplicate blocked', tone: 'warn', help: 'The same message already went to this group recently, so it was blocked. Send again if it really should go twice.' },
        cancelled: { label: 'Not sent (aborted)', tone: 'warn', final: true, help: 'Aborted before it reached this group.' },
      },
      transitions: [
        [NEW, 'write_ahead', 'sending'],
        [NEW, 'practice', 'dry_run'],
        [NEW, 'skip', 'skipped'],
        [NEW, 'miss', 'missed'],
        [NEW, 'block_duplicate', 'blocked_duplicate'],
        [NEW, 'abort', 'cancelled'],
        ...['pending', 'retry'].flatMap(s => [
          [s, 'write_ahead', 'sending'], [s, 'practice', 'dry_run'], [s, 'skip', 'skipped'],
          [s, 'miss', 'missed'], [s, 'block_duplicate', 'blocked_duplicate'], [s, 'abort', 'cancelled'],
        ]),
        ['sending', 'deliver', 'sent'],
        ['sending', 'retry_later', 'retry'],                   // engine said "not ready": definitely not sent
        ['sending', 'fail', 'failed'],                         // engine said no: definitely not sent
        ['sending', 'unclear', 'uncertain'],                   // no clear answer: maybe sent
        ['sending', 'abort', 'cancelled'],                     // aborted during the "typing…" pause
        ['sending', 'verified', 'sent'],                       // after a restart: found in the chat
        ['sending', 'not_verified', 'unconfirmed'],            // after a restart: couldn't confirm
        ['uncertain', 'verified', 'sent'],
        ['uncertain', 'not_verified', 'unconfirmed'],
        ['unconfirmed', 'mark_sent', 'sent'],
        ['failed', 'mark_sent', 'sent'],
        ...['unconfirmed', 'failed', 'skipped', 'missed', 'blocked_duplicate'].map(s => [s, 'send_again', 'retry']),
      ],
      groups: {
        delivered: ['sent', 'dry_run'],
        inFlight: ['sending', 'uncertain'],
        waiting: ['pending', 'retry'],
        didNotGet: ['failed', 'missed', 'unconfirmed', 'blocked_duplicate', 'skipped'],   // "problems"
        aborted: ['cancelled'],
        // Used by specific rules (keep each rule's meaning when editing):
        noResend: ['sent', 'dry_run', 'skipped', 'missed', 'blocked_duplicate', 'unconfirmed'],   // the run moves past these
        mayHaveReached: ['sent', 'sending', 'uncertain', 'unconfirmed'],     // duplicate guard looks at these
        usesBudget: ['sent', 'sending', 'uncertain'],                        // count toward daily/hourly limits
        reachedOrReaching: ['sent', 'dry_run', 'sending', 'uncertain'],      // "already got it" when aborting
        probablyGotIt: ['sent', 'dry_run', 'uncertain'],                     // final count after an abort
        unresolved: ['unconfirmed', 'sending', 'uncertain'],                 // shown on the System page
      },
    },

    // ---------------------------------------------------------------------------------------
    delivery: {
      title: 'Webhook delivery',
      about: 'One event posted to one webhook. Stored in hook_deliveries.status. Retries with backoff while pending.',
      enforced: 'database', table: 'hook_deliveries',
      states: {
        pending: { label: 'Queued', tone: 'neutral', help: 'Waiting to be posted, or waiting to retry after a failed try.' },
        ok: { label: 'Delivered', tone: 'good', final: true, help: 'The webhook answered with 2xx.' },
        failed: { label: 'Gave up', tone: 'bad', final: true, help: 'No 2xx answer after every retry. An alert was raised.' },
      },
      transitions: [
        [NEW, 'queue', 'pending'],
        ['pending', 'deliver', 'ok'],
        ['pending', 'give_up', 'failed'],
      ],
      groups: {},
    },

    // ---------------------------------------------------------------------------------------
    connection: {
      title: 'WhatsApp connection',
      about: 'The linked WhatsApp session in the engine. "unknown" and "unreachable" are how the app sees the engine; the rest come from the engine.',
      enforced: 'engine',
      states: {
        unknown: { label: 'Checking…', tone: 'neutral', app: true, help: 'WA Box has just started and hasn\'t heard from WhatsApp yet.' },
        unreachable: { label: 'Engine offline', tone: 'bad', app: true, help: 'The WhatsApp engine is starting or offline. Scheduled messages wait.' },
        reconnecting: { label: 'Reconnecting…', tone: 'warn', app: true, help: "Still linked, but WhatsApp's own connection dropped for a moment (this happens a few times a day). It comes back by itself, usually within seconds; sends wait until it does. Nothing to do." },
        created: { label: 'Not connected', tone: 'warn', help: 'The engine is up but hasn\'t started WhatsApp yet.' },
        initializing: { label: 'Starting WhatsApp…', tone: 'warn', help: 'Opening WhatsApp Web. Usually under a minute.' },
        qr_ready: { label: 'Waiting for QR scan', tone: 'warn', help: 'Scan the QR code from the phone: WhatsApp → Settings → Linked devices → Link a device.' },
        authenticating: { label: 'Connecting…', tone: 'warn', help: 'Logging in with the saved link.' },
        ready: { label: 'WhatsApp connected', tone: 'good', help: 'Linked and ready to send.' },
        disconnected: { label: 'Disconnected', tone: 'bad', help: 'The connection dropped (or the phone unlinked it). WA Box restarts it by itself.' },
        failed: { label: 'Could not start', tone: 'bad', help: 'WhatsApp failed to start. WA Box retries by itself with growing waits.' },
      },
      transitions: [
        ['created', 'start', 'initializing'],
        ['initializing', 'need_scan', 'qr_ready'],
        ['initializing', 'session_found', 'authenticating'],
        ['initializing', 'start_failed', 'failed'],
        ['qr_ready', 'scanned', 'authenticating'],
        ['authenticating', 'ready', 'ready'],
        ['authenticating', 'login_failed', 'failed'],
        ...['qr_ready', 'authenticating', 'ready'].map(s => [s, 'dropped', 'disconnected']),
        ...['qr_ready', 'authenticating', 'ready', 'disconnected', 'failed'].map(s => [s, 'restart', 'initializing']),
        ['initializing', 'ready', 'ready'],
        ['qr_ready', 'login_failed', 'failed'],
        ['qr_ready', 'ready', 'ready'],                        // some sessions report ready without "authenticated"
        // App view only: linked, but WhatsApp Web's own connection is down for a moment.
        ['ready', 'link_dropped', 'reconnecting'], ['reconnecting', 'link_back', 'ready'],
        ['reconnecting', 'dropped', 'disconnected'], ['reconnecting', 'restart', 'initializing'],
      ],
      groups: {
        starting: ['unknown', 'created', 'initializing', 'authenticating'],
        // Nothing for a person to do: it is getting there by itself (a scan is only needed in qr_ready).
        selfHealing: ['unknown', 'created', 'initializing', 'authenticating', 'reconnecting', 'unreachable', 'disconnected', 'failed'],
      },
    },

    // ---------------------------------------------------------------------------------------
    sync: {
      title: 'Group sync',
      about: 'Reading the linked number\'s groups from WhatsApp (groups.js, in memory, per number).',
      enforced: 'code',
      states: {
        never: { label: 'Not synced yet', tone: 'neutral', help: 'Groups sync by themselves a minute after the number connects.' },
        syncing: { label: 'Syncing…', tone: 'active', help: 'Reading every group on this number.' },
        synced: { label: 'Synced', tone: 'good', help: 'Groups are up to date. They refresh every 6 hours, or press Sync groups now.' },
        failed: { label: 'Sync failed', tone: 'bad', help: 'WA Box tries again by itself in 2 minutes.' },
      },
      transitions: [
        ['never', 'sync', 'syncing'], ['synced', 'sync', 'syncing'], ['failed', 'retry', 'syncing'],
        ['syncing', 'ok', 'synced'], ['syncing', 'error', 'failed'],
      ],
      groups: {},
    },

    // ---------------------------------------------------------------------------------------
    number: {
      title: 'Number profile',
      about: 'Each WhatsApp number that has been linked keeps its own groups, lists and messages. Derived from which number is in use and whether WhatsApp is connected.',
      enforced: 'code',
      states: {
        linked: { label: 'Linked now', tone: 'good', help: 'Its messages send.' },
        not_connected: { label: 'In use, not connected', tone: 'warn', help: 'The number in use, but WhatsApp isn\'t connected right now. Its messages wait.' },
        kept: { label: 'Kept', tone: 'neutral', help: 'Linked before. Its messages wait until it\'s linked again.' },
      },
      transitions: [
        [NEW, 'link', 'linked'],
        ['linked', 'connection_lost', 'not_connected'], ['not_connected', 'reconnect', 'linked'],
        ['linked', 'other_number_linked', 'kept'], ['not_connected', 'other_number_linked', 'kept'],
        ['kept', 'link', 'linked'],
      ],
      groups: {},
    },

    // ---------------------------------------------------------------------------------------
    mode: {
      title: 'Sending mode',
      about: 'Whether messages really go out. Derived from settings: paused wins over practice.',
      enforced: 'code',
      states: {
        practice: { label: 'Practice mode', tone: 'neutral', help: 'Nothing is actually sent. Local copies always start here.' },
        live: { label: 'Live', tone: 'good', help: 'Messages really go out.' },
        paused: { label: 'Paused', tone: 'warn', help: 'Nothing goes out until someone resumes. The safety pause does this after repeated failures.' },
      },
      transitions: [
        ['practice', 'go_live', 'live'], ['live', 'practice_on', 'practice'],
        ['live', 'pause', 'paused'], ['practice', 'pause', 'paused'], ['live', 'safety_pause', 'paused'],
        ['paused', 'resume', 'live'], ['paused', 'resume', 'practice'],
      ],
      groups: {},
    },

    // ---------------------------------------------------------------------------------------
    alert: {
      title: 'Alert',
      about: 'Something a person should know about. Stored in alert_log.open (1 open, 0 cleared); repeats are rate-limited.',
      enforced: 'code',
      states: {
        open: { label: 'Needs attention', tone: 'bad', help: 'Shown as an issue until it clears or someone fixes it.' },
        cleared: { label: 'Cleared', tone: 'good', help: 'Fixed or no longer true.' },
      },
      transitions: [[NEW, 'raise', 'open'], ['open', 'clear', 'cleared'], ['cleared', 'raise', 'open']],
      groups: {},
    },

    // ---------------------------------------------------------------------------------------
    session: {
      title: 'Sign-in',
      about: 'A person using the web app (auth.js + the first screens in app.js).',
      enforced: 'code',
      states: {
        signed_out: { label: 'Signed out', tone: 'neutral', help: 'Sign in with your email and password.' },
        must_change_password: { label: 'Choose a password', tone: 'warn', help: 'First sign-in with a one-time password: choose your own.' },
        signed_in: { label: 'Signed in', tone: 'good', help: 'Using WA Box.' },
      },
      transitions: [
        ['signed_out', 'sign_in', 'signed_in'], ['signed_out', 'sign_in_first_time', 'must_change_password'],
        ['must_change_password', 'password_chosen', 'signed_in'],
        ['signed_in', 'sign_out', 'signed_out'], ['signed_in', 'session_ended', 'signed_out'], ['must_change_password', 'sign_out', 'signed_out'],
      ],
      groups: {},
    },
  };

  // ---------- helpers ----------
  const m = name => { const x = machines[name]; if (!x) throw new Error(`Unknown state machine "${name}"`); return x; };
  const state = (name, s) => m(name).states[s] || null;
  const label = (name, s) => state(name, s)?.label || String(s || '').replace(/_/g, ' ');
  const help = (name, s) => state(name, s)?.help || '';
  const tone = (name, s) => state(name, s)?.tone || 'neutral';
  const group = (name, g) => { const x = m(name).groups[g]; if (!x) throw new Error(`Unknown group "${g}" in ${name}`); return x; };
  const is = (name, s, g) => group(name, g).includes(s);
  const canGo = (name, from, to) => from === to || m(name).transitions.some(([f, , t]) => f === (from ?? NEW) && t === to);
  /** The state an event leads to from `from`, or null if that event isn't allowed there. */
  const next = (name, from, event) => (m(name).transitions.find(([f, e]) => f === (from ?? NEW) && e === event) || [])[2] || null;
  const can = (name, from, event) => next(name, from, event) !== null;
  /** Every distinct [from, to] pair (for the database check). */
  const pairs = name => [...new Set(m(name).transitions.map(([f, , t]) => `${f}\u0000${t}`))].map(k => k.split('\u0000'));

  /** What the app shows for the connection: the engine's status, or "reconnecting" when linked but not live. */
  const connectionView = wa => (wa && wa.status === 'ready' && wa.live === false ? 'reconnecting' : (wa && wa.status) || 'unknown');

  return { NEW, PERSON_EVENTS, connectionView, machines, state, label, help, tone, group, is, canGo, next, can, pairs };
});

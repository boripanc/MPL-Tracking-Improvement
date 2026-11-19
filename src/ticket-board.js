'use strict';

/*
 * Ticket pulse on WorkStream: keeps one WorkStream board (KANBAN_TICKET_BOARD, "Ticket pulse") in step with the
 * Freshservice tickets table, one way. Each ticket is one card; its column follows the ticket status.
 *
 * The board is for tracking only. Every run puts each ticket card back the way Freshservice has it, so a card
 * that was dragged or edited on the board is reset on the next run. Nothing goes back to Freshservice.
 * Cards that do not start with a ticket id (added by hand) are left alone. Each card is assigned to the ticket's
 * agent (Freshservice responder); WorkStream asks the board owner to approve each assignment, and a request that is
 * still waiting is not sent again.
 */

const COLUMNS = ['Open', 'In Progress', 'Pending', 'Resolved / Closed'];
const SEP = ' · ';
const ID_RE = /^([A-Z]{1,10}-\d+) · /;

function columnFor(t) {
  if (t.closed) return 'Resolved / Closed';
  if (t.status === 'Open') return 'Open';
  if (t.status === 'In Progress') return 'In Progress';
  // Pending and any other open status (waiting on customer, on hold, ...).
  return 'Pending';
}

/** YYYY-MM-DD of a timestamp in the given time zone. */
function day(ts, tz) {
  if (!ts) return null;
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ts));
}

/** The card a ticket should be: { title, column, description, priority, startDate, dueDate, labels, assignees }. */
function cardFor(t, { tz = 'Asia/Bangkok', now = Date.now() } = {}) {
  const overdue = !t.closed && t.due_by && new Date(t.due_by).getTime() < now;
  const lines = [
    `Freshservice status: ${t.status || 'None'}${t.pending_reason ? ` (${t.pending_reason})` : ''}`,
    `Responder: ${t.responder || 'Unassigned'}`,
    t.grp ? `Group: ${t.grp}` : null,
    t.requester || t.entity ? `Requester: ${[t.requester, t.entity].filter(Boolean).join(', ')}` : null,
    [t.category, t.sub_category, t.item].some(Boolean) ? `Category: ${[t.category, t.sub_category, t.item].filter(Boolean).join(' > ')}` : null,
    `Created: ${day(t.created_at, tz)}`,
    t.closed ? `Closed: ${day(t.updated_at, tz)}` : null,
    t.link ? `Open in Freshservice: ${t.link}` : null,
    '',
    'Read only: this card is kept in step with Freshservice by CPI Error Center. Changes made here are reset on the next sync.',
  ].filter((l) => l !== null);
  return {
    title: `${t.id}${SEP}${t.subject || '(no subject)'}`.slice(0, 200),
    column: columnFor(t),
    description: lines.join('\n'),
    priority: overdue ? 'high' : 'none',
    startDate: day(t.created_at, tz),
    dueDate: t.closed ? null : day(t.due_by, tz),
    labels: t.type ? [t.type] : [],
    assignees: t.responder ? [t.responder] : [],
  };
}

function ticketIdOf(card) {
  const m = ID_RE.exec(card.title || '');
  return m ? m[1] : null;
}

const labelNames = (labels) => (labels || []).map((l) => (typeof l === 'string' ? l : l.name)).sort();
const names = (list) => (list || []).map((x) => (typeof x === 'string' ? x : x && x.name)).filter(Boolean).map((x) => x.toLowerCase()).sort();

/** Names in an assignment request that waits for the owner's approval; [] = a request we cannot read; null = none. */
function pendingNames(card) {
  const pa = card.pendingAssignment;
  if (!pa) return null;
  return names(Array.isArray(pa) ? pa : pa.assignees || pa.names || pa.requested || []);
}

/** True when the card should get a new assignment request. */
function needsAssignment(have, want) {
  const target = JSON.stringify(names(want));
  if (JSON.stringify(names(have.assignees)) === target) return false;
  const pending = pendingNames(have);
  // A request is already waiting for this (or, when we cannot read it, some) assignment: do not ask again.
  if (pending && (!pending.length || JSON.stringify(pending) === target)) return false;
  return true;
}

/** The fields of `want` that differ on the card `have` (empty object = nothing to change). */
function changes(have, want) {
  const out = {};
  if (have.column !== want.column) out.column = want.column;
  if (have.title !== want.title) out.title = want.title;
  if ((have.description || '') !== want.description) out.description = want.description;
  if ((have.priority || 'none') !== want.priority) out.priority = want.priority;
  if ((have.startDate || null) !== want.startDate) out.startDate = want.startDate;
  if ((have.dueDate || null) !== want.dueDate) out.dueDate = want.dueDate;
  if (JSON.stringify(labelNames(have.labels)) !== JSON.stringify(labelNames(want.labels))) out.labels = want.labels;
  if (want.assignees && needsAssignment(have, want.assignees)) out.assignees = want.assignees;
  return out;
}

/**
 * What to do on the board: cards to create, cards to update and ticket cards to delete (the ticket left the
 * window, was filtered out, or is a duplicate).
 */
function plan(cards, tickets, opts) {
  const byId = new Map();
  const remove = [];
  for (const c of cards) {
    const id = ticketIdOf(c);
    if (!id) continue;
    if (byId.has(id)) remove.push(c);
    else byId.set(id, c);
  }
  const create = [];
  const update = [];
  const seen = new Set();
  for (const t of tickets) {
    if (seen.has(t.id)) continue;
    seen.add(t.id);
    const want = cardFor(t, opts);
    const have = byId.get(t.id);
    if (!have) { create.push(want); continue; }
    const diff = changes(have, want);
    if (Object.keys(diff).length) update.push({ cardId: have.id, ...diff });
  }
  for (const [id, c] of byId) if (!seen.has(id)) remove.push(c);
  return { create, update, remove };
}

/** Runs one sync; returns { board, created, updated, removed, tickets } or { skipped: reason }. */
async function syncTicketBoard({ kanban, tickets, config, logger = console }) {
  const k = config.kanban;
  if (!kanban.enabled || !k.ticketBoard) return { skipped: 'off' };
  const st = await kanban.status();
  if (!st.connected) return { skipped: 'not connected' };
  const rows = await tickets.boardTickets({ doneDays: k.ticketBoardDoneDays });
  if (!rows) return { skipped: 'no tickets table' };
  const r = await kanban.syncBoard({
    title: k.ticketBoard,
    columns: COLUMNS,
    plan: (cards) => plan(cards, rows, { tz: k.ticketBoardTz }),
  });
  logger.log(`[ticket-board] "${r.board.title}": ${rows.length} tickets, ${r.created} created, ${r.updated} updated, ${r.removed} removed`
    + (r.failed ? `, ${r.failed} failed (${r.errors[0]})` : ''));
  return { ...r, tickets: rows.length };
}

/**
 * The sync job: `run()` runs it now (at most one run at a time), `start()` runs it every KANBAN_TICKET_SYNC_MINUTES,
 * `state.last` keeps the result of the latest run for the status endpoint.
 */
function createTicketBoardSync({ kanban, tickets, config, logger = console }) {
  const state = { running: null, last: null };
  const enabled = Boolean(kanban.enabled && config.kanban.ticketBoard);
  let first = null;
  let timer = null;
  const once = async () => {
    const at = new Date().toISOString();
    try {
      state.last = { at, ok: true, ...(await syncTicketBoard({ kanban, tickets, config, logger })) };
    } catch (err) {
      logger.error('[ticket-board] sync failed:', err.message);
      state.last = { at, ok: false, error: err.message };
    }
    return state.last;
  };
  const run = () => {
    if (!state.running) state.running = once().finally(() => { state.running = null; });
    return state.running;
  };
  return {
    enabled,
    run,
    status: () => ({ enabled, board: config.kanban.ticketBoard || null, minutes: config.kanban.ticketBoardMinutes, running: Boolean(state.running), last: state.last }),
    start() {
      if (!enabled || timer) return;
      first = setTimeout(run, 15000);
      timer = setInterval(run, config.kanban.ticketBoardMinutes * 60000);
    },
    stop() { clearTimeout(first); clearInterval(timer); timer = null; },
  };
}

module.exports = { COLUMNS, columnFor, cardFor, ticketIdOf, changes, plan, syncTicketBoard, createTicketBoardSync };

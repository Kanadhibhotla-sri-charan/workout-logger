// Read-only dry run (2026-10-27): the session plan for a date with the
// weekly ledger off vs on. No provider call, no writes beyond what opening
// the database does. Run against a COPY of a database, from the repo root
// after `npm run build`:
//   node scripts/ledger-dry-run.mjs <db-copy> <YYYY-MM-DD> <push|pull|upper|legs>
const [dbPath, targetDate, purpose] = process.argv.slice(2);
const root = new URL('../dist/', import.meta.url);
const { openDb } = await import(new URL('db/client.js', root));
const { buildProgrammerContext } = await import(new URL('ai-programmer/context/programmerContextBuilder.js', root));
const { planSession } = await import(new URL('ai-programmer/planning/sessionPlanner.js', root));
const { buildWeeklyLedger } = await import(new URL('ai-programmer/planning/weeklyLedger.js', root));
const { applyWeeklyLedgerPlannable: applyWeeklyLedger } = await import(new URL('ai-programmer/planning/ledgerBrief.js', root));

const db = openDb(dbPath);
const context = buildProgrammerContext(db, { targetDate, requestedSessionPurpose: purpose });
const ledger = buildWeeklyLedger(db, context);
const show = (label, ctx) => {
  const plan = planSession(ctx);
  const planned = plan.targets.filter((t) => t.status === 'required' || t.status === 'selected');
  console.log(`\n== ${label}: ${plan.reserved.exerciseSlots} reserved exercise slot(s), refusals ${JSON.stringify(plan.refusals.map((r) => r.code))}`);
  for (const t of planned) console.log(`  ${t.status.padEnd(8)} ${t.targetId.padEnd(26)} min ${t.plannedMinimumSets}  slots ${t.reservedExerciseSlots}`);
  for (const t of plan.targets.filter((t) => t.status === 'deferred')) console.log(`  deferred ${t.targetId}: ${t.reason}`);
};
console.log('ledger:', ledger.entries.filter((e) => e.status !== 'not_today').map((e) => `${e.targetId}=${e.status}${e.mustSetsToday ? `(${e.mustSetsToday})` : ''}`).join(' '));
show('OLD (ledger off)', context);
show('NEW (ledger on)', applyWeeklyLedger(context, ledger));
db.close();

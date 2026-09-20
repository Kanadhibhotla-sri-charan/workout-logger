// Eval-only whole-week two-step harness. It deliberately does not change the
// production app: one reasoning call and one commit call return all 7 days.
import { randomUUID } from 'node:crypto';
import { openDb } from '../dist/db/client.js';
import { buildReconciliationContext } from '../dist/ai-programmer/context/reconciliationContextBuilder.js';
import { buildProgrammingBrief } from '../dist/ai-programmer/context/programmerContextBuilder.js';
import { buildWeekReconciliationSystemInstruction } from '../dist/ai-programmer/service/aiProgrammerService.js';
import { getWeekReconciliationOutputSchema } from '../dist/ai-programmer/contracts/weekReconciliationOutputSchema.js';
import { validateWeekReconciliationSchema } from '../dist/ai-programmer/validation/weekReconciliationOutputValidator.js';
import { validateWeekReconciliationDomain } from '../dist/ai-programmer/validation/weekReconciliationDomainValidator.js';
import { VelonaProvider } from '../dist/ai-programmer/provider/velonaProvider.js';
import { loadVelonaConfig } from '../dist/ai-programmer/provider/config.js';

const db = openDb(process.env.DB_PATH || '/tmp/eval.sqlite');
const targetDate = process.env.EVAL_TARGET_DATE || '2026-09-21';
const context = buildReconciliationContext(db, { targetDate, requestedActivity: 'gym' });
const provider = new VelonaProvider({ ...loadVelonaConfig(), model: process.env.VELONA_MODEL });
const reasoningSchema = { type: 'object', additionalProperties: false, required: ['weekStrategy', 'goalPriority'], properties: { weekStrategy: { type: 'string' }, goalPriority: { type: 'string' } } };
const reasoningInstruction = 'You are a coaching reviewer. Analyze the complete week context, recent history, active goals, recovery, and session caps. Decide how to distribute quality work across the week. State which goal targets deserve priority, which non-goal targets should be deferred, and why. Return only JSON matching the supplied schema.';
const commitInstruction = `${buildWeekReconciliationSystemInstruction()}\n\n[EVAL-ONLY WHOLE-WEEK GENERATION] Return a complete fresh week using all unlocked gym days in context.existingProgram. You may modify every unlocked future gym session, not only the requested target date. Use priorReasoning as your own planning pass. Preserve rest/badminton activities and locked days. Prioritize quality over filling every eligible target; defer non-goal work when that creates better goal-session quality. Add deliberate shortfalls to reconciliation.deferrals; the harness computes unmetSets from the exact weekly reference minus planned sets, so do not invent or use zero. Goal shortfalls require recovery or recent_overexposure and must include carryover. Normal-muscle shortfalls are warnings, not failures.`;

const programmingBrief = buildProgrammingBrief(
  context.targets,
  context.activeGoals,
  null,
  context.existingProgram.filter((d) => d.sessionPurpose).map((d) => ({ name: d.sessionPurpose })),
  targetDate,
  context.profile.defaultSessionDurationMinutes
);
const evalContext = { ...context, programmingBrief };

async function call(systemInstruction, ctx, schema) {
  return provider.generate({ mode: 'reconcile_week', systemInstruction, context: ctx, outputSchema: schema, requestId: randomUUID() });
}

function calculateWeeklyVolume(rawWeek, ctx) {
  const totals = new Map();
  for (const day of rawWeek.days ?? []) {
    for (const exercise of day.session?.exercises ?? []) {
      const key = `${exercise.targetType}:${exercise.targetId}`;
      totals.set(key, (totals.get(key) ?? 0) + exercise.sets);
    }
  }
  const guidance = new Map((ctx.programmingBrief?.muscles ?? []).map((m) => [`${m.targetType}:${m.targetId}`, m]));
  const targetRows = [];
  const goalShortfalls = [];
  const normalShortfalls = [];
  for (const [key, g] of guidance) {
    if (g.weeklyDevelopmentReference == null) continue;
    const actual = totals.get(key) ?? 0;
    const reference = g.weeklyDevelopmentReference;
    const shortfall = Math.max(0, reference - actual);
    const target = ctx.targets.find((t) => `${t.targetType}:${t.targetId}` === key);
    const row = { targetType: g.targetType, targetId: g.targetId, reference, generatedDirectSets: actual, shortfall, goal: Boolean(target?.goalId), horizon: 'week' };
    targetRows.push(row);
    if (shortfall > 0) (target?.goalId ? goalShortfalls : normalShortfalls).push(row);
  }
  return { targetRows, goalShortfalls, normalShortfalls };
}

const reasoningResponse = await call(reasoningInstruction, evalContext, reasoningSchema);
let reasoning;
try { reasoning = JSON.parse(reasoningResponse.rawText); } catch (e) { throw new Error(`reasoning JSON invalid: ${e.message}`); }
const evalSchema = getWeekReconciliationOutputSchema();
evalSchema.required.push('reconciliation');
evalSchema.properties.reconciliation.required.push('deferrals');
evalSchema.properties.reconciliation.properties.deferrals = { type: 'array', items: { type: 'object', required: ['targetId', 'unmetSets', 'horizon', 'reasonCode', 'evidence'], properties: { targetId: { type: 'string' }, unmetSets: { type: 'integer', minimum: 1 }, horizon: { enum: ['week', 'two_week'] }, reasonCode: { enum: ['recent_overexposure', 'recovery', 'capacity', 'rotation'] }, evidence: { type: 'string' } } } };
const commitResponse = await call(commitInstruction, { ...evalContext, priorReasoning: reasoning }, evalSchema);
let raw;
try { raw = JSON.parse(commitResponse.rawText); } catch (e) { throw new Error(`commit JSON invalid: ${e.message}`); }
const volume = calculateWeeklyVolume(raw, evalContext);
if (raw.reconciliation?.deferrals) {
  raw.reconciliation.deferrals = raw.reconciliation.deferrals
    .map((d) => ({ ...d, unmetSets: volume.targetRows.find((r) => r.targetId === d.targetId)?.shortfall ?? d.unmetSets }))
    .filter((d) => d.unmetSets > 0);
}
const structural = validateWeekReconciliationSchema(raw);
const result = { targetDate, reasoning, rawOutput: raw, structural, usage: { reasoning: reasoningResponse.usage, commit: commitResponse.usage } };
if (structural.ok && structural.value) {
  result.domain = validateWeekReconciliationDomain(structural.value, evalContext, db);
  const deferrals = raw.reconciliation?.deferrals ?? [];
  const goalTargetIds = new Set(context.activeGoals.flatMap((g) => g.primaryTargetIds ?? []).concat(context.activeGoals.flatMap((g) => g.supportingTargetIds ?? [])));
  const deferralErrors = [];
  for (const d of deferrals) {
    if (goalTargetIds.has(d.targetId) && !['recovery', 'recent_overexposure'].includes(d.reasonCode)) {
      deferralErrors.push(`goal target ${d.targetId} has an invalid deferral reasonCode ${d.reasonCode}`);
    }
    if (!Number.isInteger(d.unmetSets) || d.unmetSets < 1) deferralErrors.push(`deferral for ${d.targetId} must record positive unmetSets`);
  }
  for (const row of volume.goalShortfalls) {
    const matching = deferrals.filter((d) => d.targetId === row.targetId);
    const covered = matching.reduce((sum, d) => sum + d.unmetSets, 0);
    const validReason = matching.some((d) => ['recovery', 'recent_overexposure'].includes(d.reasonCode));
    if (covered < row.shortfall || !validReason) {
      deferralErrors.push(`goal target ${row.targetId} is short by ${row.shortfall} set(s); recovery/recent_overexposure deferral and carryover are required`);
    }
  }
  result.weekAdequacy = {
    ok: deferralErrors.length === 0,
    deferralErrors,
    volumeByTarget: volume.targetRows,
    normalShortfalls: volume.normalShortfalls,
    normalShortfallsAreWarnings: true,
    legsUseTwoWeekHorizon: true
  };
}
console.log(JSON.stringify(result, null, 2));
db.close();

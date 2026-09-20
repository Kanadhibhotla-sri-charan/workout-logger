// Eval-only whole-week two-step harness. It deliberately does not change the
// production app: one reasoning call and one commit call return all 7 days.
import { randomUUID } from 'node:crypto';
import { openDb } from '../dist/db/client.js';
import { buildReconciliationContext } from '../dist/ai-programmer/context/reconciliationContextBuilder.js';
import { buildProgrammingBrief, readTrainingExperience } from '../dist/ai-programmer/context/programmerContextBuilder.js';
import { UsersRepo } from '../dist/repositories/usersRepo.js';
import { buildWeekReconciliationSystemInstruction } from '../dist/ai-programmer/service/aiProgrammerService.js';
import { getWeekReconciliationOutputSchema } from '../dist/ai-programmer/contracts/weekReconciliationOutputSchema.js';
import { validateWeekReconciliationSchema } from '../dist/ai-programmer/validation/weekReconciliationOutputValidator.js';
import { validateWeekReconciliationDomain } from '../dist/ai-programmer/validation/weekReconciliationDomainValidator.js';
import { repairWeekReconciliation } from '../dist/ai-programmer/validation/programmerProposalRepair.js';
import { auditGoalDeferrals, auditWeeklyVolume, goalBriefVsGenerated } from '../dist/ai-programmer/validation/weeklyVolumeAudit.js';
import { VelonaProvider } from '../dist/ai-programmer/provider/velonaProvider.js';
import { loadVelonaConfig } from '../dist/ai-programmer/provider/config.js';

const db = openDb(process.env.DB_PATH || '/tmp/eval.sqlite');
const targetDate = process.env.EVAL_TARGET_DATE || '2026-09-21';
const context = buildReconciliationContext(db, { targetDate, requestedActivity: 'gym' });
const provider = new VelonaProvider({ ...loadVelonaConfig(), model: process.env.VELONA_MODEL });
const reasoningSchema = { type: 'object', additionalProperties: false, required: ['weekStrategy', 'goalPriority'], properties: { weekStrategy: { type: 'string' }, goalPriority: { type: 'string' } } };
const reasoningInstruction = 'You are a coaching reviewer. Analyze the complete week context, recent history, active goals, recovery, and session caps. Decide how to distribute quality work across the week. State which goal targets deserve priority, which non-goal targets should be deferred, and why. Return only JSON matching the supplied schema.';
const commitInstruction = `${buildWeekReconciliationSystemInstruction()}\n\n[EVAL-ONLY WHOLE-WEEK GENERATION] Return a complete fresh week using all unlocked gym days in context.existingProgram. You may modify every unlocked future gym session, not only the requested target date. Use priorReasoning as your own planning pass. Preserve rest/badminton activities and locked days. Prioritize quality over filling every eligible target; defer non-goal work when that creates better goal-session quality. Add deliberate shortfalls to reconciliation.deferrals; the harness computes unmetSets from the required weekly volume (the brief's recommended weekly sets, capped at what the week can deliver) minus planned sets, so do not invent or use zero. Goal shortfalls require a recovery or recent_overexposure deferral. Normal-muscle shortfalls are warnings, not failures.`;

const programmingBrief = buildProgrammingBrief(
  context.targets,
  context.activeGoals,
  null,
  context.existingProgram.filter((d) => d.sessionPurpose).map((d) => ({ name: d.sessionPurpose })),
  targetDate,
  context.profile.defaultSessionDurationMinutes,
  { deloadActive: false },
  // The same confirmed experience level the deterministic engine's volume decision uses.
  readTrainingExperience(db, new UsersRepo(db).getOrCreateDefault().id, context.currentDate)
);
const evalContext = { ...context, programmingBrief };

async function call(systemInstruction, ctx, schema) {
  return provider.generate({ mode: 'reconcile_week', systemInstruction, context: ctx, outputSchema: schema, requestId: randomUUID() });
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
const structural = validateWeekReconciliationSchema(raw);
const result = { targetDate, reasoning, rawOutput: raw, structural, usage: { reasoning: reasoningResponse.usage, commit: commitResponse.usage } };
if (structural.ok && structural.value) {
  // The same repair production runs on every unlocked day before validation.
  const repaired = repairWeekReconciliation(structural.value, evalContext);
  result.repairedOutput = repaired;
  result.repairNotes = repaired.reconciliation.warnings.filter((w) => !(structural.value.reconciliation.warnings ?? []).includes(w));

  const audit = auditWeeklyVolume(repaired, evalContext);
  // unmetSets is computed here from the audit, never trusted from the model.
  const deferrals = (raw.reconciliation?.deferrals ?? [])
    .map((d) => ({ ...d, unmetSets: audit.rows.find((r) => r.targetId === d.targetId)?.shortfall ?? d.unmetSets }))
    .filter((d) => d.unmetSets > 0);

  // Did the model miss what the brief asked for, or is the audit stricter than the brief?
  result.goalBriefVsGenerated = goalBriefVsGenerated(audit, evalContext.programmingBrief.muscles);
  result.domain = validateWeekReconciliationDomain(repaired, evalContext, db);
  const deferralErrors = auditGoalDeferrals(audit, deferrals, evalContext.targets);
  result.usableAfterRepair = result.domain.ok;
  result.weekAdequacy = {
    ok: deferralErrors.length === 0,
    deferralErrors,
    volumeByTarget: audit.rows,
    normalShortfalls: audit.normalShortfalls,
    normalShortfallsAreWarnings: true
  };
}
console.log(JSON.stringify(result, null, 2));
db.close();

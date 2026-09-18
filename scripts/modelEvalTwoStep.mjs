// Option B eval — "reason, then commit" two-call pipeline for the 6
// genuine-judgment rules (18-23: training experience, intensity
// techniques, antagonist pairing, exercise rotation, structural
// advisories, historical trend). Sibling to scripts/modelEval.mjs (same
// safety discipline: reuses real, already-compiled production code,
// never writes to the database, never persists a proposal) but adds a
// first "reasoning" call with NO output-schema constraint — the point is
// to test whether separating "think about the judgment calls" from
// "produce schema-conformant JSON" gets a cheaper/non-reasoning-tuned
// model to actually engage with rules 18-23 instead of defaulting them
// away under schema pressure, and whether it avoids the structured-output
// token-bloat pattern GPT-5.6 Luna Pro showed (which is why Luna Pro is
// excluded from this batch — this eval is specifically about whether
// CHEAPER models do better under this setup, not about re-confirming
// Luna Pro's known bloat behavior).
//
// The commit step's system instruction is the REAL, unmodified
// buildProgrammerSystemInstruction() output plus exactly one extra rule
// (rule 24, added only for this eval, never shipped to production)
// telling the model to apply step 1's reasoning faithfully. Everything
// else — context, schema, validators — is byte-identical to what
// production actually sends, so a "success" here means the real
// validators the app already enforces would accept it.
//
// Usage: node scripts/modelEvalTwoStep.mjs
// Reads VELONA_API_KEY from the environment (same one the real app
// uses) — run this on the production VM where that's already set via
// the systemd EnvironmentFile, never with a key pasted inline here.

import { openDb } from '../dist/db/client.js';
import { buildProgrammerContext } from '../dist/ai-programmer/context/programmerContextBuilder.js';
import { buildProgrammerSystemInstruction } from '../dist/ai-programmer/service/aiProgrammerService.js';
import { getProgrammerOutputSchema } from '../dist/ai-programmer/contracts/programmerOutputSchema.js';
import { validateProposalSchema } from '../dist/ai-programmer/validation/programmerOutputValidator.js';
import { validateProposalDomain } from '../dist/ai-programmer/validation/programmerDomainValidator.js';
import { validateProposalAdequacy } from '../dist/ai-programmer/validation/programmerAdequacyValidator.js';
import { VelonaProvider, isLikelyTruncatedOutput } from '../dist/ai-programmer/provider/velonaProvider.js';
import { loadVelonaConfig } from '../dist/ai-programmer/provider/config.js';
import { todayForUser } from '../dist/lib/userTimezone.js';
import { weekdayOfDate } from '../dist/engine/workoutBuilder.js';
import { addDays } from '../dist/engine/dateMath.js';
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';

const FULL_RESULTS_PATH = process.env.EVAL_FULL_RESULTS_PATH || '/tmp/twoStepEvalFull.json';

const DB_PATH = process.env.DB_PATH || '/home/ubuntu/workout-logger/data/workout-logger.sqlite';
const REPS_PER_MODEL = Number(process.env.EVAL_REPS || 5);
const CONCURRENCY = Number(process.env.EVAL_CONCURRENCY || 4);

// USD per 1M tokens — Velona's live /models catalog, fetched
// 2026-09-18. Luna Pro deliberately excluded per explicit instruction
// this batch. User's own explicit candidate list.
const CANDIDATES = [
  { model: 'z-ai/glm-5.3-flash', label: 'GLM 5.3 Flash', inputPer1M: 0.09, outputPer1M: 0.3 },
  { model: 'deepseek/deepseek-v4-flash', label: 'DeepSeek V4 Flash (current prod default)', inputPer1M: 0.049, outputPer1M: 0.098 },
  { model: 'mistralai/mistral-small-2603', label: 'Mistral Small 4', inputPer1M: 0.15, outputPer1M: 0.6 },
  { model: 'qwen/qwen3-next-80b-a3b-instruct', label: 'Qwen3 Next 80B A3B Instruct', inputPer1M: 0.09, outputPer1M: 1.1 },
  { model: 'qwen/qwen3-30b-a3b', label: 'Qwen3 30B A3B', inputPer1M: 0.12, outputPer1M: 0.5 },
];

// A real, deliberately small schema for the reasoning step — NOT `null`
// and not the full session-proposal schema. buildVelonaUserTurnContent
// always sends output:{format:'json'} plus a fixed "conforming to
// outputSchema" instruction regardless of what's passed, so `null` would
// produce a confusing, technically-malformed request ("conforming to
// null"). This tests the actual hypothesis under test — a small,
// task-shaped schema vs. the big session-proposal one — without an
// untested/unsupported null-schema edge case.
const REASONING_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['muscleNotes'],
  properties: {
    muscleNotes: {
      type: 'object',
      description: 'Keyed by targetId. Include an entry only for an eligible-today muscle with something non-trivial to say — never pad every muscle with filler.',
      additionalProperties: { type: 'string', description: '2-3 sentences, citing the specific data point behind it.' },
    },
  },
};

function buildReasoningSystemInstruction() {
  return [
    'You are a fitness coach doing ONLY a reasoning pass before another step writes the final session — you are not producing the session itself, and you must not mention sets/reps/RIR numbers at all (those are already fixed elsewhere and not your concern here).',
    'You will be given the same real JSON context a workout-programming step would use. Think through these judgment calls for today\'s eligible muscles (context.programmingBrief.muscles[].eligibleForThisSession=true):',
    '(a) context.trainingExperience — is anything today unusually demanding given this level, worth flagging?',
    '(b) Each exercise\'s plausibleIntensityTechniques (ids — resolve full text via context.intensityTechniqueCatalogue) — is one genuinely worth using today, on which exercise, and why?',
    '(c) Each muscle\'s antagonistGroup — is there a real antagonist-pairing opportunity among today\'s eligible muscles?',
    '(d) Each exercise\'s recentConsecutiveSessionsUsed — is today the day to rotate away from an overused exercise?',
    '(e) context.structuralAdvisories — does any flagged imbalance genuinely change how you\'d weigh an eligible muscle today?',
    '(f) Recent trend data (context.targets[].exerciseHistory, context.coachingFoundation.historicalSummaries) — does a stalling/declining trend argue for a different exercise or angle today?',
    'For each point, ground it in a REAL, SPECIFIC data value from the context — never a generic impression, never invent a technique/exercise/id not present in the context.',
  ].join('\n');
}

function buildCommitSystemInstruction() {
  return (
    buildProgrammerSystemInstruction() +
    '\n24. context.priorReasoning.muscleNotes contains your own reasoning, already worked out in a prior step, about rules 18-23 for today\'s eligible muscles. Apply it faithfully — it is not a suggestion from someone else, it is your own prior conclusion. You may deviate from it only if the data in this context clearly contradicts it, and if you do, say why in programmingRationale.'
  );
}

function nextMonday(today) {
  let d = today;
  while (weekdayOfDate(d) !== 'monday') d = addDays(d, 1);
  return d;
}

function costUsd(usage, candidate) {
  if (!usage?.inputTokens || usage.outputTokens === undefined) return 0;
  return (usage.inputTokens / 1_000_000) * candidate.inputPer1M + (usage.outputTokens / 1_000_000) * candidate.outputPer1M;
}

async function runOnce(db, config, reasoningSystemInstruction, commitSystemInstruction, context, outputSchema, candidate) {
  const provider = new VelonaProvider(config);
  const started = Date.now();

  // --- Step 1: reason, no output schema constraint ---
  let reasoningResponse;
  try {
    reasoningResponse = await provider.generate({
      mode: 'generate_session',
      systemInstruction: reasoningSystemInstruction,
      context,
      outputSchema: REASONING_OUTPUT_SCHEMA, // small, task-shaped — not the big session-proposal schema
      requestId: randomUUID(),
    });
  } catch (err) {
    return { outcome: 'reasoning_provider_error', detail: err.message, latencyMs: Date.now() - started };
  }

  let reasoning;
  try {
    reasoning = JSON.parse(reasoningResponse.rawText);
  } catch {
    const truncated = isLikelyTruncatedOutput(reasoningResponse.finishReason, reasoningResponse.usage?.outputTokens, reasoningResponse.requestDiagnostics?.configuredMaxOutputTokens);
    return { outcome: truncated ? 'reasoning_truncated' : 'reasoning_invalid_json', detail: reasoningResponse.rawText?.slice(0, 300), latencyMs: Date.now() - started, reasoningUsage: reasoningResponse.usage };
  }

  // --- Step 2: commit, real schema, real validators ---
  const commitContext = { ...context, priorReasoning: reasoning };
  const requestId = randomUUID();
  let commitResponse;
  try {
    commitResponse = await provider.generate({ mode: 'generate_session', systemInstruction: commitSystemInstruction, context: commitContext, outputSchema, requestId });
  } catch (err) {
    return { outcome: 'commit_provider_error', detail: err.message, latencyMs: Date.now() - started, reasoningUsage: reasoningResponse.usage };
  }
  const latencyMs = Date.now() - started;
  const totalCostUsd = costUsd(reasoningResponse.usage, candidate) + costUsd(commitResponse.usage, candidate);

  let parsedJson;
  try {
    parsedJson = JSON.parse(commitResponse.rawText);
  } catch {
    const truncated = isLikelyTruncatedOutput(commitResponse.finishReason, commitResponse.usage?.outputTokens, commitResponse.requestDiagnostics?.configuredMaxOutputTokens);
    return { outcome: truncated ? 'truncated' : 'invalid_json', latencyMs, reasoningUsage: reasoningResponse.usage, commitUsage: commitResponse.usage, totalCostUsd, rawCommitText: commitResponse.rawText?.slice(0, 2000) };
  }

  // The raw, as-produced program — kept on every outcome from here on
  // (even a rejected one) so a disqualified attempt's actual proposed
  // workout can be inspected, not just the validator's error strings.
  const rawProgram = {
    sessionPurpose: parsedJson.sessionPurpose,
    exercises: parsedJson.exercises,
    programmingRationale: parsedJson.programmingRationale,
    goalAlignment: parsedJson.goalAlignment,
    recoveryConsiderations: parsedJson.recoveryConsiderations,
    warnings: parsedJson.warnings,
  };

  const structural = validateProposalSchema(parsedJson);
  if (!structural.ok || !structural.value) {
    return { outcome: 'schema_invalid', detail: structural.errors, latencyMs, reasoningUsage: reasoningResponse.usage, commitUsage: commitResponse.usage, totalCostUsd, rawProgram, reasoning };
  }

  const domain = validateProposalDomain(structural.value, context, db);
  if (!domain.ok || !domain.value) {
    return { outcome: 'domain_invalid', detail: domain.errors, latencyMs, reasoningUsage: reasoningResponse.usage, commitUsage: commitResponse.usage, totalCostUsd, rawProgram, reasoning };
  }

  const adequacy = validateProposalAdequacy(domain.value, context);
  if (!adequacy.ok) {
    return { outcome: 'adequacy_invalid', detail: adequacy.errors, latencyMs, reasoningUsage: reasoningResponse.usage, commitUsage: commitResponse.usage, totalCostUsd, rawProgram, reasoning };
  }

  // How many judgment-call rules (18-23) actually got a citable mention
  // in the final rationale — a rough, log-only signal of whether the
  // reasoning step's conclusions actually made it into the final output,
  // never used as a pass/fail gate.
  const rationaleText = JSON.stringify(domain.value.programmingRationale ?? []);
  const reasoningNoteCount = Object.keys(reasoning.muscleNotes ?? {}).length;

  return {
    outcome: 'success',
    latencyMs,
    reasoningUsage: reasoningResponse.usage,
    commitUsage: commitResponse.usage,
    totalCostUsd,
    exerciseCount: domain.value.exercises.length,
    reasoningNoteCount,
    rationaleLength: rationaleText.length,
    rawProgram,
    reasoning,
  };
}

async function runWithConcurrency(tasks, limit) {
  const results = [];
  let cursor = 0;
  async function worker() {
    while (cursor < tasks.length) {
      const i = cursor++;
      results[i] = await tasks[i]();
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker));
  return results;
}

async function main() {
  const db = openDb(DB_PATH);
  const today = todayForUser(db);
  const targetDate = nextMonday(today);
  console.log(`[modelEvalTwoStep] today=${today}, targetDate (next Monday)=${targetDate}`);

  const context = buildProgrammerContext(db, { targetDate });
  const reasoningSystemInstruction = buildReasoningSystemInstruction();
  const commitSystemInstruction = buildCommitSystemInstruction();
  const outputSchema = getProgrammerOutputSchema();
  const baseConfig = loadVelonaConfig();
  console.log(`[modelEvalTwoStep] real context built (${JSON.stringify(context).length} chars). reps per model=${REPS_PER_MODEL}, concurrency=${CONCURRENCY}\n`);

  const summary = [];
  const allResults = [];

  for (const candidate of CANDIDATES) {
    const config = { ...baseConfig, model: candidate.model };
    const tasks = Array.from({ length: REPS_PER_MODEL }, () => () => runOnce(db, config, reasoningSystemInstruction, commitSystemInstruction, context, outputSchema, candidate));
    console.log(`[modelEvalTwoStep] running ${candidate.label} (${candidate.model}) x${REPS_PER_MODEL}...`);
    const results = await runWithConcurrency(tasks, CONCURRENCY);
    results.forEach((r, i) => allResults.push({ model: candidate.model, label: candidate.label, rep: i, ...r }));

    const outcomeCounts = {};
    let totalLatency = 0;
    let totalCostUsd = 0;
    let totalReasoningNotes = 0;
    let successCount = 0;

    for (const r of results) {
      outcomeCounts[r.outcome] = (outcomeCounts[r.outcome] ?? 0) + 1;
      totalLatency += r.latencyMs ?? 0;
      totalCostUsd += r.totalCostUsd ?? 0;
      if (r.outcome === 'success') {
        totalReasoningNotes += r.reasoningNoteCount ?? 0;
        successCount++;
      }
    }

    const successRate = (successCount / REPS_PER_MODEL) * 100;
    const avgLatencyS = (totalLatency / REPS_PER_MODEL / 1000).toFixed(1);
    const avgCostUsd = (totalCostUsd / REPS_PER_MODEL).toFixed(6);
    const avgReasoningNotes = successCount ? (totalReasoningNotes / successCount).toFixed(1) : 'n/a';

    console.log(`  outcomes: ${JSON.stringify(outcomeCounts)}`);
    console.log(`  successRate=${successRate.toFixed(0)}%  avgLatency=${avgLatencyS}s  avgTotalCostUsd(2 calls)=$${avgCostUsd}  avgReasoningNotesUsed=${avgReasoningNotes}`);
    const sampleFailure = results.find((r) => r.outcome !== 'success' && r.detail);
    if (sampleFailure) console.log(`  sample failure (${sampleFailure.outcome}): ${JSON.stringify(sampleFailure.detail).slice(0, 300)}... (full detail + actual program in ${FULL_RESULTS_PATH})`);
    console.log('');

    summary.push({ model: candidate.model, label: candidate.label, successRate, avgLatencyS: Number(avgLatencyS), avgCostUsd, avgReasoningNotes });
  }

  console.log('==== SUMMARY (two-step / Option B — sorted by success rate) ====');
  summary
    .sort((a, b) => b.successRate - a.successRate)
    .forEach((s) => console.log(`${s.successRate.toFixed(0)}%  ${s.avgLatencyS}s  $${s.avgCostUsd}  avgReasoningNotesUsed=${s.avgReasoningNotes}  ${s.label} (${s.model})`));

  writeFileSync(FULL_RESULTS_PATH, JSON.stringify(allResults, null, 2));
  console.log(`\n[modelEvalTwoStep] full per-attempt results (including every disqualified attempt's actual proposed program) written to ${FULL_RESULTS_PATH}`);

  db.close();
}

main().catch((err) => {
  console.error('[modelEvalTwoStep] fatal error:', err);
  process.exit(1);
});

// Ad-hoc model A/B eval — NOT part of the app, never committed to the
// deployed dist build's own routes. Reuses the real, already-compiled
// production code (context builder, system instruction, output schema,
// validators, VelonaProvider) so results reflect exactly what the real
// app would accept — but calls the provider directly, bypassing
// AIProgrammerService's persistence and duplicate-pending-proposal
// guard entirely. Never writes to the database: openDb is used
// read-only (buildProgrammerContext only reads), and no repo write
// method is ever called.
//
// Usage: node scripts/modelEval.mjs
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
import { repairProposal } from '../dist/ai-programmer/validation/programmerProposalRepair.js';
import { VelonaProvider, isLikelyTruncatedOutput } from '../dist/ai-programmer/provider/velonaProvider.js';
import { loadVelonaConfig } from '../dist/ai-programmer/provider/config.js';
import { todayForUser } from '../dist/lib/userTimezone.js';
import { weekdayOfDate } from '../dist/engine/workoutBuilder.js';
import { addDays } from '../dist/engine/dateMath.js';
import { randomUUID } from 'node:crypto';

const DB_PATH = process.env.DB_PATH || '/home/ubuntu/workout-logger/data/workout-logger.sqlite';
const REPS_PER_MODEL = Number(process.env.EVAL_REPS || 10);
const CONCURRENCY = Number(process.env.EVAL_CONCURRENCY || 6);

// USD per 1M tokens — from Velona's own live /models catalog, fetched
// 2026-09-18. Used only to report comparative cost in this script's own
// output; never sent to the provider or used by the real app.
const CANDIDATES = [
  { model: 'openai/gpt-5.6-luna-pro', label: 'OpenAI GPT-5.6 Luna Pro', inputPer1M: 0.2, outputPer1M: 1.2 },
  { model: 'mistralai/mistral-small-2603', label: 'Mistral Small 4', inputPer1M: 0.15, outputPer1M: 0.6 },
];

function nextMonday(today) {
  let d = today;
  while (weekdayOfDate(d) !== 'monday') d = addDays(d, 1);
  return d;
}

async function runOnce(db, config, systemInstruction, context, outputSchema) {
  const requestId = randomUUID();
  const provider = new VelonaProvider(config);
  const started = Date.now();
  let response;
  try {
    response = await provider.generate({ mode: 'generate_session', systemInstruction, context, outputSchema, requestId });
  } catch (err) {
    return { outcome: 'provider_error', detail: err.message, latencyMs: Date.now() - started };
  }
  const latencyMs = Date.now() - started;
  const usage = response.usage;
  console.log(`    [tokens] requestId=${requestId} promptTokens=${usage?.inputTokens ?? 'n/a'} completionTokens=${usage?.outputTokens ?? 'n/a'} totalTokens=${usage?.totalTokens ?? 'n/a'}`);

  let parsedJson;
  try {
    parsedJson = JSON.parse(response.rawText);
  } catch {
    const truncated = isLikelyTruncatedOutput(response.finishReason, usage?.outputTokens, response.requestDiagnostics?.configuredMaxOutputTokens);
    return { outcome: truncated ? 'truncated' : 'invalid_json', latencyMs, usage };
  }

  const structural = validateProposalSchema(parsedJson);
  if (!structural.ok || !structural.value) {
    return { outcome: 'schema_invalid', detail: structural.errors?.slice(0, 3), latencyMs, usage };
  }

  const repaired = repairProposal(structural.value, context);
  const domain = validateProposalDomain(repaired, context, db);
  if (!domain.ok || !domain.value) {
    const errors = domain.errors ?? [];
    const setsIssues = errors.filter((e) => /\.sets must equal/.test(e)).length;
    const repIssues = errors.filter((e) => /\.reps(Min|Max) must equal/.test(e)).length;
    const rirIssues = errors.filter((e) => /\.rir(Min|Max) must equal/.test(e)).length;
    return { outcome: 'domain_invalid', detail: errors.slice(0, 5), setsIssues, repIssues, rirIssues, latencyMs, usage };
  }

  const adequacy = validateProposalAdequacy(domain.value, context);
  if (!adequacy.ok) {
    return { outcome: 'adequacy_invalid', detail: adequacy.errors?.slice(0, 3), latencyMs, usage };
  }

  return { outcome: 'success', latencyMs, usage, exerciseCount: domain.value.exercises.length };
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
  console.log(`[modelEval] today=${today}, targetDate (next Monday)=${targetDate}`);

  const context = buildProgrammerContext(db, { targetDate });
  const systemInstruction = buildProgrammerSystemInstruction();
  const outputSchema = getProgrammerOutputSchema();
  const baseConfig = loadVelonaConfig();
  console.log(`[modelEval] real context built. reps per model=${REPS_PER_MODEL}, concurrency=${CONCURRENCY}\n`);

  const summary = [];

  for (const candidate of CANDIDATES) {
    const config = { ...baseConfig, model: candidate.model };
    const tasks = Array.from({ length: REPS_PER_MODEL }, () => () => runOnce(db, config, systemInstruction, context, outputSchema));
    console.log(`[modelEval] running ${candidate.label} (${candidate.model}) x${REPS_PER_MODEL}...`);
    const results = await runWithConcurrency(tasks, CONCURRENCY);

    const outcomeCounts = {};
    let totalLatency = 0;
    let totalCostUsd = 0;
    let costCount = 0;
    let totalSetsIssues = 0;
    let totalRepIssues = 0;
    let totalRirIssues = 0;
    const promptTokenSamples = [];
    const completionTokenSamples = [];

    for (const r of results) {
      outcomeCounts[r.outcome] = (outcomeCounts[r.outcome] ?? 0) + 1;
      totalLatency += r.latencyMs ?? 0;
      if (r.usage?.inputTokens !== undefined && r.usage?.outputTokens !== undefined) {
        totalCostUsd += (r.usage.inputTokens / 1_000_000) * candidate.inputPer1M + (r.usage.outputTokens / 1_000_000) * candidate.outputPer1M;
        costCount++;
        promptTokenSamples.push(r.usage.inputTokens);
        completionTokenSamples.push(r.usage.outputTokens);
      }
      totalSetsIssues += r.setsIssues ?? 0;
      totalRepIssues += r.repIssues ?? 0;
      totalRirIssues += r.rirIssues ?? 0;
    }

    const successRate = ((outcomeCounts.success ?? 0) / REPS_PER_MODEL) * 100;
    const avgLatencyS = (totalLatency / REPS_PER_MODEL / 1000).toFixed(1);
    const avgCostUsd = costCount > 0 ? (totalCostUsd / costCount).toFixed(6) : 'n/a';
    const avg = (arr) => (arr.length ? Math.round(arr.reduce((a, b) => a + b, 0) / arr.length) : 'n/a');
    const promptTokensAvg = avg(promptTokenSamples);
    const promptTokensRange = promptTokenSamples.length ? `${Math.min(...promptTokenSamples)}-${Math.max(...promptTokenSamples)}` : 'n/a';
    const completionTokensAvg = avg(completionTokenSamples);
    const completionTokensRange = completionTokenSamples.length ? `${Math.min(...completionTokenSamples)}-${Math.max(...completionTokenSamples)}` : 'n/a';

    console.log(`  outcomes: ${JSON.stringify(outcomeCounts)}`);
    console.log(`  successRate=${successRate.toFixed(0)}%  avgLatency=${avgLatencyS}s  avgCostUsd=$${avgCostUsd}`);
    console.log(`  promptTokens: avg=${promptTokensAvg} range=${promptTokensRange} (n=${promptTokenSamples.length})`);
    console.log(`  completionTokens: avg=${completionTokensAvg} range=${completionTokensRange} (n=${completionTokenSamples.length})`);
    console.log(`  domain-invalid breakdown: setsIssues=${totalSetsIssues} repIssues=${totalRepIssues} rirIssues=${totalRirIssues}`);
    const sampleFailure = results.find((r) => r.outcome !== 'success' && r.detail);
    if (sampleFailure) console.log(`  sample failure (${sampleFailure.outcome}): ${JSON.stringify(sampleFailure.detail).slice(0, 300)}`);
    console.log('');

    summary.push({
      model: candidate.model,
      label: candidate.label,
      successRate,
      avgLatencyS: Number(avgLatencyS),
      avgCostUsd,
      outcomeCounts,
      promptTokensAvg,
      promptTokensRange,
      completionTokensAvg,
      completionTokensRange,
    });
  }

  console.log('==== SUMMARY (sorted by success rate) ====');
  summary
    .sort((a, b) => b.successRate - a.successRate)
    .forEach((s) =>
      console.log(
        `${s.successRate.toFixed(0)}%  ${s.avgLatencyS}s  $${s.avgCostUsd}  promptTokens(avg/range)=${s.promptTokensAvg}/${s.promptTokensRange}  completionTokens(avg/range)=${s.completionTokensAvg}/${s.completionTokensRange}  ${s.label} (${s.model})`
      )
    );

  db.close();
}

main().catch((err) => {
  console.error('[modelEval] fatal error:', err);
  process.exit(1);
});

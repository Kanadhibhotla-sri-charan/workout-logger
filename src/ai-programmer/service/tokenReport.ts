// Real Dry-Run Token Report spec: a no-provider-call inspection mode
// that builds the EXACT current Generate/Reconcile request payload from
// real application state — the same context builders
// (buildProgrammerContext/buildReconciliationContext), the same fixed
// system instructions, the same output schemas, and the same shared
// provider request-body builder (buildVelonaRequestBody) production
// actually uses — never a second, hand-approximated payload. Nothing in
// this module ever calls `provider.generate()` or `fetch`; it only
// measures the request that WOULD be sent.

import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { buildProgrammerContext } from '../context/programmerContextBuilder.js';
import { buildReconciliationContext } from '../context/reconciliationContextBuilder.js';
import { getProgrammerOutputSchema } from '../contracts/programmerOutputSchema.js';
import { getWeekReconciliationOutputSchema } from '../contracts/weekReconciliationOutputSchema.js';
import { buildProgrammerSystemInstruction, buildWeekReconciliationSystemInstruction } from './aiProgrammerService.js';
import { buildVelonaRequestBody } from '../provider/velonaProvider.js';
import { loadVelonaConfig } from '../provider/config.js';
import type { AIProgrammerMode, AIProgrammerProviderRequest } from '../contracts/providerTypes.js';
import { estimateTokensFromChars } from './tokenDiagnostics.js';
import { programmingWeekStart } from '../../engine/workoutBuilder.js';

/** §6's recommended initial planning values — used only when they fit
 * under the currently configured `max_tokens` (a planning value that
 * exceeds the provider's own configured ceiling could never actually be
 * produced, so it would not be a "defensible estimate" — spec §6). */
const RECOMMENDED_TYPICAL_OUTPUT_TOKENS: Record<AIProgrammerMode, number> = {
  generate_session: 2000,
  reconcile_week: 3000,
};

export interface TokenReportCostInputs {
  inputPricePerMillionTokens?: number;
  outputPricePerMillionTokens?: number;
}

export interface TokenReportInput {
  mode: AIProgrammerMode;
  targetDate: string;
  /** reconcile_week only — plain data forwarded into the context exactly
   * as the real /reconcile-week route would; never used as instructions
   * here either. */
  reason?: string;
  swapUnavailableReason?: string;
  costInputs?: TokenReportCostInputs;
}

export interface TokenReport {
  generatedAt: string;
  mode: AIProgrammerMode;
  requestId: string;
  targetDate: string;
  /** reconcile_week only — the Monday-anchored week this target date
   * falls in; null for generate_session (§4: "week start, if
   * applicable"). */
  weekStart: string | null;
  model: string;
  baseUrl: string;
  maxOutputTokens: number;
  /** §5: "model_tokenizer" only if a tokenizer for the configured model
   * is already installed and used — none is in this repo, so this is
   * always the documented character-based heuristic. Never claimed
   * exact, never provider-billed usage (no provider call is ever made
   * in this mode). */
  tokenCountMethod: 'chars_div_4_estimate';
  measurements: {
    systemInstructionChars: number;
    userTurnContentChars: number;
    /** systemInstructionChars + userTurnContentChars — the actual
     * model-facing text (§5). */
    modelInputChars: number;
    estimatedInputTokens: number;
    contextJsonChars: number;
    contextJsonBytesUtf8: number;
    outputSchemaJsonChars: number;
    outputSchemaJsonBytesUtf8: number;
    /** JSON.stringify(body).length — the full wire envelope, reported
     * separately from modelInputChars since envelope/config bytes
     * (model name, temperature, max_tokens, role/turns wrapper keys)
     * are not necessarily counted as model input tokens (§4). */
    wireBodyChars: number;
    wireBodyBytesUtf8: number;
  };
  output: {
    configuredMaxOutputTokens: number;
    /** A documented planning value, or null when none is defensible for
     * the current config (§6) — never presented as actual usage. */
    estimatedTypicalOutputTokens: number | null;
    estimatedOutputTokens: number;
    estimatedTotalTokens: number;
    note: string;
  };
  costProjection: {
    inputPricePerMillionTokens: number | null;
    outputPricePerMillionTokens: number | null;
    estimatedInputCost: number | null;
    estimatedOutputCost: number | null;
    estimatedTotalCost: number | null;
    /** §9: every cost figure here is a projection from estimated token
     * counts and caller-supplied prices — never an actual billed amount
     * (no provider call is ever made in this mode). */
    label: 'projected_cost';
  };
}

function byteLengthUtf8(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

/** Builds one dry-run token report — reads the real database state via
 * the exact production context builders, constructs the exact provider
 * request the real service would send (mode/systemInstruction/context/
 * outputSchema/requestId), serializes it via the exact shared
 * `buildVelonaRequestBody`, and reports its measured sizes. Throws the
 * same typed `AIProgrammerError`s (e.g. `AITargetNotEditableError`,
 * `AIContextIncompleteError`) the real context builders already throw
 * for an invalid/locked/past target date — this dry run is a read-only
 * measurement of the REAL request, so it is not exempt from the same
 * preconditions that request would have to satisfy. */
export function buildTokenReport(db: Database.Database, input: TokenReportInput): TokenReport {
  const config = loadVelonaConfig();
  const requestId = randomUUID();

  let systemInstruction: string;
  let context: unknown;
  let outputSchema: unknown;
  let weekStart: string | null = null;

  if (input.mode === 'generate_session') {
    context = buildProgrammerContext(db, { targetDate: input.targetDate });
    systemInstruction = buildProgrammerSystemInstruction();
    outputSchema = getProgrammerOutputSchema();
  } else {
    context = buildReconciliationContext(db, {
      targetDate: input.targetDate,
      requestedActivity: 'gym',
      reason: input.reason,
      swapUnavailableReason: input.swapUnavailableReason,
    });
    systemInstruction = buildWeekReconciliationSystemInstruction();
    outputSchema = getWeekReconciliationOutputSchema();
    weekStart = programmingWeekStart(input.targetDate);
  }

  // The exact provider request production would build — passed through
  // the exact shared serializer (buildVelonaRequestBody), never a
  // second, hand-approximated payload (§1/§3).
  const providerRequest: AIProgrammerProviderRequest = { mode: input.mode, systemInstruction, context, outputSchema, requestId };
  const { body, userTurnContent, outputSchemaJson } = buildVelonaRequestBody(providerRequest, config);

  const contextJson = JSON.stringify(context);
  const wireBodyJson = JSON.stringify(body);
  const modelInputChars = systemInstruction.length + userTurnContent.length;
  const estimatedInputTokens = estimateTokensFromChars(modelInputChars);

  const recommended = RECOMMENDED_TYPICAL_OUTPUT_TOKENS[input.mode];
  const estimatedTypicalOutputTokens = recommended <= config.maxTokens ? recommended : null;
  const estimatedOutputTokens = estimatedTypicalOutputTokens ?? 0;
  const estimatedTotalTokens = estimatedInputTokens + estimatedOutputTokens;
  const outputNote =
    estimatedTypicalOutputTokens !== null
      ? `Planning value for ${input.mode} (fits under the configured max_tokens of ${config.maxTokens}). Actual completion length is only known after a live request.`
      : `The recommended planning value (${recommended}) exceeds the configured max_tokens of ${config.maxTokens} — no defensible typical-output estimate is reported. Actual completion usage requires a live request.`;

  const inputPrice = input.costInputs?.inputPricePerMillionTokens ?? null;
  const outputPrice = input.costInputs?.outputPricePerMillionTokens ?? null;
  const estimatedInputCost = inputPrice !== null ? (estimatedInputTokens / 1_000_000) * inputPrice : null;
  const estimatedOutputCost = outputPrice !== null ? (estimatedOutputTokens / 1_000_000) * outputPrice : null;
  const estimatedTotalCost = estimatedInputCost !== null && estimatedOutputCost !== null ? estimatedInputCost + estimatedOutputCost : null;

  return {
    generatedAt: new Date().toISOString(),
    mode: input.mode,
    requestId,
    targetDate: input.targetDate,
    weekStart,
    model: config.model,
    baseUrl: config.baseUrl,
    maxOutputTokens: config.maxTokens,
    tokenCountMethod: 'chars_div_4_estimate',
    measurements: {
      systemInstructionChars: systemInstruction.length,
      userTurnContentChars: userTurnContent.length,
      modelInputChars,
      estimatedInputTokens,
      contextJsonChars: contextJson.length,
      contextJsonBytesUtf8: byteLengthUtf8(contextJson),
      outputSchemaJsonChars: outputSchemaJson.length,
      outputSchemaJsonBytesUtf8: byteLengthUtf8(outputSchemaJson),
      wireBodyChars: wireBodyJson.length,
      wireBodyBytesUtf8: byteLengthUtf8(wireBodyJson),
    },
    output: {
      configuredMaxOutputTokens: config.maxTokens,
      estimatedTypicalOutputTokens,
      estimatedOutputTokens,
      estimatedTotalTokens,
      note: outputNote,
    },
    costProjection: {
      inputPricePerMillionTokens: inputPrice,
      outputPricePerMillionTokens: outputPrice,
      estimatedInputCost,
      estimatedOutputCost,
      estimatedTotalCost,
      label: 'projected_cost',
    },
  };
}

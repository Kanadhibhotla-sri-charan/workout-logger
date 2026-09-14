// Real Dry-Run Token Report spec (initial) and
// docs/DEV_INSTRUCTIONS_TOKEN_MEASUREMENT_NEXT_ITERATION.md (this
// iteration): a no-provider-call inspection mode that builds the EXACT
// current Generate/Reconcile request payload from real application
// state — the same context builders (buildProgrammerContext/
// buildReconciliationContext), the same fixed system instructions, the
// same output schemas, and the same shared provider request-body
// builder (buildVelonaRequestBody) production actually uses — never a
// second, hand-approximated payload. Nothing in this module ever calls
// `provider.generate()` or `fetch`; it only measures the request that
// WOULD be sent.

import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { buildProgrammerContext } from '../context/programmerContextBuilder.js';
import { buildReconciliationContext } from '../context/reconciliationContextBuilder.js';
import type { AIProgrammerContext, AIProgrammerTargetContext } from '../context/programmerContextTypes.js';
import type { AIReconciliationContext } from '../context/reconciliationContextTypes.js';
import { getProgrammerOutputSchema } from '../contracts/programmerOutputSchema.js';
import { getWeekReconciliationOutputSchema } from '../contracts/weekReconciliationOutputSchema.js';
import { buildProgrammerSystemInstruction, buildWeekReconciliationSystemInstruction } from './aiProgrammerService.js';
import { buildVelonaRequestBody } from '../provider/velonaProvider.js';
import { loadVelonaConfig } from '../provider/config.js';
import type { AIProgrammerMode, AIProgrammerProviderRequest } from '../contracts/providerTypes.js';
import { estimateTokensFromChars } from './tokenDiagnostics.js';
import { programmingWeekStart } from '../../engine/workoutBuilder.js';
import { UsersRepo } from '../../repositories/usersRepo.js';
import { TrainingProfileRepo } from '../../repositories/trainingProfileRepo.js';
import { WeekActivityOverridesRepo } from '../../repositories/weekActivityOverridesRepo.js';

/** §6's recommended initial planning values — used only when they fit
 * under the currently configured `max_tokens` (a planning value that
 * exceeds the provider's own configured ceiling could never actually be
 * produced, so it would not be a "defensible estimate"). */
const RECOMMENDED_TYPICAL_OUTPUT_TOKENS: Record<AIProgrammerMode, number> = {
  generate_session: 2000,
  reconcile_week: 3000,
};

/** One model's optional per-million-token prices. Absent fields (not
 * `0`) mean "no price configured for this side" — costs involving them
 * are reported as `null`, never guessed (Token Measurement spec §5). */
export interface TokenReportPricingModelEntry {
  inputUsdPerMillionTokens?: number;
  outputUsdPerMillionTokens?: number;
}

/** A loaded pricing source — e.g. the parsed contents of a
 * `--pricing-file` (CLI) or an ad-hoc single-model map built from HTTP
 * query params. `source` is purely descriptive (a file path or a label
 * like `"query-params"`) and is echoed back in the report so a reader
 * knows where the prices came from; it is never a secret. */
export interface TokenReportPricing {
  source: string;
  models: Record<string, TokenReportPricingModelEntry>;
}

export interface TokenReportInput {
  mode: AIProgrammerMode;
  targetDate: string;
  /** reconcile_week only — plain data forwarded into the context exactly
   * as the real /reconcile-week route would; never used as instructions
   * here either. */
  reason?: string;
  swapUnavailableReason?: string;
  /** Optional — omitted entirely means "no pricing supplied", which
   * must report `null` costs, never a guessed price (spec §5). */
  pricing?: TokenReportPricing;
}

/** Exact serialized measurements. `modelInput*` is the actual
 * model-facing text (systemInstruction + userTurnContent — outputSchema
 * and context are already embedded inside userTurnContent, never
 * counted a second time). `wireBody*` is the complete serialized HTTP
 * JSON body — a strict superset of modelInput* that also includes
 * envelope/config bytes (model name, temperature, max_tokens, role/
 * turns wrapper keys) that are not necessarily counted as model input
 * tokens. Wire-body bytes are NOT a token count. */
export interface TokenReportMeasurements {
  systemInstructionChars: number;
  systemInstructionUtf8Bytes: number;
  userTurnContentChars: number;
  userTurnContentUtf8Bytes: number;
  contextJsonChars: number;
  contextJsonUtf8Bytes: number;
  outputSchemaJsonChars: number;
  outputSchemaJsonUtf8Bytes: number;
  modelInputChars: number;
  modelInputUtf8Bytes: number;
  wireBodyChars: number;
  wireBodyUtf8Bytes: number;
}

/** Token Measurement spec §1: an unavailable typical-output estimate
 * (the recommended planning value exceeds the configured max_tokens) is
 * represented as `null` — never `0`, which would misread as "the model
 * is expected to produce nothing." `estimatedTotalTokens` is likewise
 * `null` whenever a typical total cannot be calculated, rather than
 * silently degrading to just the input-token count. */
export interface TokenEstimate {
  /** §5: "model_tokenizer" only if a tokenizer for the configured model
   * is already installed and used — none is in this repo, so this is
   * always the documented character-based heuristic. Never claimed
   * exact, never provider-billed usage (no provider call is ever made
   * in this mode). */
  tokenEstimateMethod: 'chars_div_4_estimate';
  estimatedInputTokens: number;
  /** A documented planning value, or `null` when none is defensible for
   * the current config — never presented as actual usage. */
  estimatedTypicalOutputTokens: number | null;
  /** The provider's own configured output-token ceiling — a hard limit,
   * never actual or typical usage. */
  configuredMaxOutputTokens: number;
  /** `estimatedInputTokens + estimatedTypicalOutputTokens`, or `null`
   * when `estimatedTypicalOutputTokens` is `null`. */
  estimatedTotalTokens: number | null;
  note: string;
}

/** A compact, real (never fabricated) summary of context size drivers —
 * enough to explain why two reports for different dates/state differ,
 * without dumping the full context (which may be large and is never
 * logged in full by this module). A field is `null` when the concept
 * genuinely does not apply to this mode's context shape, never a
 * fabricated placeholder. */
export interface TokenReportContextSummary {
  /** Count of distinct calendar dates referenced across every target's
   * bounded exercise history (both modes' contexts carry the identical
   * `AIProgrammerTargetContext[]` shape). */
  historySessionCount: number;
  activeGoalCount: number;
  /** Number of days the context's weekly program/routine view covers
   * (both modes normally cover a full 7-day week). */
  weeklyProgramDayCount: number;
  /** generate_session: 1 if the single target date is locked, else 0.
   * reconcile_week: the real count of locked dates across the week. */
  lockedDayCount: number;
  /** reconcile_week only — count of days in the existing program with a
   * real, actionable workout_sessions row. `null` for generate_session,
   * whose context does not enumerate other days' real sessions. */
  plannedSessionCount: number | null;
  /** Real count of week_activity_overrides rows for the context's week
   * (the same TrainingProfileRepo/WeekActivityOverridesRepo lookup the
   * context builders themselves perform internally to resolve effective
   * activity — never a second, re-derived notion of "override"). */
  overrideCount: number;
}

export interface TokenReportCostProjection {
  model: string;
  /** Purely descriptive — a file path or a label like "query-params";
   * `null` when no pricing was supplied at all. */
  pricingSource: string | null;
  inputUsdPerMillionTokens: number | null;
  outputUsdPerMillionTokens: number | null;
  /** Shared by both the typical and maximum projections below (the
   * input side does not depend on assumed output length). `null` only
   * when `inputUsdPerMillionTokens` is unavailable. */
  inputCost: number | null;
  /** `null` whenever `estimatedTypicalOutputTokens` or
   * `outputUsdPerMillionTokens` is unavailable — never backfilled from
   * the maximum projection. */
  typicalOutputCost: number | null;
  typicalTotalCost: number | null;
  /** Always computable from `configuredMaxOutputTokens` alone (once
   * pricing exists) — independent of whether a typical estimate is
   * defensible. Never confused with an "expected" cost: this is a
   * worst-case ceiling, not a prediction. */
  maximumOutputCost: number | null;
  maximumTotalCost: number | null;
  /** Every cost figure here is a projection from estimated token counts
   * and caller-supplied prices — never an actual billed amount (no
   * provider call is ever made in this mode). */
  label: 'projected_cost';
}

export interface TokenReport {
  generatedAt: string;
  mode: AIProgrammerMode;
  requestId: string;
  targetDate: string;
  /** reconcile_week only — the Monday-anchored week this target date
   * falls in; null for generate_session (not applicable). */
  weekStart: string | null;
  model: string;
  baseUrl: string;
  measurements: TokenReportMeasurements;
  tokenEstimate: TokenEstimate;
  contextSummary: TokenReportContextSummary;
  costProjection: TokenReportCostProjection;
}

function byteLengthUtf8(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

/** Distinct calendar dates referenced across every target's bounded
 * exercise history — real data already present in the built context,
 * never a second history query. Shared by both modes since
 * `AIReconciliationContext.targets` reuses the identical
 * `AIProgrammerTargetContext[]` shape. */
function countHistorySessionDates(targets: readonly AIProgrammerTargetContext[]): number {
  const dates = new Set<string>();
  for (const target of targets) {
    for (const uses of Object.values(target.exerciseHistory)) {
      for (const use of uses) dates.add(use.date);
    }
  }
  return dates.size;
}

/** The real override count for the context's week — reuses the exact
 * same TrainingProfileRepo/WeekActivityOverridesRepo resolution the
 * context builders themselves perform internally (to compute effective
 * daily activity) but never expose as a count; this is a second, cheap
 * read of the same table, not a re-derivation of override semantics. */
function countWeekOverrides(db: Database.Database, weekStart: string): number {
  const user = new UsersRepo(db).getOrCreateDefault();
  const profile = new TrainingProfileRepo(db).get(user.id);
  if (!profile) return 0;
  return new WeekActivityOverridesRepo(db).get(profile.id, weekStart).size;
}

function buildGenerateContextSummary(db: Database.Database, context: AIProgrammerContext, weekStart: string): TokenReportContextSummary {
  return {
    historySessionCount: countHistorySessionDates(context.targets),
    activeGoalCount: context.activeGoals.length,
    weeklyProgramDayCount: context.routine.week.length,
    lockedDayCount: context.currentProgram.targetDateLocked ? 1 : 0,
    plannedSessionCount: null,
    overrideCount: countWeekOverrides(db, weekStart),
  };
}

function buildReconcileContextSummary(db: Database.Database, context: AIReconciliationContext): TokenReportContextSummary {
  return {
    historySessionCount: countHistorySessionDates(context.targets),
    activeGoalCount: context.activeGoals.length,
    weeklyProgramDayCount: context.existingProgram.length,
    lockedDayCount: context.lockedDates.length,
    plannedSessionCount: context.existingProgram.filter((day) => day.realSession !== null).length,
    overrideCount: countWeekOverrides(db, context.reportingBoundary.weekStart),
  };
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
  let context: AIProgrammerContext | AIReconciliationContext;
  let outputSchema: unknown;
  let weekStart: string;
  let contextSummary: TokenReportContextSummary;

  if (input.mode === 'generate_session') {
    const generateContext = buildProgrammerContext(db, { targetDate: input.targetDate });
    context = generateContext;
    systemInstruction = buildProgrammerSystemInstruction();
    outputSchema = getProgrammerOutputSchema();
    weekStart = generateContext.reportingBoundary.weekStart;
    contextSummary = buildGenerateContextSummary(db, generateContext, weekStart);
  } else {
    const reconcileContext = buildReconciliationContext(db, {
      targetDate: input.targetDate,
      requestedActivity: 'gym',
      reason: input.reason,
      swapUnavailableReason: input.swapUnavailableReason,
    });
    context = reconcileContext;
    systemInstruction = buildWeekReconciliationSystemInstruction();
    outputSchema = getWeekReconciliationOutputSchema();
    weekStart = programmingWeekStart(input.targetDate);
    contextSummary = buildReconcileContextSummary(db, reconcileContext);
  }

  // The exact provider request production would build — passed through
  // the exact shared serializer (buildVelonaRequestBody), never a
  // second, hand-approximated payload.
  const providerRequest: AIProgrammerProviderRequest = { mode: input.mode, systemInstruction, context, outputSchema, requestId };
  const { body, userTurnContent, outputSchemaJson } = buildVelonaRequestBody(providerRequest, config);
  // The real effective max_tokens THIS request would actually be sent
  // with — read back from the built body (never re-derived) so this
  // report can never disagree with what buildVelonaRequestBody itself
  // decided (see effectiveMaxTokensForMode's own doc comment).
  const effectiveMaxTokens = body.config.max_tokens;

  const contextJson = JSON.stringify(context);
  const wireBodyJson = JSON.stringify(body);
  const modelInputChars = systemInstruction.length + userTurnContent.length;
  const systemInstructionUtf8Bytes = byteLengthUtf8(systemInstruction);
  const userTurnContentUtf8Bytes = byteLengthUtf8(userTurnContent);
  const estimatedInputTokens = estimateTokensFromChars(modelInputChars);

  const recommended = RECOMMENDED_TYPICAL_OUTPUT_TOKENS[input.mode];
  const estimatedTypicalOutputTokens = recommended <= effectiveMaxTokens ? recommended : null;
  const estimatedTotalTokens = estimatedTypicalOutputTokens !== null ? estimatedInputTokens + estimatedTypicalOutputTokens : null;
  const outputNote =
    estimatedTypicalOutputTokens !== null
      ? `Planning value for ${input.mode} (fits under the configured max_tokens of ${effectiveMaxTokens}). Actual completion length is only known after a live request.`
      : `The recommended planning value (${recommended}) exceeds the configured max_tokens of ${effectiveMaxTokens} — no defensible typical-output estimate is reported. Actual completion usage requires a live request.`;

  const pricingEntry = input.pricing?.models[config.model];
  const inputPrice = pricingEntry?.inputUsdPerMillionTokens ?? null;
  const outputPrice = pricingEntry?.outputUsdPerMillionTokens ?? null;
  const pricingSource = input.pricing?.source ?? null;

  const inputCost = inputPrice !== null ? (estimatedInputTokens / 1_000_000) * inputPrice : null;
  const typicalOutputCost = outputPrice !== null && estimatedTypicalOutputTokens !== null ? (estimatedTypicalOutputTokens / 1_000_000) * outputPrice : null;
  const typicalTotalCost = inputCost !== null && typicalOutputCost !== null ? inputCost + typicalOutputCost : null;
  const maximumOutputCost = outputPrice !== null ? (effectiveMaxTokens / 1_000_000) * outputPrice : null;
  const maximumTotalCost = inputCost !== null && maximumOutputCost !== null ? inputCost + maximumOutputCost : null;

  return {
    generatedAt: new Date().toISOString(),
    mode: input.mode,
    requestId,
    targetDate: input.targetDate,
    weekStart: input.mode === 'reconcile_week' ? weekStart : null,
    model: config.model,
    baseUrl: config.baseUrl,
    measurements: {
      systemInstructionChars: systemInstruction.length,
      systemInstructionUtf8Bytes,
      userTurnContentChars: userTurnContent.length,
      userTurnContentUtf8Bytes,
      contextJsonChars: contextJson.length,
      contextJsonUtf8Bytes: byteLengthUtf8(contextJson),
      outputSchemaJsonChars: outputSchemaJson.length,
      outputSchemaJsonUtf8Bytes: byteLengthUtf8(outputSchemaJson),
      modelInputChars,
      modelInputUtf8Bytes: systemInstructionUtf8Bytes + userTurnContentUtf8Bytes,
      wireBodyChars: wireBodyJson.length,
      wireBodyUtf8Bytes: byteLengthUtf8(wireBodyJson),
    },
    tokenEstimate: {
      tokenEstimateMethod: 'chars_div_4_estimate',
      estimatedInputTokens,
      estimatedTypicalOutputTokens,
      configuredMaxOutputTokens: effectiveMaxTokens,
      estimatedTotalTokens,
      note: outputNote,
    },
    contextSummary,
    costProjection: {
      model: config.model,
      pricingSource,
      inputUsdPerMillionTokens: inputPrice,
      outputUsdPerMillionTokens: outputPrice,
      inputCost,
      typicalOutputCost,
      typicalTotalCost,
      maximumOutputCost,
      maximumTotalCost,
      label: 'projected_cost',
    },
  };
}

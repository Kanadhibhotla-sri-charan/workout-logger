// AI-Powered Weekly Reconciliation §12: token-budget diagnostics for
// BOTH modes (generate_session and reconcile_week) — required so model
// selection can be based on real request size, not guesswork. Never
// logs API keys, authorization headers, full user data, or full workout
// history — only aggregate character/token counts.
//
// Fix AI Weekly Reconciliation Review, Finding 2: the previous version
// summed three independently-stringified pieces (systemInstruction,
// context alone, outputSchema alone) that did not match what the
// provider actually serializes onto the wire — Velona's real user-turn
// content wraps `{request, context, outputSchema, instruction}` into
// ONE JSON string, so summing context and outputSchema separately both
// missed the wrapper overhead and, depending on the call site, could
// double count. This version measures the EXACT text a request would
// produce by reusing `buildVelonaUserTurnContent` (velonaProvider.ts) —
// the single function that also builds the real fetch body — rather
// than reconstructing an approximation of it here. `wirePayloadChars`
// and `configuredMaxOutputTokens` additionally require the provider's
// own configuration (model/temperature/max_tokens), which this
// provider-independent service layer does not hold; those two fields
// are populated only when the provider itself supplies them via
// `response.requestDiagnostics` (see providerTypes.ts), and are left
// undefined — never fabricated — otherwise.

import { buildVelonaUserTurnContent } from '../provider/velonaProvider.js';
import type { AIProgrammerMode, AIProgrammerProviderRequest, AIProgrammerProviderResponse } from '../contracts/providerTypes.js';

export interface TokenDiagnostics {
  mode: AIProgrammerMode;
  requestId: string;
  /** Length of the exact system-turn content. */
  systemInstructionChars: number;
  /** Length of the exact user-turn content (context + outputSchema +
   * request metadata + instruction, wrapped exactly as the provider
   * would serialize it — outputSchema is never counted separately, it
   * is already included here). */
  userTurnChars: number;
  /** Length of `JSON.stringify(body)` for the full wire request
   * (system + user turns, model, config, output format) — only known
   * when the serving provider supplies `requestDiagnostics`. */
  wirePayloadChars?: number;
  /** A documented, clearly-labeled APPROXIMATION only — never claimed
   * exact. No tokenizer for the actual selected model is bundled in
   * this repo (no such dependency exists in package.json), so this
   * uses the widely-cited ~4-characters-per-token heuristic, computed
   * from the exact system + user-turn text (`inputText` below), not
   * partial/mismatched components. */
  estimatedInputTokens: number;
  /** The provider's own configured output-token limit (e.g. Velona's
   * `config.max_tokens`) — a LIMIT, never actual usage. Only known when
   * the serving provider supplies `requestDiagnostics`. */
  configuredMaxOutputTokens?: number;
  /** Same ~4-chars-per-token heuristic, applied to the raw response
   * text — an approximation, not authoritative. */
  estimatedOutputTokens: number;
  /** The provider's own authoritative usage metadata, when its response
   * included one (Velona's `data.usage`) — never fabricated from the
   * heuristic above. Absent (not zero, not estimated) when the provider
   * did not report usage. */
  actualInputTokens?: number;
  actualOutputTokens?: number;
  actualTotalTokens?: number;
}

const APPROX_CHARS_PER_TOKEN = 4;

export function estimateTokensFromChars(chars: number): number {
  return Math.ceil(chars / APPROX_CHARS_PER_TOKEN);
}

/** Builds the diagnostics for one provider request. `request` is the
 * exact `AIProgrammerProviderRequest` passed to `provider.generate()` —
 * `userTurnChars`/`estimatedInputTokens` are derived from
 * `buildVelonaUserTurnContent(request)`, the identical pure function
 * `VelonaProvider` itself uses to build its real wire body, so these
 * figures are byte-exact whenever the serving provider actually is
 * Velona (the only provider this application ships), and a same-shape
 * estimate for any other provider (e.g. a test fake) — never a second,
 * independently-drifting reconstruction of that shape. `response` is
 * optional so diagnostics can still be computed when the provider call
 * itself failed (output/usage fields are then all absent/estimated from
 * nothing). */
export function buildTokenDiagnostics(
  mode: AIProgrammerMode,
  request: AIProgrammerProviderRequest,
  response?: Pick<AIProgrammerProviderResponse, 'rawText' | 'usage' | 'requestDiagnostics'>
): TokenDiagnostics {
  const userTurnContent = buildVelonaUserTurnContent(request);
  const exact = response?.requestDiagnostics;

  const systemInstructionChars = exact?.systemInstructionChars ?? request.systemInstruction.length;
  const userTurnChars = exact?.userTurnChars ?? userTurnContent.length;

  // The exact text this request would actually send — outputSchema is
  // already inside userTurnContent, never summed a second time.
  const inputText = [request.systemInstruction, userTurnContent].join('\n');

  return {
    mode,
    requestId: request.requestId,
    systemInstructionChars,
    userTurnChars,
    wirePayloadChars: exact?.wirePayloadChars,
    estimatedInputTokens: estimateTokensFromChars(inputText.length),
    configuredMaxOutputTokens: exact?.configuredMaxOutputTokens,
    estimatedOutputTokens: estimateTokensFromChars(response?.rawText.length ?? 0),
    actualInputTokens: response?.usage?.inputTokens,
    actualOutputTokens: response?.usage?.outputTokens,
    actualTotalTokens: response?.usage?.totalTokens,
  };
}

/** Deployment §12: never log API keys, authorization headers, full user
 * data, or full workout history — this is exactly what's safe to log
 * (aggregate counts only, no content). */
export function logTokenDiagnostics(diagnostics: TokenDiagnostics): void {
  console.log(`[ai-programmer] token diagnostics`, diagnostics);
}

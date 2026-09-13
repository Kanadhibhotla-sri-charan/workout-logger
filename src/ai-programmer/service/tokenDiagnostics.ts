// AI-Powered Weekly Reconciliation §12: token-budget diagnostics for
// BOTH modes (generate_session and reconcile_week) — required so model
// selection can be based on real request size, not guesswork. Never
// logs API keys, authorization headers, full user data, or full workout
// history — only aggregate character/token counts.

import type { AIProgrammerMode } from '../contracts/providerTypes.js';
import type { AIProgrammerProviderResponse } from '../contracts/providerTypes.js';

export interface TokenDiagnostics {
  mode: AIProgrammerMode;
  requestId: string;
  systemInstructionChars: number;
  userPayloadChars: number;
  totalSerializedInputChars: number;
  estimatedInputTokens: number;
  outputSchemaChars: number;
  estimatedOutputTokens: number;
  /** True when `estimatedOutputTokens` came from the provider's own
   * usage metadata (authoritative — spec §12: "if the provider returns
   * actual usage metadata, use it as authoritative"); false when it is
   * this module's own character-based approximation, clearly labeled as
   * such rather than claimed exact. */
  outputTokensAreExact: boolean;
}

/** A documented, clearly-labeled APPROXIMATION only — never claimed
 * exact (spec §12: "do not claim it is exact"). No tokenizer for the
 * actual selected model is bundled in this repo (no such dependency
 * exists in package.json), so this uses the widely-cited ~4
 * characters-per-token heuristic for English-language JSON/prose text,
 * exposed alongside the raw character count so a caller can judge for
 * itself rather than trust a single number. */
const APPROX_CHARS_PER_TOKEN = 4;

export function estimateTokensFromChars(chars: number): number {
  return Math.ceil(chars / APPROX_CHARS_PER_TOKEN);
}

/** Builds the diagnostics for one provider request. `userPayload` is
 * whatever was actually serialized into the request's user-turn content
 * (context + outputSchema + instruction, matching VelonaProvider's own
 * request body construction) — passed in already-stringified so this
 * module never needs its own opinion on the provider's exact wire
 * format. `response` is optional so diagnostics can be computed even
 * when the provider call itself failed (output fields are then all
 * zero/estimated-from-nothing, `outputTokensAreExact: false`). */
export function buildTokenDiagnostics(
  mode: AIProgrammerMode,
  requestId: string,
  systemInstruction: string,
  userPayloadJson: string,
  outputSchemaJson: string,
  response?: Pick<AIProgrammerProviderResponse, 'rawText' | 'usage'>
): TokenDiagnostics {
  const systemInstructionChars = systemInstruction.length;
  const userPayloadChars = userPayloadJson.length;
  const outputSchemaChars = outputSchemaJson.length;
  // outputSchema is embedded in the actual request payload sent to the
  // provider (part of the user turn, per VelonaProvider's own request
  // construction) — it counts toward input size, not output.
  const totalSerializedInputChars = systemInstructionChars + userPayloadChars + outputSchemaChars;

  const exactOutputTokens = response?.usage?.outputTokens;
  const exactInputTokens = response?.usage?.inputTokens;

  return {
    mode,
    requestId,
    systemInstructionChars,
    userPayloadChars,
    totalSerializedInputChars,
    estimatedInputTokens: exactInputTokens ?? estimateTokensFromChars(totalSerializedInputChars),
    outputSchemaChars,
    estimatedOutputTokens: exactOutputTokens ?? estimateTokensFromChars(response?.rawText.length ?? 0),
    outputTokensAreExact: exactOutputTokens !== undefined,
  };
}

/** Deployment §12: never log API keys, authorization headers, full user
 * data, or full workout history — this is exactly what's safe to log
 * (aggregate counts only, no content). */
export function logTokenDiagnostics(diagnostics: TokenDiagnostics): void {
  console.log(`[ai-programmer] token diagnostics`, diagnostics);
}

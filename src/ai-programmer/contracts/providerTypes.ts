// CLAUDE_TASK_AI_PROGRAMMER_FIRST_VERTICAL_SLICE.md §8: a
// provider-independent interface the application service depends on —
// never directly on Velona — so tests can mock it and a future provider
// can replace Velona without touching the service/validators.

// AI-Powered Weekly Reconciliation: a second, distinct request mode.
// The provider itself needs no special-casing per mode (spec §4.1) — it
// only ever sees systemInstruction/context/outputSchema/requestId, all
// mode-specific shaping happens above this interface, in the service/
// context-builder layer.
export type AIProgrammerMode = 'generate_session' | 'reconcile_week' | 'generate_week';

export interface AIProgrammerProviderRequest {
  mode: AIProgrammerMode;
  systemInstruction: string;
  context: unknown;
  outputSchema: unknown;
  requestId: string;
}

export interface AIProgrammerProviderResponse {
  provider: string;
  model: string;
  requestId: string;
  rawText: string;
  parsedJson?: unknown;
  /** The provider's own reported completion-stop reason (Velona's
   * `data.finish`, e.g. `"stop"` on a normal completion) — passed
   * through verbatim, never normalized/guessed, so callers that DO
   * recognize a given provider's vocabulary (see
   * `isLikelyTruncatedOutput` in velonaProvider.ts) can use it, and it
   * is always safe to log. Absent when the provider does not report
   * one. */
  finishReason?: string;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
  };
  /** Fix AI Weekly Reconciliation Review, Finding 2: exact wire-format
   * facts about the ACTUAL request this provider implementation just
   * sent — populated only by a provider that genuinely serializes a
   * request onto some wire format and therefore actually knows these
   * numbers exactly (see velonaProvider.ts's `buildVelonaRequestBody`,
   * the single function that builds both the real fetch body and these
   * figures, so they can never drift apart). Absent for a provider with
   * no such wire body (e.g. a test fake) — `tokenDiagnostics.ts` falls
   * back to its own same-shape reconstruction in that case, never to a
   * fabricated number. */
  requestDiagnostics?: {
    systemInstructionChars: number;
    userTurnChars: number;
    wirePayloadChars: number;
    configuredMaxOutputTokens: number;
  };
}

export interface AIProgrammerProvider {
  generate(request: AIProgrammerProviderRequest): Promise<AIProgrammerProviderResponse>;
}

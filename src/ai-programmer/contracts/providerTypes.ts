// CLAUDE_TASK_AI_PROGRAMMER_FIRST_VERTICAL_SLICE.md §8: a
// provider-independent interface the application service depends on —
// never directly on Velona — so tests can mock it and a future provider
// can replace Velona without touching the service/validators.

// AI-Powered Weekly Reconciliation: a second, distinct request mode.
// The provider itself needs no special-casing per mode (spec §4.1) — it
// only ever sees systemInstruction/context/outputSchema/requestId, all
// mode-specific shaping happens above this interface, in the service/
// context-builder layer.
export type AIProgrammerMode = 'generate_session' | 'reconcile_week';

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
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
  };
}

export interface AIProgrammerProvider {
  generate(request: AIProgrammerProviderRequest): Promise<AIProgrammerProviderResponse>;
}

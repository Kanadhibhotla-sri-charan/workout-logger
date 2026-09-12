// CLAUDE_TASK_AI_PROGRAMMER_FIRST_VERTICAL_SLICE.md §8: a
// provider-independent interface the application service depends on —
// never directly on Velona — so tests can mock it and a future provider
// can replace Velona without touching the service/validators.

export interface AIProgrammerProviderRequest {
  mode: 'generate_session';
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

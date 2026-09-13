// Token Measurement iteration §2/§3: a repository command that produces
// a dry-run token report without any provider/API call. Reuses exactly
// the same `buildTokenReport` the protected HTTP endpoint calls (see
// server/routes/aiProgrammer.ts) — no second, duplicated report
// implementation. Never requires a real Velona API key (only that
// VELONA_API_KEY/VELONA_MODEL be SET, per the existing configuration
// contract — the value is never used for any network call in this
// mode).
//
// Usage:
//   npm run ai:token-report -- --mode generate_session --target-date 2026-09-14
//   npm run ai:token-report -- --mode reconcile_week --target-date 2026-09-14 --json
//   npm run ai:token-report -- --mode reconcile_week --target-date 2026-09-14 \
//     --reason "gym slot moved" --pricing-file ./config/ai-model-prices.example.json

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import type Database from 'better-sqlite3';
import { openDb } from '../../db/client.js';
import { isValidCalendarDate } from '../../engine/dateMath.js';
import { AIProgrammerError } from '../errors.js';
import { buildTokenReport, type TokenReport, type TokenReportPricing } from '../service/tokenReport.js';
import type { AIProgrammerMode } from '../contracts/providerTypes.js';

const TOKEN_REPORT_MODES = ['generate_session', 'reconcile_week'] as const;

export class CliUsageError extends Error {}

interface ParsedArgs {
  mode?: string;
  targetDate?: string;
  reason?: string;
  swapUnavailableReason?: string;
  pricingFile?: string;
  json: boolean;
  help: boolean;
}

const USAGE = `Usage: npm run ai:token-report -- --mode <generate_session|reconcile_week> --target-date <YYYY-MM-DD> [options]

Options:
  --mode <mode>                     Required. "generate_session" or "reconcile_week".
  --target-date <YYYY-MM-DD>        Required. Real calendar date.
  --reason <text>                   Optional. reconcile_week only.
  --swap-unavailable-reason <text>  Optional. reconcile_week only.
  --pricing-file <path>             Optional. JSON file: {"models": {"<model>": {"inputUsdPerMillionTokens": n, "outputUsdPerMillionTokens": n}}}
  --json                            Print machine-readable JSON only (no human-readable text mixed in).
  --help                            Print this message.

Makes no provider/network call — measures the request that WOULD be sent. Does not require a real API key
(VELONA_API_KEY/VELONA_MODEL must be SET, but their value is never used for any network request here).`;

export function parseArgs(argv: string[]): ParsedArgs {
  const result: ParsedArgs = { json: false, help: false };
  const takeValue = (flag: string, i: number): string => {
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new CliUsageError(`${flag} requires a value`);
    }
    return value;
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    switch (arg) {
      case '--mode':
        result.mode = takeValue(arg, i);
        i++;
        break;
      case '--target-date':
        result.targetDate = takeValue(arg, i);
        i++;
        break;
      case '--reason':
        result.reason = takeValue(arg, i);
        i++;
        break;
      case '--swap-unavailable-reason':
        result.swapUnavailableReason = takeValue(arg, i);
        i++;
        break;
      case '--pricing-file':
        result.pricingFile = takeValue(arg, i);
        i++;
        break;
      case '--json':
        result.json = true;
        break;
      case '--help':
      case '-h':
        result.help = true;
        break;
      default:
        throw new CliUsageError(`Unknown argument: ${arg}`);
    }
  }
  return result;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Reads and validates a pricing file into the shape `buildTokenReport`
 * expects. Pricing is entirely optional and never guessed — an invalid
 * file is a hard error (so a typo never silently reports `null` costs
 * that look like "no pricing was requested" rather than "pricing was
 * requested but broken"). */
export function loadPricingFile(path: string): TokenReportPricing {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    throw new CliUsageError(`Could not read pricing file "${path}": ${err instanceof Error ? err.message : String(err)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new CliUsageError(`Pricing file "${path}" is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!isPlainObject(parsed) || !isPlainObject(parsed.models)) {
    throw new CliUsageError(`Pricing file "${path}" must be a JSON object of the form {"models": {"<model-name>": {"inputUsdPerMillionTokens": n, "outputUsdPerMillionTokens": n}}}`);
  }
  for (const [modelName, entry] of Object.entries(parsed.models)) {
    if (!isPlainObject(entry)) {
      throw new CliUsageError(`Pricing file "${path}": models["${modelName}"] must be an object`);
    }
    for (const field of ['inputUsdPerMillionTokens', 'outputUsdPerMillionTokens'] as const) {
      if (field in entry && typeof entry[field] !== 'number') {
        throw new CliUsageError(`Pricing file "${path}": models["${modelName}"].${field} must be a number when present`);
      }
    }
  }
  return { source: path, models: parsed.models as TokenReportPricing['models'] };
}

function formatUsd(value: number | null): string {
  return value === null ? 'unavailable (no pricing configured for this model)' : `$${value.toFixed(6)}`;
}

function formatCount(value: number | null): string {
  return value === null ? 'n/a for this mode' : String(value);
}

export function formatHumanReadable(report: TokenReport): string {
  const lines: string[] = [];
  lines.push('AI Token Report');
  lines.push('---------------');
  lines.push(`Mode: ${report.mode}`);
  lines.push(`Target date: ${report.targetDate}`);
  if (report.weekStart) lines.push(`Week start: ${report.weekStart}`);
  lines.push(`Model: ${report.model}`);
  lines.push(`Base URL: ${report.baseUrl}`);
  lines.push(`Request ID: ${report.requestId}`);
  lines.push(`Generated at: ${report.generatedAt}`);
  lines.push('');
  lines.push('Model input:');
  lines.push(`  System instruction: ${report.measurements.systemInstructionChars} chars (${report.measurements.systemInstructionUtf8Bytes} UTF-8 bytes)`);
  lines.push(`  User turn content: ${report.measurements.userTurnContentChars} chars (${report.measurements.userTurnContentUtf8Bytes} UTF-8 bytes)`);
  lines.push(`  Total model input: ${report.measurements.modelInputChars} chars (${report.measurements.modelInputUtf8Bytes} UTF-8 bytes)`);
  lines.push(`  Estimated input tokens: ${report.tokenEstimate.estimatedInputTokens} (method: ${report.tokenEstimate.tokenEstimateMethod})`);
  lines.push('');
  lines.push('Output:');
  lines.push(`  Typical estimated tokens: ${report.tokenEstimate.estimatedTypicalOutputTokens === null ? 'unavailable — ' + report.tokenEstimate.note : report.tokenEstimate.estimatedTypicalOutputTokens}`);
  lines.push(`  Configured max tokens: ${report.tokenEstimate.configuredMaxOutputTokens}`);
  lines.push(`  Estimated total tokens (typical): ${report.tokenEstimate.estimatedTotalTokens === null ? 'unavailable' : report.tokenEstimate.estimatedTotalTokens}`);
  lines.push('');
  lines.push('Wire body (full HTTP JSON — not a token count):');
  lines.push(`  Characters: ${report.measurements.wireBodyChars} (${report.measurements.wireBodyUtf8Bytes} UTF-8 bytes)`);
  lines.push('');
  lines.push('Context/schema:');
  lines.push(`  Context JSON: ${report.measurements.contextJsonChars} chars (${report.measurements.contextJsonUtf8Bytes} UTF-8 bytes)`);
  lines.push(`  Output schema JSON: ${report.measurements.outputSchemaJsonChars} chars (${report.measurements.outputSchemaJsonUtf8Bytes} UTF-8 bytes)`);
  lines.push('');
  lines.push('Context summary:');
  lines.push(`  History session dates referenced: ${report.contextSummary.historySessionCount}`);
  lines.push(`  Active goals: ${report.contextSummary.activeGoalCount}`);
  lines.push(`  Weekly program days: ${report.contextSummary.weeklyProgramDayCount}`);
  lines.push(`  Locked days: ${report.contextSummary.lockedDayCount}`);
  lines.push(`  Planned sessions: ${formatCount(report.contextSummary.plannedSessionCount)}`);
  lines.push(`  Activity overrides this week: ${report.contextSummary.overrideCount}`);
  lines.push('');
  lines.push(`Cost projection (${report.costProjection.label}; pricing source: ${report.costProjection.pricingSource ?? 'none supplied'}):`);
  lines.push(`  Input price: ${report.costProjection.inputUsdPerMillionTokens === null ? 'not configured' : `$${report.costProjection.inputUsdPerMillionTokens} / 1M tokens`}`);
  lines.push(`  Output price: ${report.costProjection.outputUsdPerMillionTokens === null ? 'not configured' : `$${report.costProjection.outputUsdPerMillionTokens} / 1M tokens`}`);
  lines.push(`  Typical: ${formatUsd(report.costProjection.typicalTotalCost)}`);
  lines.push(`  Maximum: ${formatUsd(report.costProjection.maximumTotalCost)} (a ceiling, not an expected cost)`);
  lines.push('');
  lines.push('No Velona/provider API call was made to produce this report.');
  return lines.join('\n');
}

export interface TokenReportCliIo {
  write: (text: string) => void;
  writeErr: (text: string) => void;
  /** Test seam: an already-open database to use instead of opening the
   * real default one. Never closed by this function when supplied — the
   * caller owns its lifecycle. */
  db?: Database.Database;
}

/** Runs the CLI end-to-end and returns a process exit code — never
 * throws. Pure of any hardcoded stdout/stderr/db so it can be exercised
 * directly in tests without spawning a subprocess. */
export async function runTokenReportCli(argv: string[], io: TokenReportCliIo): Promise<number> {
  let args: ParsedArgs;
  try {
    args = parseArgs(argv);
  } catch (err) {
    io.writeErr(`${err instanceof Error ? err.message : String(err)}\n\n${USAGE}\n`);
    return 1;
  }

  if (args.help) {
    io.write(`${USAGE}\n`);
    return 0;
  }

  if (!args.mode || !(TOKEN_REPORT_MODES as readonly string[]).includes(args.mode)) {
    io.writeErr(`--mode is required and must be one of: ${TOKEN_REPORT_MODES.join(', ')}\n\n${USAGE}\n`);
    return 1;
  }
  if (!args.targetDate || !isValidCalendarDate(args.targetDate)) {
    io.writeErr(`--target-date is required and must be a real calendar date in YYYY-MM-DD format\n\n${USAGE}\n`);
    return 1;
  }

  let pricing: TokenReportPricing | undefined;
  if (args.pricingFile) {
    try {
      pricing = loadPricingFile(args.pricingFile);
    } catch (err) {
      io.writeErr(`${err instanceof Error ? err.message : String(err)}\n`);
      return 1;
    }
  }

  const db = io.db ?? openDb();
  try {
    const report = buildTokenReport(db, {
      mode: args.mode as AIProgrammerMode,
      targetDate: args.targetDate,
      reason: args.reason,
      swapUnavailableReason: args.swapUnavailableReason,
      pricing,
    });

    if (args.json) {
      io.write(`${JSON.stringify(report, null, 2)}\n`);
    } else {
      io.write(`${formatHumanReadable(report)}\n`);
    }
    return 0;
  } catch (err) {
    if (err instanceof AIProgrammerError) {
      io.writeErr(`${err.code}: ${err.publicMessage}\n`);
    } else {
      io.writeErr(`${err instanceof Error ? err.message : String(err)}\n`);
    }
    return 1;
  } finally {
    if (!io.db) db.close();
  }
}

const isMainModule = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) {
  runTokenReportCli(process.argv.slice(2), {
    write: (text) => process.stdout.write(text),
    writeErr: (text) => process.stderr.write(text),
  }).then((code) => {
    process.exitCode = code;
  });
}

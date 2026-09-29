// The ONE post-provider pipeline for a generate_session proposal:
// schema -> [plan conformance] -> repair -> domain -> completion ->
// adequacy. Used by AIProgrammerService.generateSession and by offline
// fixture replays, so both exercise the exact same code path. Plan
// conformance runs only when a SessionPlan is supplied (the planned-
// generation feature flag); every other stage is identical either way.

import type Database from 'better-sqlite3';
import type { AIWorkoutSessionProposal } from '../contracts/programmerTypes.js';
import type { AIProgrammerContext } from '../context/programmerContextTypes.js';
import { validateProposalSchema } from '../validation/programmerOutputValidator.js';
import { repairProposal } from '../validation/programmerProposalRepair.js';
import { validateProposalDomain } from '../validation/programmerDomainValidator.js';
import { completeProposalAdequacy } from '../validation/programmerAdequacyCompletion.js';
import { validateProposalAdequacy } from '../validation/programmerAdequacyValidator.js';
import { conformProposalToPlan } from '../planning/planConformance.js';
import type { SessionPlan } from '../planning/sessionPlanner.js';

export interface PipelineTrace {
  conformanceNotes: string[];
  removedTargetIds: string[];
  repairNotes: string[];
  completionNotes: string[];
}

export type PipelineOutcome =
  | { ok: true; proposal: AIWorkoutSessionProposal; trace: PipelineTrace }
  | { ok: false; stage: 'schema' | 'domain' | 'adequacy'; errors: string[]; trace: PipelineTrace };

export function runProposalPipeline(parsedJson: unknown, context: AIProgrammerContext, db: Database.Database, plan: SessionPlan | null): PipelineOutcome {
  const trace: PipelineTrace = { conformanceNotes: [], removedTargetIds: [], repairNotes: [], completionNotes: [] };

  const structural = validateProposalSchema(parsedJson);
  if (!structural.ok || !structural.value) return { ok: false, stage: 'schema', errors: structural.errors, trace };

  let proposal = structural.value;
  if (plan) {
    const conformed = conformProposalToPlan(proposal, plan, context);
    proposal = conformed.proposal;
    trace.conformanceNotes = conformed.notes;
    trace.removedTargetIds = conformed.removedTargetIds;
  }

  // Repair pass (2026-09-18): fixes the mechanically-correctable issues
  // (role, authored-prescription drift, over-cap counts) in place before
  // domain validation — see programmerProposalRepair.ts's header comment.
  const warningsBeforeRepair = proposal.warnings.length;
  const repaired = repairProposal(proposal, context);
  trace.repairNotes = repaired.warnings.slice(warningsBeforeRepair);

  const domain = validateProposalDomain(repaired, context, db);
  if (!domain.ok || !domain.value) return { ok: false, stage: 'domain', errors: domain.errors, trace };

  // Deterministic completion runs after repair and domain validation and
  // before adequacy validation, which still decides pass/fail unchanged —
  // see programmerAdequacyCompletion.ts's header comment.
  const completed = completeProposalAdequacy(domain.value, context, plan);
  trace.completionNotes = completed.notes;

  const adequacy = validateProposalAdequacy(completed.proposal, context);
  if (!adequacy.ok) return { ok: false, stage: 'adequacy', errors: adequacy.errors, trace };

  return { ok: true, proposal: completed.proposal, trace };
}

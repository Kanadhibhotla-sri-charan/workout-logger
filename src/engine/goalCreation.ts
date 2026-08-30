// Natural-language goal matching — spec §2.1: a hybrid (natural-language +
// structured) goal creation flow that never silently activates an inferred
// goal. This module is the "hybrid" half: it turns free text into a ranked
// list of *candidate* Blueprint goals for the user to review. It never
// persists anything (pure, no DB access) and it is not itself the
// confirmation step — the user must still explicitly pick one candidate
// and call GoalsRepo.create with that blueprint_ref (route:
// POST /api/goals, with source: 'natural_language' and source_text set to
// the original statement). See src/repositories/goalsRepo.ts and
// src/server/routes/goals.ts.
//
// Deterministic by construction (spec §20-21: no LLM/API call may be
// required for core programming) — plain token-overlap scoring against
// Blueprint's own text, no external service, same input always produces
// the same ranked output.
//
// Matching input asymmetry (documented, not invented around): Blueprint's
// aesthetic outcomes carry `common_user_phrasings` — example phrasings
// written for exactly this purpose. Blueprint's functional goals carry no
// equivalent field, so functional candidates are matched against `name` +
// `definition` instead, which is weaker, more sparse phrasing. See
// docs/GOAL_MATCHING.md.

import { BlueprintAdapter, type BlueprintAestheticOutcome, type BlueprintFunctionalGoal } from '../blueprint/adapter.js';
import type { GoalType } from '../contracts/types.js';
import { GOAL_MATCH } from './config.js';

export interface GoalMatchCandidate {
  goal_type: GoalType;
  blueprint_ref: string;
  display_name: string;
  /** Dice coefficient (0-1) between the input text's normalized tokens
   * and the best-matching phrase's normalized tokens. */
  score: number;
  /** The specific Blueprint text that produced the best score — shown to
   * the user so they can judge the match themselves rather than trust an
   * opaque number (explainability, spec §20). */
  matched_on: string;
}

const STOPWORDS = new Set([
  'a', 'an', 'the', 'i', 'my', 'me', 'to', 'of', 'is', 'are', 'am', 'be',
  'have', 'has', 'had', 'no', 'not', 'in', 'on', 'at', 'from', 'with',
  'for', 'and', 'or', 'it', 'this', 'that', 'even', 'though', 'so',
  'than', 'when', 'enough', 'up', 'out',
]);

function normalizeToTokens(text: string): Set<string> {
  const words = text
    .toLowerCase()
    .replace(/[^a-z0-9'\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 1 && !STOPWORDS.has(w));
  return new Set(words);
}

/** Dice coefficient: 2*|A∩B| / (|A|+|B|). 0 if either set is empty. */
function diceScore(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const token of a) {
    if (b.has(token)) intersection++;
  }
  return (2 * intersection) / (a.size + b.size);
}

function bestPhraseMatch(inputTokens: Set<string>, phrases: string[]): { score: number; matched_on: string } {
  let best = { score: 0, matched_on: phrases[0] ?? '' };
  for (const phrase of phrases) {
    const score = diceScore(inputTokens, normalizeToTokens(phrase));
    if (score > best.score) {
      best = { score, matched_on: phrase };
    }
  }
  return best;
}

function matchAestheticOutcome(inputTokens: Set<string>, outcome: BlueprintAestheticOutcome): GoalMatchCandidate {
  const { score, matched_on } = bestPhraseMatch(inputTokens, [outcome.display_name, ...outcome.common_user_phrasings]);
  return { goal_type: 'aesthetic', blueprint_ref: outcome.id, display_name: outcome.display_name, score, matched_on };
}

function matchFunctionalGoal(inputTokens: Set<string>, goal: BlueprintFunctionalGoal): GoalMatchCandidate {
  const { score, matched_on } = bestPhraseMatch(inputTokens, [goal.name, goal.definition]);
  return { goal_type: 'functional', blueprint_ref: goal.id, display_name: goal.name, score, matched_on };
}

/**
 * Turns a free-text goal statement into ranked, explainable Blueprint
 * goal candidates. Read-only — persists nothing. Callers must still route
 * the user's explicit pick through GoalsRepo.create for the goal to
 * exist (spec §2.1: "never silently activate an inferred goal").
 *
 * Returns candidates with score >= GOAL_MATCH.minScore, best first,
 * capped at GOAL_MATCH.maxCandidates. Can return an empty array — that is
 * a valid, expected outcome for vague or unmatched text, not an error;
 * the caller should fall back to the structured (browse-and-pick) path.
 */
export function matchGoalCandidates(text: string): GoalMatchCandidate[] {
  const inputTokens = normalizeToTokens(text);
  if (inputTokens.size === 0) return [];

  const candidates: GoalMatchCandidate[] = [
    ...BlueprintAdapter.getAestheticGoals().map((o) => matchAestheticOutcome(inputTokens, o)),
    ...BlueprintAdapter.getFunctionalGoals().map((g) => matchFunctionalGoal(inputTokens, g)),
  ];

  return candidates
    .filter((c) => c.score >= GOAL_MATCH.minScore)
    .sort((a, b) => b.score - a.score)
    .slice(0, GOAL_MATCH.maxCandidates);
}

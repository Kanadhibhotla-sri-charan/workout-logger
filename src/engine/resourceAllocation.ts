// Resource Allocation — Next Phase spec §17.
//
// "When goals compete for time, volume, recovery, or exercise slots,
// use the user's explicit ranking. Ranking is respected, but does not
// mean blindly maximizing the #1 goal. A well-progressing #1 goal
// should remain protected while scarce resources can be allocated to a
// stagnant lower-ranked goal if this does not compromise the #1 goal."
//
// This module is resource-agnostic — the same function allocates
// minutes, exercise slots, or any other scarce countable resource
// across competing goals; the caller names what's being allocated for
// reasoning text (`resource_name`), the arithmetic doesn't care.
//
// The whole rule reduces to one clean pass, not a multi-tier optimizer:
// process goals strictly in priority order (rank 1 first — "ranking is
// respected... cannot be overridden," required test 5), and cap EACH
// goal's allocation at its own desired_amount rather than handing #1
// (or anyone) the entire remaining budget just because they're served
// first. That cap is exactly what "does not mean blindly maximizing
// the #1 goal" requires: #1 is protected (served first, in full, up to
// what it actually wants) without hoarding budget beyond that, so any
// leftover naturally reaches lower-ranked goals — including a stagnant
// one — without needing a second, separate reallocation pass.

export interface ResourceAllocationGoalInput {
  goal_id: string;
  /** User-controlled rank — lower number = higher priority. Never
   * inferred or reordered by this module (spec §2.2, §17). */
  priority: number;
  desired_amount: number;
  /** Optional — reasoning-only. Never changes how much this goal
   * itself is allocated (its own priority + desired_amount already
   * fully determine that); only explains, for a goal that benefits
   * from another goal's leftover capacity, why that happened to line
   * up with it being stagnant. */
  progress_status?: 'improving' | 'stagnant' | 'declining' | 'insufficient_data';
}

export interface ResourceAllocationInput {
  /** What's being allocated — e.g. "session_minutes", "exercise_slots".
   * Reasoning text only. */
  resource_name: string;
  total_available: number;
  goals: readonly ResourceAllocationGoalInput[];
}

export interface ResourceAllocationEntry {
  goal_id: string;
  priority: number;
  allocated_amount: number;
  reasoning: string;
}

export interface ResourceAllocationResult {
  resource_name: string;
  allocations: ResourceAllocationEntry[];
  unallocated_remaining: number;
}

/**
 * Spec §17. Deterministic: ties in priority break by goal_id, never by
 * insertion order or randomness. Never allocates more than
 * total_available in aggregate, and never gives a goal more than its
 * own desired_amount.
 */
export function allocateResource(input: ResourceAllocationInput): ResourceAllocationResult {
  const ordered = [...input.goals].sort((a, b) => (a.priority !== b.priority ? a.priority - b.priority : a.goal_id.localeCompare(b.goal_id)));

  let remaining = input.total_available;
  const allocations: ResourceAllocationEntry[] = [];

  for (const goal of ordered) {
    const allocated = Math.max(0, Math.min(goal.desired_amount, remaining));
    const fullyServed = allocated >= goal.desired_amount;
    remaining -= allocated;

    const reasonParts = [`priority ${goal.priority}`];
    if (fullyServed) {
      reasonParts.push(`received its full desired ${input.resource_name} (${goal.desired_amount}) — ranking respected, not capped below its own request`);
    } else {
      reasonParts.push(
        `received ${allocated} of its desired ${goal.desired_amount} ${input.resource_name} — insufficient ${input.resource_name} remained after higher-priority goals were served first (ranking cannot be overridden)`
      );
    }
    if (goal.progress_status === 'stagnant' && fullyServed && allocated > 0) {
      reasonParts.push('this goal is stagnant — the leftover capacity after higher-priority goals took only what they needed reached it, per §17');
    }

    allocations.push({ goal_id: goal.goal_id, priority: goal.priority, allocated_amount: allocated, reasoning: reasonParts.join('; ') + '.' });
  }

  return { resource_name: input.resource_name, allocations, unallocated_remaining: remaining };
}

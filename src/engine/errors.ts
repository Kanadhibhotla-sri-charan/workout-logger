// Thrown by every engine module whose real implementation depends on a
// design decision the spec explicitly reserves for Charan's approval
// (§37) rather than a developer's unilateral choice — see
// docs/TRAINING_ENGINE_DESIGN.md §34 and docs/open-decisions.md.
//
// This exists so "not implemented" is loud and specific (which decision,
// where it's written up) rather than a silent wrong answer, a generic
// "not implemented" throw, or — worse — an invented placeholder formula
// quietly standing in for a real one. Fixtures assert against this
// directly (see tests/fixtures/) to prove the boundary is where the
// design says it should be, not further along than it should be.
export class NotApprovedError extends Error {
  constructor(
    public module: string,
    public decision: string,
    detail?: string
  ) {
    super(
      `${module} is not implemented: it depends on "${decision}", ` +
        `an open decision requiring Charan's sign-off — see docs/TRAINING_ENGINE_DESIGN.md §34 ` +
        `and docs/open-decisions.md.` +
        (detail ? ` ${detail}` : '')
    );
    this.name = 'NotApprovedError';
  }
}

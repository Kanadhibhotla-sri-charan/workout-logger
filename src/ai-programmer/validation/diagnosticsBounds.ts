// Correction pass §6: validation issues can echo model-generated
// values/strings. Even though the raw provider payload is never
// returned, an unbounded list of arbitrarily long AI-influenced strings
// could still produce an oversized error response or noisy log line.
// These limits apply only to the DIAGNOSTIC payload surfaced in an
// error's `details.issues` — never to the underlying ok/not-ok
// validation result itself (a proposal that fails validation still
// fails, regardless of how its issue list was truncated for display).

export const MAX_DIAGNOSTIC_ISSUES = 20;
export const MAX_DIAGNOSTIC_ISSUE_CHARS = 500;
export const MAX_DIAGNOSTIC_TOTAL_CHARS = 8000;

const TRUNCATION_MARKER = '[truncated]';

function truncateIssue(issue: string): string {
  if (issue.length <= MAX_DIAGNOSTIC_ISSUE_CHARS) return issue;
  return `${issue.slice(0, MAX_DIAGNOSTIC_ISSUE_CHARS - TRUNCATION_MARKER.length - 1)} ${TRUNCATION_MARKER}`;
}

/** Bounds a raw validation-issue list to a safe size for an API
 * response/log line: at most `MAX_DIAGNOSTIC_ISSUES` issues, each at
 * most `MAX_DIAGNOSTIC_ISSUE_CHARS` characters, and the whole list at
 * most `MAX_DIAGNOSTIC_TOTAL_CHARS` characters — with an explicit
 * `[truncated]` marker appended whenever either limit was hit. */
export function boundDiagnosticIssues(issues: readonly string[]): string[] {
  const perIssueBounded = issues.slice(0, MAX_DIAGNOSTIC_ISSUES).map(truncateIssue);
  const overflowCount = issues.length - perIssueBounded.length;

  const bounded: string[] = [];
  let totalChars = 0;
  let truncatedByTotal = false;
  for (const issue of perIssueBounded) {
    if (totalChars + issue.length > MAX_DIAGNOSTIC_TOTAL_CHARS) {
      truncatedByTotal = true;
      break;
    }
    bounded.push(issue);
    totalChars += issue.length;
  }

  if (overflowCount > 0) {
    bounded.push(`... ${overflowCount} more issue(s) omitted ${TRUNCATION_MARKER}`);
  } else if (truncatedByTotal) {
    bounded.push(TRUNCATION_MARKER);
  }

  return bounded;
}

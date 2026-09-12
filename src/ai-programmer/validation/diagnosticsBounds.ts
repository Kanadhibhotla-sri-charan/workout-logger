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
 * most `MAX_DIAGNOSTIC_ISSUE_CHARS` characters, and the whole returned
 * list — including any trailing `[truncated]`/omission marker — at most
 * `MAX_DIAGNOSTIC_TOTAL_CHARS` characters combined. This is a hard cap:
 * the marker itself is fit within the remaining budget (truncated
 * further if the budget is nearly exhausted) rather than appended on
 * top of it, so the sum of every returned string's length never
 * exceeds `MAX_DIAGNOSTIC_TOTAL_CHARS`. */
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

  let marker: string | null = null;
  if (overflowCount > 0) {
    marker = `... ${overflowCount} more issue(s) omitted ${TRUNCATION_MARKER}`;
  } else if (truncatedByTotal) {
    marker = TRUNCATION_MARKER;
  }

  if (marker !== null) {
    const remaining = MAX_DIAGNOSTIC_TOTAL_CHARS - totalChars;
    if (remaining > 0) {
      bounded.push(marker.length <= remaining ? marker : marker.slice(0, remaining));
    }
  }

  return bounded;
}

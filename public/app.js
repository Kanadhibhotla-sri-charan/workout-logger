async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || 'request failed');
  }
  return res.status === 204 ? null : res.json();
}

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'text') node.textContent = v;
    else node.setAttribute(k, v);
  }
  for (const child of children) node.appendChild(child);
  return node;
}

// Local calendar date (YYYY-MM-DD) in the BROWSER's own timezone — never
// toISOString(), which is always UTC regardless of where the browser is.
// This is a convenience default for pre-filling forms; the server is the
// source of truth for "today" and resolves it from the user's configured
// TrainingProfile.timezone (see src/lib/timezone.ts), not from this value.
function todayIso() {
  const d = new Date();
  return d.toLocaleDateString('en-CA'); // en-CA formats as YYYY-MM-DD
}

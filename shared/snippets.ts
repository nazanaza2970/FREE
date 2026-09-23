const VAR_RE = /\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g;

/** Returns the ordered, de-duplicated list of `{{var}}` names found in content. */
export function extractVariables(content: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const match of content.matchAll(VAR_RE)) {
    if (!seen.has(match[1])) {
      seen.add(match[1]);
      out.push(match[1]);
    }
  }
  return out;
}

/** Substitutes `{{var}}` placeholders. Unknown vars are left as-is. */
export function renderSnippet(content: string, vars: Record<string, string>): string {
  return content.replace(VAR_RE, (full, name: string) =>
    Object.prototype.hasOwnProperty.call(vars, name) && vars[name] !== '' ? vars[name] : full,
  );
}

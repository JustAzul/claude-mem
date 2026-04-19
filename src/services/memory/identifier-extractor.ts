/**
 * Identifier Extractor
 *
 * Extracts citation candidates from observation text for the implicit-signal computer.
 * Used to check whether injected observation content was referenced in subsequent
 * assistant messages (content_cited signal).
 */

const STOPWORDS = new Set([
  'the', 'this', 'that', 'and', 'with', 'from', 'some', 'any', 'null',
  'true', 'false', 'error', 'then', 'when', 'where', 'what', 'which',
  'have', 'been', 'will', 'not', 'are', 'was', 'for', 'its', 'but',
]);

const FILE_EXT_RE = /[^\s`'"]+\.(ts|tsx|js|jsx|py|go|rs|md|json|yaml|yml|toml)\b/g;
const BACKTICK_RE = /`([^`]+)`/g;
const DOUBLE_QUOTE_RE = /"([^"]{4,})"/g;
const CAMEL_CASE_RE = /\b[A-Z][a-zA-Z]*[A-Z][a-zA-Z]*\b/g;
const SNAKE_CASE_RE = /\b[a-z][a-z0-9]*(?:_[a-z0-9]+){2,}\b/g;

function isStopword(token: string): boolean {
  return STOPWORDS.has(token.toLowerCase());
}

function isShort(token: string): boolean {
  return token.length <= 3;
}

/**
 * Extract citation candidates from observation text.
 *
 * Returns up to 20 best candidates (longer/more specific first), normalized
 * to lowercase, deduped. Short tokens (≤3 chars) and stopwords are filtered.
 */
export function extractIdentifiers(text: string): string[] {
  const seen = new Set<string>();
  const candidates: string[] = [];

  function add(raw: string): void {
    const norm = raw.trim().toLowerCase();
    if (!norm || isShort(norm) || isStopword(norm) || seen.has(norm)) return;
    seen.add(norm);
    candidates.push(norm);
  }

  // 1. Backtick-quoted strings
  for (const match of text.matchAll(BACKTICK_RE)) {
    const inner = match[1].trim();
    if (inner.length > 3) add(inner);
  }

  // 2. Double-quoted strings longer than 3 chars
  for (const match of text.matchAll(DOUBLE_QUOTE_RE)) {
    const inner = match[1].trim();
    if (inner.length > 3) add(inner);
  }

  // 3. File paths
  for (const match of text.matchAll(FILE_EXT_RE)) {
    add(match[0]);
  }

  // 4. CamelCase identifiers (2+ uppercase letters, total length ≥ 4)
  for (const match of text.matchAll(CAMEL_CASE_RE)) {
    const token = match[0];
    if (token.length >= 4) add(token);
  }

  // 5. snake_case with 2+ underscores
  for (const match of text.matchAll(SNAKE_CASE_RE)) {
    add(match[0]);
  }

  // Sort: longer candidates first (more specific)
  candidates.sort((a, b) => b.length - a.length);

  return candidates.slice(0, 20);
}

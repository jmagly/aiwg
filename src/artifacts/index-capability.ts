// Derive discovery capabilities from usable prose, with safe title fallbacks for templates.
function usableText(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  if (!text || /\{\{[^}]*\}\}|^#/.test(text)) return undefined;
  return text.replace(/\s+/g, ' ').slice(0, 240);
}

export function extractCapability(
  data: Record<string, unknown>, body: string, fallbackTitle?: string,
): string | undefined {
  const description = usableText(data.description);
  if (description) return description;
  const stripped = body.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '');
  for (const block of stripped.split(/\r?\n\s*\r?\n/)) {
    const text = usableText(block);
    if (text) return text;
  }
  // Strip heading markers before considering a title; never surface a raw heading.
  const heading = stripped.match(/^\s*#{1,6}\s+(.+?)(?:\s+#+)?\s*$/m)?.[1];
  return usableText(data.title) ?? usableText(heading) ?? usableText(fallbackTitle);
}

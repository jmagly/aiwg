// Normalize Droid completion and legacy result terminals for direct workers.
export function factoryTerminalResult(event) {
  if (event.type === 'completion') {
    return typeof event.finalText === 'string' && event.finalText.trim().length > 0
      ? { ...event, result: event.finalText } : null;
  }
  return event.subtype === 'success' && event.is_error === false
    && typeof event.result === 'string' && event.result.trim().length > 0 ? event : null;
}

/** Any malformed line, error event or unsuccessful terminal rejects the stream. */
export function parseFactoryDirectFinal(stdout) {
  if (typeof stdout !== 'string' || !stdout.trim()) return null;
  let final = null;
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let event;
    try {
      event = JSON.parse(trimmed);
    } catch {
      return null;
    }
    if (!event || typeof event !== 'object' || Array.isArray(event)) return null;
    if (event.type === 'error') return null;
    if (event.type !== 'result' && event.type !== 'completion') continue;
    final = factoryTerminalResult(event);
    if (!final) return null;
  }
  return final;
}

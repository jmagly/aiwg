/** Verify both npm's current age display and its older normalized cutoff display. */
export function hasSevenDayReleaseAge(output: string, startedAt: number, endedAt: number): boolean {
  const lines = output.trim().split(/\r?\n/);
  if (lines.length !== 2 || endedAt < startedAt) return false;
  const values = new Map(lines.map(line => {
    const separator = line.indexOf('=');
    return [line.slice(0, separator), line.slice(separator + 1)];
  }));
  const age = values.get('min-release-age');
  const before = values.get('before');
  if (age === '7' && before === 'null') return true;
  // npm 11.12.1 normalizes the relative policy into an absolute timestamp.
  // A null age alone never proves enforcement; the cutoff must be seven days ago.
  if (age !== 'null' || !before || before === 'null') return false;
  const cutoff = Date.parse(before);
  const week = 7 * 24 * 60 * 60 * 1000;
  // Date.toString() used by older npm discards milliseconds. Only that
  // representation gets a rounded-down lower bound; ISO remains exact.
  const secondPrecision = /^[A-Z][a-z]{2} [A-Z][a-z]{2} \d{2} \d{4} \d{2}:\d{2}:\d{2} GMT[+-]\d{4} \(.+\)$/.test(before);
  const lowerBound = secondPrecision ? Math.floor((startedAt - week) / 1000) * 1000 : startedAt - week;
  return Number.isFinite(cutoff) && cutoff >= lowerBound && cutoff <= endedAt - week;
}

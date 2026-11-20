// Compare Cursor date/hash releases by date while retaining exact build identities.
import { gt } from 'semver';

export function workerComparableVersion(version, provider) {
  if (provider !== 'cursor') return version;
  const match = /^(\d{4})\.(\d{1,2})\.(\d{1,2})-[0-9a-f]{7,40}$/.exec(version);
  if (!match) return '';
  const [, year, month, day] = match.map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return '';
  return `${year}.${month}.${day}`;
}

export function cursorWorkerVersionWarning(version, testedVersions, cli) {
  const current = workerComparableVersion(version, 'cursor');
  if (!current) return null;
  let latest;
  for (const tested of testedVersions) {
    const comparable = workerComparableVersion(tested, 'cursor');
    if (comparable && (!latest || gt(comparable, latest.comparable))) latest = { version: tested, comparable };
  }
  if (!latest || !gt(current, latest.comparable)) return null;
  return `Cursor build ${version} is newer than tested build ${latest.version}. `
    + 'Run the manual smoke in docs/providers/cursor-direct.md, then refresh approval with '
    + `\`aiwg doctor --probe-workers --qualify --cli ${cli} --yes\`. `
    + 'Qualification records this exact build; it does not run a live model smoke.';
}

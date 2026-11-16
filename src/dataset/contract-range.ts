// Dependency-free contract-range check for the dataset entry; unrecognized range syntax fails closed.
type Triple = [number, number, number]

const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/
const COMPARATOR = /^(\^|~|>=|<=|>|<|=)?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/

function parse(version: string): Triple | null {
  const match = VERSION.exec(version)
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null
}

function compare(a: Triple, b: Triple): number {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1
  return 0
}

function upperBound(operator: '^' | '~', [major, minor, patch]: Triple): Triple {
  if (operator === '~') return [major, minor + 1, 0]
  if (major > 0) return [major + 1, 0, 0]
  if (minor > 0) return [0, minor + 1, 0]
  return [0, 0, patch + 1]
}

function comparatorIncludes(version: Triple, comparator: string): boolean | null {
  const match = COMPARATOR.exec(comparator)
  if (!match) return null
  const operator = match[1] ?? '='
  const target: Triple = [Number(match[2]), Number(match[3]), Number(match[4])]
  const order = compare(version, target)
  switch (operator) {
    case '^': case '~': return order >= 0 && compare(version, upperBound(operator, target)) < 0
    case '>=': return order >= 0
    case '<=': return order <= 0
    case '>': return order > 0
    case '<': return order < 0
    default: return order === 0
  }
}

/**
 * True when `version` (x.y.z) satisfies `range`. Supports exact versions, `^`, `~`,
 * `>=`, `<=`, `>`, `<`, space-separated AND and `||` OR. Prerelease tags, wildcards,
 * hyphen ranges and any other syntax return false rather than guessing.
 */
export function contractRangeIncludes(version: string, range: string): boolean {
  const parsed = parse(version)
  if (!parsed || typeof range !== 'string' || range.trim() === '') return false
  return range.split('||').some((alternative) => {
    const comparators = alternative.trim().split(/\s+/).filter(Boolean)
    if (comparators.length === 0) return false
    return comparators.every((comparator) => comparatorIncludes(parsed, comparator) === true)
  })
}

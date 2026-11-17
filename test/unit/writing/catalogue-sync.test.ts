import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = resolve(import.meta.dirname, '../../..')

describe('writing pattern catalogue copy', () => {
  it('keeps the package-local copy identical to the writing-quality addon catalogue', () => {
    const canonical = readFileSync(resolve(root, 'agentic/code/addons/writing-quality/skills/ai-pattern-detection/references/current-patterns.json'), 'utf8')
    const packaged = readFileSync(resolve(root, 'src/writing/current-patterns.catalogue.json'), 'utf8')
    expect(packaged).toBe(canonical)
  })

  it('does not load agentic/code from writing diagnostics at runtime', () => {
    const source = readFileSync(resolve(root, 'src/writing/current-patterns.ts'), 'utf8')
    const specifiers = [...source.matchAll(/(?:require\(|from\s+|import\()\s*['"`]([^'"`]+)['"`]/g)].map((match) => match[1])
    expect(specifiers).toContain('./current-patterns.catalogue.json')
    expect(specifiers.filter((specifier) => specifier.includes('agentic/code'))).toEqual([])
  })
})

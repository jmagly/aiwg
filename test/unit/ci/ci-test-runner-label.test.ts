import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = resolve(import.meta.dirname, '../../..')
const workflow = readFileSync(resolve(root, '.gitea/workflows/ci.yml'), 'utf8')

describe('CI Test job runner placement (#4129)', () => {
  it('runs the Test job only on the repository-private aiwg-ci label', () => {
    const start = workflow.indexOf('\n  test:\n')
    expect(start).toBeGreaterThan(-1)
    const rest = workflow.slice(start + 1)
    const next = rest.search(/\n  [a-z0-9_-]+:\n/)
    const job = next === -1 ? rest : rest.slice(0, next)
    expect(job).toMatch(/^\s{4}runs-on: aiwg-ci$/m)
    expect(job).not.toMatch(/^\s{4}runs-on: ubuntu-latest$/m)
  })
})

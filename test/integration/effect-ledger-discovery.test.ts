/**
 * Discovery ranks the effect-ledger skill first for its core phrases (#2720),
 * after a fresh index build over an isolated copy of the packaged corpus.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { cpSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { buildIndex } from '../../src/artifacts/index-builder.js'
import { discoverCapability } from '../../src/artifacts/query-engine.js'

const REPO_ROOT = path.resolve(import.meta.dirname, '../..')

describe('effect-ledger discovery from an isolated packaged corpus', () => {
  let temporaryRoot: string
  let corpusRoot: string
  let originalAiwgRoot: string | undefined
  let originalXdgDataHome: string | undefined

  beforeAll(async () => {
    temporaryRoot = mkdtempSync(path.join(os.tmpdir(), 'aiwg-effect-discovery-'))
    corpusRoot = path.join(temporaryRoot, 'corpus')
    mkdirSync(corpusRoot, { recursive: true })
    cpSync(path.join(REPO_ROOT, 'agentic'), path.join(corpusRoot, 'agentic'), { recursive: true })
    originalAiwgRoot = process.env.AIWG_ROOT
    originalXdgDataHome = process.env.XDG_DATA_HOME
    process.env.AIWG_ROOT = corpusRoot
    process.env.XDG_DATA_HOME = path.join(temporaryRoot, 'xdg-data')
    const originalLog = console.log
    console.log = () => undefined
    try {
      await buildIndex(corpusRoot, { graph: 'framework', force: true, explicit: true })
    } finally {
      console.log = originalLog
    }
  }, 60_000)

  afterAll(() => {
    if (originalAiwgRoot === undefined) delete process.env.AIWG_ROOT
    else process.env.AIWG_ROOT = originalAiwgRoot
    if (originalXdgDataHome === undefined) delete process.env.XDG_DATA_HOME
    else process.env.XDG_DATA_HOME = originalXdgDataHome
    rmSync(temporaryRoot, { recursive: true, force: true })
  })

  async function discover(phrase: string) {
    const captured: string[] = []
    const originalLog = console.log
    console.log = (...args: unknown[]) => captured.push(args.map(String).join(' '))
    try {
      await discoverCapability(corpusRoot, { phrase, graph: 'framework', backend: 'local', json: true, limit: 5 })
    } finally {
      console.log = originalLog
    }
    return JSON.parse(captured.join(''))
  }

  it.each(['record an effect', 'did this PR merge', 'reconcile effect', 'sign an effect'])(
    'ranks the effect-ledger skill first for “%s”', async phrase => {
      const result = await discover(phrase)
      expect(result.results[0]?.name).toBe('effect-ledger')
      expect(result.results[0]?.path).toContain('skills/effect-ledger/SKILL.md')
    })
})

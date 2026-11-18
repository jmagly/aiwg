import { describe, expect, it } from 'vitest'
import { scopeDiagnosticsToCli } from '../../../tools/cli/doctor-worker-probe.mjs'

// #4293: `doctor --probe-workers --qualify --cli codex` must not fail because another CLI's group is unqualified.
const parallelism = {
  groups: {
    harness: { members: [{ id: 'codex-coding', cli: 'codex', roles: ['coding'] }] },
    cursor: { members: [{ id: 'cursor-coding', cli: 'cursor', roles: ['coding'] }] },
  },
}
const cursorUnqualified = { code: 'OG_ADAPTER_UNQUALIFIED', pointer: '/parallelism/groups/cursor/requiredRoles', message: 'No qualified route covers coding' }
const harnessUnqualified = { ...cursorUnqualified, pointer: '/parallelism/groups/harness/requiredRoles' }
const wiring = { code: 'OG_CONFIG_REFERENCE', pointer: '/defaults/workerSelection/roleGuidance/coding/groups', message: 'Group "x" is outside role guidance' }

describe('scopeDiagnosticsToCli', () => {
  it('keeps every diagnostic blocking when no --cli is given', () => {
    expect(scopeDiagnosticsToCli([cursorUnqualified, wiring], parallelism, undefined)).toEqual([cursorUnqualified, wiring])
  })

  it('lists another CLI group diagnostic as non-blocking under --cli', () => {
    const [row] = scopeDiagnosticsToCli([cursorUnqualified], parallelism, 'codex')
    expect(row).toMatchObject({ pointer: '/parallelism/groups/cursor/requiredRoles', blocking: false })
  })

  it('keeps the requested CLI group diagnostic and static wiring errors blocking', () => {
    const rows = scopeDiagnosticsToCli([harnessUnqualified, wiring], parallelism, 'codex')
    expect(rows.every(row => row.blocking !== false)).toBe(true)
  })

  it('treats a diagnostic for an unknown group as not using the CLI', () => {
    const [row] = scopeDiagnosticsToCli([{ ...cursorUnqualified, pointer: '/parallelism/groups/ghost/requiredRoles' }], parallelism, 'codex')
    expect(row.blocking).toBe(false)
  })
})

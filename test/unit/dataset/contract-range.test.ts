import { describe, expect, it } from 'vitest'
import { contractRangeIncludes } from '../../../src/dataset/contract-range.js'

describe('contractRangeIncludes (dependency-free dataset contract ranges)', () => {
  it.each([
    ['1.0.0', '^1.0.0', true], ['1.4.2', '^1.0.0', true], ['2.0.0', '^1.0.0', false],
    ['0.2.5', '^0.2.0', true], ['0.3.0', '^0.2.0', false], ['0.0.4', '^0.0.3', false],
    ['1.2.9', '~1.2.0', true], ['1.3.0', '~1.2.0', false],
    ['1.0.0', '1.0.0', true], ['1.0.1', '=1.0.0', false],
    ['1.5.0', '>=1.0.0 <2.0.0', true], ['2.0.0', '>=1.0.0 <2.0.0', false],
    ['3.1.0', '^1.0.0 || ^3.0.0', true], ['2.1.0', '^1.0.0 || ^3.0.0', false],
    ['1.0.0', '<=1.0.0', true], ['1.0.0', '>1.0.0', false],
  ])('%s in %s -> %s', (version, range, expected) => {
    expect(contractRangeIncludes(version, range)).toBe(expected)
  })

  it.each(['1.x', '*', '1.0.0 - 2.0.0', '^1.0.0-beta.1', 'latest', '', '  ', '>= 1.0.0'])(
    'fails closed on unsupported range %j', (range) => {
      expect(contractRangeIncludes('1.0.0', range)).toBe(false)
    })

  it('rejects an invalid version', () => {
    expect(contractRangeIncludes('1.0', '^1.0.0')).toBe(false)
  })
})

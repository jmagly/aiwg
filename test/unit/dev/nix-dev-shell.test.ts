import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

// #4297: external tools that default-lane tests spawn and fail without.
// Map each command to the nixpkgs attribute that provides it in flake.nix.
const REQUIRED_TOOLS: Record<string, string> = {
  node: 'nodejs_24', git: 'git', gpg: 'gnupg', 'ssh-keygen': 'openssh', openssl: 'openssl',
  python3: 'python3', bash: 'bash', tar: 'gnutar', mkfifo: 'coreutils',
}
const LINUX_ONLY_TOOLS: Record<string, string> = { ps: 'procps', setfacl: 'acl' }

const flake = readFileSync(new URL('../../../flake.nix', import.meta.url), 'utf8')
const lock = JSON.parse(readFileSync(new URL('../../../flake.lock', import.meta.url), 'utf8'))
const words = (text: string) => new Set(text.replace(/#.*$/gm, '').split(/[^A-Za-z0-9_-]+/))
const shellPackages = words(flake.slice(flake.indexOf('packages = with pkgs; ['), flake.indexOf('lib.optionals stdenv.isLinux')))
const linuxPackages = words(flake.slice(flake.indexOf('lib.optionals stdenv.isLinux'), flake.indexOf('shellHook')))

describe('Nix development shell (#4297)', () => {
  it.each(Object.entries(REQUIRED_TOOLS))('declares a package for %s', (_tool, pkg) => {
    expect(shellPackages.has(pkg)).toBe(true)
  })

  it.each(Object.entries(LINUX_ONLY_TOOLS))('declares a Linux package for %s', (_tool, pkg) => {
    expect(linuxPackages.has(pkg)).toBe(true)
  })

  it('pins nixpkgs to an exact revision', () => {
    expect(lock.nodes.nixpkgs.locked.rev).toMatch(/^[0-9a-f]{40}$/)
  })
})

/**
 * Git-native Fortemi marketplace command handler.
 *
 * Catalog results are observations, never endorsements. Direct Git and catalog
 * installs share the same immutable lock and local receipt pipeline.
 *
 * @implements #805
 * @implements #2009
 */

import { handlePluginSearch } from './marketplace-plugin-search.js';
import fs from 'node:fs';
import path from 'node:path';
import { sensitiveInputOptions } from '../../auth/sensitive-input.js';

import type { CommandHandler, HandlerContext, HandlerResult } from './types.js';
import { searchSkills } from '../../skills/registry.js';
import { installPackage, listInstalledPackages } from '../../packages/registry.js';
import { GitAdapter } from '../../packages/adapters/git.js';
import { inspectGitCheckout } from '../../marketplace/provenance.js';
import {
  exportPortablePackage,
  findIndexedPackage,
  importPortablePackage,
  marketplaceConfigDir,
  publishLocalPackage,
  readCatalogEnvelope,
  readTrustStore,
  registerCatalog,
  removeCatalog,
  resolveCatalogEntry,
  resolveVerificationPolicy,
  searchCatalogs,
  verifyIndexedPackage,
} from '../../marketplace/exchange.js';
import * as ui from '../ui.js';

const USAGE = [
  'Usage:',
  '  aiwg marketplace add <catalog-git-url> [--ref <tag-or-sha>]',
  '  aiwg marketplace search <query>          Search packages and signed catalogs',
  '  aiwg marketplace search <query> --plugins [--provider all|claude|codex] [--max-age-days 30] [--json]',
  '  aiwg marketplace info <package>           Show provenance and catalog observations',
  '  aiwg marketplace install <url|package>    Install and lock direct Git or catalog package',
  '  aiwg marketplace verify <package|lock>    Verify cached content and receipts offline',
  '  aiwg marketplace export <package> --output <archive.json>',
  '  aiwg marketplace import <archive.json> [--project-local]',
  '  aiwg marketplace publish <source> --publisher <id> [--key-file <pem> | --key-stdin]',
  '  aiwg marketplace remove <catalog-id>',
  '  aiwg marketplace list                    List installed marketplace packages',
  '',
  'Common flags:',
  '  --json             Output structured JSON',
  '  --project-local    Store/read state below the target project .aiwg directory',
  '  --global           Store/read state in the user AIWG directory (default)',
  '  --policy <name>    Named trust policy or JSON policy path',
  'Git fetch token sources:',
  '  --token-interactive | --token-stdin | --token-file <path> | --token-store <name> | --token-env <name>',
  'Publish key sources (multiline PEM):',
  '  --key-interactive | --key-stdin | --key-file <path> | --key-store <name> | --key-env <name>',
  '  --key <path>       Compatibility alias for --key-file (private file required)',
].join('\n');

function parseFlag(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx === -1 || idx + 1 >= args.length) return undefined;
  return args[idx + 1];
}
function hasFlag(args: string[], flag: string): boolean {
  return args.includes(flag);
}

function scopeFromContext(ctx: HandlerContext): { projectLocal: boolean; projectDir: string } {
  const projectLocal = hasFlag(ctx.args, '--project-local');
  if (projectLocal && hasFlag(ctx.args, '--global')) throw new Error('Choose either --project-local or --global, not both');
  return { projectLocal, projectDir: parseFlag(ctx.args, '--target') ?? ctx.cwd };
}

function jsonOrMessage(jsonMode: boolean, value: unknown, message: string): HandlerResult {
  if (jsonMode) {
    console.log(JSON.stringify(value, null, 2));
    return { exitCode: 0 };
  }
  return { exitCode: 0, message };
}

function failure(error: unknown): HandlerResult {
  return { exitCode: 1, message: `Error: ${error instanceof Error ? error.message : String(error)}` };
}

function requiredArg(ctx: HandlerContext, usage: string): string | HandlerResult {
  const value = ctx.args[1];
  return !value || value.startsWith('--') ? { exitCode: 1, message: `Error: ${usage}` } : value;
}

export const marketplaceHandler: CommandHandler = {
  id: 'marketplace',
  name: 'Marketplace',
  description: 'Federated Git marketplace with Fortemi provenance and offline verification',
  category: 'framework',
  aliases: ['market'],

  async execute(ctx: HandlerContext): Promise<HandlerResult> {
    const subcommand = ctx.args[0];
    if (!subcommand) return { exitCode: 0, message: USAGE };
    if (subcommand === 'add') return handleAdd(ctx);
    if (subcommand === 'search') return ctx.args.includes('--plugins') ? handlePluginSearch(ctx) : handleSearch(ctx);
    if (subcommand === 'info') return handleInfo(ctx);
    if (subcommand === 'install') return handleInstall(ctx);
    if (subcommand === 'verify') return handleVerify(ctx);
    if (subcommand === 'export') return handleExport(ctx);
    if (subcommand === 'import') return handleImport(ctx);
    if (subcommand === 'publish') return handlePublish(ctx);
    if (subcommand === 'remove') return handleRemove(ctx);
    if (subcommand === 'list') return handleList(ctx);
    return { exitCode: 1, message: `Error: Unknown subcommand '${subcommand}'\n\n${USAGE}` };
  },
};

async function handleAdd(ctx: HandlerContext): Promise<HandlerResult> {
  const argument = requiredArg(ctx, 'Catalog Git URL required');
  if (typeof argument !== 'string') return argument;
  try {
    const scope = scopeFromContext(ctx);
    const requestedRef = parseFlag(ctx.args, '--ref') ?? 'HEAD';
    const adapter = new GitAdapter();
    const source = { gitUrl: argument, ref: requestedRef, label: argument };
    const cachePath = await adapter.fetch(source, {
      refresh: hasFlag(ctx.args, '--refresh'),
      tokenInput: sensitiveInputOptions(ctx.args, 'token'),
    });
    const identity = await inspectGitCheckout(cachePath);
    const candidates = [
      path.join(cachePath, 'aiwg-marketplace-catalog.json'),
      path.join(cachePath, '.aiwg', 'marketplace', 'catalog.json'),
    ];
    const catalogPath = candidates.find((candidate) => fs.existsSync(candidate));
    if (!catalogPath) throw new Error('Catalog repository has no aiwg-marketplace-catalog.json or .aiwg/marketplace/catalog.json');
    const trustStore = await readTrustStore({ ...scope, path: parseFlag(ctx.args, '--trust-store') });
    const record = await registerCatalog({
      ...scope,
      catalogPath,
      source: identity.canonicalRemote,
      requestedRef: source.ref ?? requestedRef,
      resolvedCommit: identity.resolvedCommit,
      cachePath,
      trustStore,
    });
    return jsonOrMessage(hasFlag(ctx.args, '--json'), record, `Added verified catalog ${record.catalogId} at ${record.resolvedCommit}`);
  } catch (error) {
    return failure(error);
  }
}

async function handleSearch(ctx: HandlerContext): Promise<HandlerResult> {
  const argument = requiredArg(ctx, 'Query required\n\nUsage: aiwg marketplace search <query>');
  if (typeof argument !== 'string') return argument;
  try {
    const source = parseFlag(ctx.args, '--source');
    const scope = scopeFromContext(ctx);
    const [skillResults, catalogResults] = await Promise.all([
      !source || !source.startsWith('catalog:') ? searchSkills(argument, source) : Promise.resolve([]),
      searchCatalogs(argument, scope),
    ]);
    const filteredCatalogs = source?.startsWith('catalog:')
      ? catalogResults.filter((result) => result.catalogId === source.slice('catalog:'.length))
      : source ? [] : catalogResults;
    const results = [
      ...skillResults,
      ...filteredCatalogs.map((entry) => ({
        name: `${entry.identity}@${entry.version}`,
        description: entry.description,
        source: `catalog:${entry.catalogId}`,
        package: entry.identity,
        provenanceCompleteness: entry.provenanceCompleteness,
        verificationStatus: entry.verificationStatus,
        observation: entry.observation,
      })),
    ];
    if (hasFlag(ctx.args, '--json')) {
      console.log(JSON.stringify(results, null, 2));
      return { exitCode: 0 };
    }
    ui.blank();
    console.log(`  ${ui.brandMark()} ${ui.bold(`Marketplace Search: "${argument}"`)}`);
    if (source) ui.dim(`  Source: ${source}`);
    ui.rule();
    if (results.length === 0) {
      ui.dim('  No results found.');
      ui.blank();
      return { exitCode: 0 };
    }
    const nameWidth = Math.max(12, ...results.map((result) => result.name.length));
    const sourceWidth = Math.max(8, ...results.map((result) => result.source.length));
    const pkgWidth = Math.max(10, ...results.map((result) => (result.package ?? '').length));
    const header = ['Name'.padEnd(nameWidth), 'Source'.padEnd(sourceWidth), 'Package'.padEnd(pkgWidth), 'Description'].join('  ');
    ui.dim(`  ${header}`);
    ui.dim(`  ${'─'.repeat(header.length)}`);
    for (const result of results) {
      console.log(`  ${[
        result.name.padEnd(nameWidth),
        result.source.padEnd(sourceWidth),
        (result.package ?? '').padEnd(pkgWidth),
        result.description.length > 60 ? `${result.description.slice(0, 57)}...` : result.description,
      ].join('  ')}`);
    }
    ui.blank();
    ui.dim(`  ${results.length} result${results.length === 1 ? '' : 's'}; catalog inclusion is not an endorsement`);
    return { exitCode: 0 };
  } catch (error) {
    return failure(error);
  }
}

async function handleInfo(ctx: HandlerContext): Promise<HandlerResult> {
  const argument = requiredArg(ctx, 'Package query required');
  if (typeof argument !== 'string') return argument;
  try {
    const scope = scopeFromContext(ctx);
    const installed = await findIndexedPackage(argument, scope);
    const catalogs = (await searchCatalogs(argument, scope)).filter((entry) =>
      entry.identity === argument || `${entry.identity}@${entry.version}` === argument || entry.lockId === argument);
    if (!installed && catalogs.length === 0) return { exitCode: 1, message: `Error: Marketplace package '${argument}' was not found` };
    const result = {
      query: argument,
      installed: installed ? {
        lock: installed.lock,
        verificationStatus: installed.verificationStatus,
        installedAt: installed.installedAt,
        catalogs: installed.catalogs,
      } : null,
      catalogObservations: catalogs,
      endorsement: false,
    };
    return jsonOrMessage(hasFlag(ctx.args, '--json'), result, [
      `Package: ${argument}`,
      `Installed: ${installed ? 'yes' : 'no'}`,
      ...(installed ? [`Lock: ${installed.lock.lockId}`, `Verification: ${installed.verificationStatus}`] : []),
      `Catalog observations: ${catalogs.length} (not endorsements)`,
      ...catalogs.map((entry) => `  ${entry.catalogId}: ${entry.provenanceCompleteness}% provenance, ${entry.verificationStatus}`),
    ].join('\n'));
  } catch (error) {
    return failure(error);
  }
}

function looksLikeGitUrl(value: string): boolean {
  return /^(?:https?:\/\/|ssh:\/\/|git@)/.test(value);
}

async function handleInstall(ctx: HandlerContext): Promise<HandlerResult> {
  const argument = requiredArg(ctx, 'Git URL or catalog package required');
  if (typeof argument !== 'string') return argument;
  try {
    const scope = scopeFromContext(ctx);
    const configDir = marketplaceConfigDir(scope);
    const resolvedPolicy = await resolveVerificationPolicy(parseFlag(ctx.args, '--policy'), scope);
    let rawRef = argument;
    let expectedEnvelope;
    let expectedLockId: string | undefined;
    let catalogId: string | undefined;
    let ref = parseFlag(ctx.args, '--ref');
    if (!looksLikeGitUrl(argument)) {
      const catalog = await resolveCatalogEntry(argument, scope);
      expectedEnvelope = await readCatalogEnvelope(catalog, scope);
      rawRef = catalog.canonicalRemote;
      expectedLockId = catalog.lockId;
      catalogId = catalog.catalogId;
      ref = catalog.resolvedCommit;
    }
    const installed = await installPackage(rawRef, {
      configDir,
      tokenInput: sensitiveInputOptions(ctx.args, 'token'),
      ref,
      packageSelector: parseFlag(ctx.args, '--package'),
      refresh: hasFlag(ctx.args, '--refresh'),
      verify: hasFlag(ctx.args, '--verify'),
      verificationPolicy: resolvedPolicy.policy,
      trustStore: resolvedPolicy.trustStore,
      expectedEnvelope,
      expectedLockId,
      catalogId,
      actor: 'local-user',
    });
    const result = {
      package: installed.key,
      version: installed.envelope.package.version,
      lockId: installed.lock.lockId,
      resolvedCommit: installed.lock.resolvedCommit,
      verificationStatus: installed.verification.status,
      scope: scope.projectLocal ? 'project-local' : 'global',
      catalog: catalogId ?? null,
    };
    return jsonOrMessage(hasFlag(ctx.args, '--json'), result, `Installed ${result.package}@${result.version}\nLock: ${result.lockId}\nVerification: ${result.verificationStatus}`);
  } catch (error) {
    return failure(error);
  }
}

async function handleVerify(ctx: HandlerContext): Promise<HandlerResult> {
  const argument = requiredArg(ctx, 'Package or lock query required');
  if (typeof argument !== 'string') return argument;
  try {
    const scope = scopeFromContext(ctx);
    const resolved = await resolveVerificationPolicy(parseFlag(ctx.args, '--policy'), scope);
    const result = await verifyIndexedPackage({
      ...scope,
      query: argument,
      policy: resolved.policy,
      trustStore: resolved.trustStore,
      requireSignature: hasFlag(ctx.args, '--require-signature'),
      actor: 'local-user',
    });
    if (!result.verification.ok) return { exitCode: 1, message: `Verification failed: ${result.verification.errors.join('; ')}` };
    return jsonOrMessage(hasFlag(ctx.args, '--json'), result.verification, `Verified ${result.entry.lock.identity}@${result.entry.lock.version} offline\nStatus: ${result.verification.status}\nLock: ${result.entry.lock.lockId}`);
  } catch (error) {
    return failure(error);
  }
}

async function handleExport(ctx: HandlerContext): Promise<HandlerResult> {
  const argument = requiredArg(ctx, 'Package query required');
  if (typeof argument !== 'string') return argument;
  const output = parseFlag(ctx.args, '--output');
  if (!output) return { exitCode: 1, message: 'Error: Usage: aiwg marketplace export <package> --output <archive.json>' };
  try {
    const result = await exportPortablePackage({ ...scopeFromContext(ctx), query: argument, output, actor: 'local-user' });
    return jsonOrMessage(hasFlag(ctx.args, '--json'), { output: result.output, lockId: result.bundle.lock.lockId, receiptId: result.receipt.receiptId }, `Exported ${result.bundle.lock.identity}@${result.bundle.lock.version} to ${result.output}`);
  } catch (error) {
    return failure(error);
  }
}

async function handleImport(ctx: HandlerContext): Promise<HandlerResult> {
  const argument = requiredArg(ctx, 'Portable archive path required');
  if (typeof argument !== 'string') return argument;
  try {
    const scope = scopeFromContext(ctx);
    const resolved = await resolveVerificationPolicy(parseFlag(ctx.args, '--policy'), scope);
    const result = await importPortablePackage({
      ...scope,
      input: argument,
      verify: hasFlag(ctx.args, '--verify'),
      policy: resolved.policy,
      trustStore: resolved.trustStore,
      actor: 'local-user',
    });
    return jsonOrMessage(hasFlag(ctx.args, '--json'), { lock: result.entry.lock, verification: result.verification, receipt: result.receipt }, `Imported ${result.entry.lock.identity}@${result.entry.lock.version}\nLock: ${result.entry.lock.lockId}\nVerification: ${result.verification.status}`);
  } catch (error) {
    return failure(error);
  }
}

async function handlePublish(ctx: HandlerContext): Promise<HandlerResult> {
  const argument = requiredArg(ctx, 'Package source directory required');
  if (typeof argument !== 'string') return argument;
  const privateKeyPath = parseFlag(ctx.args, '--key');
  const publisher = parseFlag(ctx.args, '--publisher');
  if (!publisher) {
    return { exitCode: 1, message: 'Error: Usage: aiwg marketplace publish <source> [--key-file <ed25519.pem> | --key-stdin] --publisher <id> [--output <dir>]' };
  }
  try {
    const outputDir = parseFlag(ctx.args, '--output') ?? path.join(path.resolve(argument), '.aiwg', 'marketplace');
    const sequenceText = parseFlag(ctx.args, '--sequence');
    const sequence = sequenceText === undefined ? undefined : Number(sequenceText);
    if (sequence !== undefined && (!Number.isSafeInteger(sequence) || sequence < 1)) throw new Error('--sequence must be a positive integer');
    const published = await publishLocalPackage({
      sourceDir: argument,
      outputDir,
      privateKeyPath,
      keyInput: sensitiveInputOptions(ctx.args, 'key'),
      publicKeyPath: parseFlag(ctx.args, '--public-key'),
      keyId: parseFlag(ctx.args, '--key-id'),
      publisher,
      requestedRef: parseFlag(ctx.args, '--ref'),
      packageSelector: parseFlag(ctx.args, '--package'),
      sequence,
      actor: publisher,
    });
    return jsonOrMessage(hasFlag(ctx.args, '--json'), published, `Published signed envelope ${published.lock.lockId}\nEnvelope: ${published.envelopePath}\nFortemi: ${published.shardPath}`);
  } catch (error) {
    return failure(error);
  }
}

async function handleRemove(ctx: HandlerContext): Promise<HandlerResult> {
  const argument = requiredArg(ctx, 'Catalog ID required');
  if (typeof argument !== 'string') return argument;
  try {
    const removed = await removeCatalog(argument, scopeFromContext(ctx));
    return {
      exitCode: removed ? 0 : 1,
      message: removed
        ? `Removed catalog ${argument}; existing immutable package locks remain valid`
        : `Catalog '${argument}' was not registered`,
    };
  } catch (error) {
    return failure(error);
  }
}

async function handleList(ctx: HandlerContext): Promise<HandlerResult> {
  try {
    const scope = scopeFromContext(ctx);
    const packages = await listInstalledPackages(marketplaceConfigDir(scope));
    if (hasFlag(ctx.args, '--json')) {
      console.log(JSON.stringify(packages, null, 2));
      return { exitCode: 0 };
    }
    ui.blank();
    console.log(`  ${ui.brandMark()} ${ui.bold('Installed Marketplace Packages')}`);
    ui.rule();
    if (packages.length === 0) {
      ui.dim('  No packages installed.');
      ui.blank();
      return { exitCode: 0 };
    }
    const keyWidth = Math.max(12, ...packages.map((pkg) => pkg.key.length));
    const versionWidth = Math.max(7, ...packages.map((pkg) => pkg.version.length));
    const header = ['Package'.padEnd(keyWidth), 'Version'.padEnd(versionWidth), 'Type', 'Verification'].join('  ');
    ui.dim(`  ${header}`);
    ui.dim(`  ${'─'.repeat(header.length)}`);
    for (const pkg of packages) {
      console.log(`  ${[pkg.key.padEnd(keyWidth), pkg.version.padEnd(versionWidth), pkg.type, pkg.verificationStatus ?? 'legacy'].join('  ')}`);
    }
    ui.blank();
    ui.dim(`  ${packages.length} package${packages.length === 1 ? '' : 's'} installed`);
    return { exitCode: 0 };
  } catch (error) {
    return failure(error);
  }
}

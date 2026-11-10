// Formats the steward capability matrix and permission command usage.
import { isExternalStrategy, type CapabilityMatrix, type FeatureKey, type ProviderCapabilities } from '../../providers/capability-matrix.js';
export function printFullMatrix(matrix: CapabilityMatrix): void {
  const { providers, features } = matrix;
  const providerIds = Object.keys(providers);
  const featureIds = Object.keys(features) as FeatureKey[];

  console.log(`\n  Provider Capability Matrix (v${matrix.version})`);
  console.log(`  ✓ = native   ~ = AIWG emulation   - = not supported\n`);

  const featureColW = 20;
  const provColW = 14;
  const header = '  ' + 'Feature'.padEnd(featureColW) + providerIds.map(p => p.padEnd(provColW)).join('');
  console.log(header);
  console.log('  ' + '─'.repeat(featureColW + providerIds.length * provColW));

  for (const featureId of featureIds) {
    const feat = features[featureId];
    let row = '  ' + featureId.padEnd(featureColW);
    for (const providerId of providerIds) {
      const provider = providers[providerId];
      const isNative = provider?.native_features?.[featureId] === true;
      const emulation = provider?.emulation?.[featureId] ?? null;
      const mark = isNative ? '✓' : (emulation ? '~' : '-');
      row += mark.padEnd(provColW);
    }
    console.log(row);
    if (feat?.description) {
      console.log('  ' + ' '.repeat(featureColW) + feat.description);
    }
    console.log('');
  }
}

// ── Main execution ─────────────────────────────────────────────────────────────

export function permissionsUsage(): string {
  return `
  aiwg steward permissions — authorization model audit and normalization

  Usage:
    aiwg steward permissions audit                 Find normalized-model errors and legacy grants
    aiwg steward permissions migrate --dry-run     Preview legacy permission normalization
    aiwg steward permissions migrate --apply       Back up and atomically normalize config

  Reads .aiwg/aiwg.config authorization block. Migration backs up before writing.
`;
}


const NATIVE_MARK = '✓ native';
const EMULATED_MARK = '~ emulated';
const EXTERNAL_MARK = '↗ external';
const UNSUPPORTED_MARK = '- not supported';

export function emulationLabel(strategy: string | null): string {
  if (!strategy) return 'none';
  if (strategy === 'native') return 'native (no fallback needed)';
  return strategy;
}

export function formatProvider(
  id: string,
  provider: ProviderCapabilities,
  matrix: CapabilityMatrix,
  meta?: { id: string; baseAdapter: string },
): string {
  const lines: string[] = [];
  lines.push(`\n  Provider: ${provider.display_name} (${id})`);
  if (meta) {
    lines.push(`  Project-local: yes`);
    lines.push(`  Base adapter:   ${meta.baseAdapter}`);
  }
  lines.push(`  Status:   ${provider.status}`);
  lines.push(`  Daemon:   ${provider.daemon_tier}${provider.daemon_pty_adapter ? ' (+ pty-adapter)' : ''}`);
  lines.push(`  ${'─'.repeat(60)}`);

  if (provider.byok) {
    const byok = provider.byok;
    lines.push(`\n  Bring your own key (BYOK): ${byok.status}`);
    for (const setting of byok.settings) lines.push(`    ${setting}`);
    lines.push(`    Verify: ${byok.verification}`);
    lines.push(`    ${byok.notes}`);
    lines.push('    Security: aiwg show rule token-security --body; environment or secret-store command only.');
    lines.push('    Never place keys on argv, in deployed AIWG files, harness config, logs or receipts; never print keys.');
    lines.push("    Spend: BYOK runs bill the user's key; paid runs need explicit operator approval.");
    lines.push(`    Docs: ${byok.docs}`);
  }

  const featureKeys = Object.keys(matrix.features) as FeatureKey[];
  for (const featureId of featureKeys) {
    const isNative = provider.native_features?.[featureId] === true;
    const emulation = provider.emulation?.[featureId] ?? null;
    const status = isNative
      ? NATIVE_MARK
      : isExternalStrategy(emulation) ? EXTERNAL_MARK : (emulation ? EMULATED_MARK : UNSUPPORTED_MARK);
    const feat = matrix.features[featureId];

    lines.push(`\n  ${featureId} — ${status}`);
    if (feat?.description) lines.push(`    ${feat.description}`);
    if (isNative) {
      if (id === 'omp' && featureId === 'mcp') {
        lines.push('    OMP supplies the native client. AIWG persistent injection/removal is available for project and profile scope; ephemeral injection is unsupported.');
        lines.push('    example: aiwg mcp inject --provider omp --servers local-tools');
      } else if (id === 'omp' && featureId === 'behaviors') {
        lines.push('    AIWG bridges selected handlers through an OMP extension; no default policy is installed. Permission-request and pre-compaction enforcement are unsupported.');
      } else if (id === 'omp' && (featureId === 'tasks' || featureId === 'agent_teams')) {
        lines.push('    OMP native leaf tasks use AIWG workspace admission limits and verified child results; nested requests share the same scheduler.');
        lines.push('    example: aiwg team run --provider omp --body-file tasks.json');
      } else if (feat?.native_example) lines.push(`    example: ${feat.native_example}`);
    } else if (isExternalStrategy(emulation)) {
      lines.push(`    trigger: system cron, systemd timer, or CI; AIWG does not own the clock`);
    } else if (emulation) {
      lines.push(`    fallback: ${emulationLabel(emulation)}`);
    }
  }
  return lines.join('\n');
}


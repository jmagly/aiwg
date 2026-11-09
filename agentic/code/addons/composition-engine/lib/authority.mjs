// Enforces host authority and resolves optional gate actions through signed HITL receipts.
export function createFlowAuthority(manifest, options, evidence, RuntimeError) {
  const allowedCapabilities = new Set(options.allowedCapabilities ?? manifest.spec.capabilities.map((item) => item.id));
  const allowedPermissions = new Set(options.allowedPermissions ?? manifest.spec.permissions);
  const approvedGates = new Set(options.approvedGates ?? []);
  const projectDir = options.projectDir ?? process.cwd();
  // Capture the host-authored plan before any adapter, predicate or event callback runs.
  const actions = new Map(manifest.spec.nodes.filter((node) => node.kind === 'gate' && node.hitlAction)
    .map((node) => [node.id, structuredClone(node.hitlAction)]));

  function requireNotCancelled(gateId) {
    if (new Set(options.cancelledGates ?? []).has(gateId)) {
      throw new RuntimeError('APPROVAL_CANCELLED', `Approval gate '${gateId}' was cancelled.`);
    }
  }

  async function approved(gateId) {
    requireNotCancelled(gateId);
    if (approvedGates.has(gateId)) return true;
    const action = actions.get(gateId);
    if (!action) return false;
    let checked;
    try {
      // Installed npm packages ship dist/src, while checkouts may use src.
      // Load neither the resolver nor policy code for gates without descriptors.
      const { importImpl } = await import('../../../../../tools/_resolve-impl.mjs');
      const { checkHitlAuthorization } = await importImpl(import.meta.url, 'policy/hitl-check.js');
      checked = await checkHitlAuthorization(projectDir, structuredClone(action));
    } catch { requireNotCancelled(gateId); return false; }
    requireNotCancelled(gateId);
    if (checked?.decision !== 'auto-authorized'
      || typeof checked.receipt?.file !== 'string' || !checked.receipt.file
      || typeof checked.receipt.effectId !== 'string' || !checked.receipt.effectId) return false;
    evidence.nodes[gateId] = { ...(evidence.nodes[gateId] ?? {}), authorization: {
      receipt: structuredClone(checked.receipt), provenance: checked.provenance,
      ...(checked.authorizationGrant ? { authorizationGrant: structuredClone(checked.authorizationGrant) } : {}),
    } };
    approvedGates.add(gateId);
    return true;
  }

  return async function enforceAuthority(node) {
    const missingCapability = node.capabilities.find((id) => !allowedCapabilities.has(id));
    if (missingCapability) throw new RuntimeError('CAPABILITY_DENIED', `Node '${node.id}' is not authorized for capability '${missingCapability}'.`);
    const missingPermission = node.permissions.find((id) => !allowedPermissions.has(id));
    if (missingPermission) throw new RuntimeError('PERMISSION_DENIED', `Node '${node.id}' is not authorized for permission '${missingPermission}'.`);
    if (node.kind === 'gate' && !await approved(node.id)) {
      throw new RuntimeError('APPROVAL_REQUIRED', `Gate '${node.id}' has not been approved.`);
    }
    if (node.sideEffectMode === 'approval-required' && !await approved(node.approvalGate)) {
      throw new RuntimeError('APPROVAL_REQUIRED', `Node '${node.id}' is waiting for approval gate '${node.approvalGate}'.`);
    }
  };
}

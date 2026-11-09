---
precedence: critical
overridable: true
activation: kernel
enforcement: critical
---

# Change Control for Network and Identity Changes

**Enforcement Level**: CRITICAL
**Scope**: All network configuration changes, firewall modifications, VLAN changes, DNS updates, and identity provider (IdP) modifications
**Issue**: #491

## Principle

Network and identity infrastructure are shared foundations. An unreviewed change to a firewall rule, VLAN, DNS zone, or IdP realm can cause cascading failures across every service that depends on that infrastructure. All changes to these systems must follow a controlled process.

## Mandatory Rules

1. **Every change requires a tracked issue**: No network or identity change may be executed without a corresponding issue or change record. The issue must be created before work begins, not retroactively.

2. **Impact assessment required**: Every change record must include an impact assessment documenting: affected assets, blast radius, risk level, and dependencies. A change without an impact assessment cannot be approved.

3. **OpsGate approval required**: Changes to production network or identity infrastructure require OpsGate approval before execution. The approver must be someone other than the requestor. Emergency changes may be executed first and approved retroactively within 24 hours, but the change record must still be filed before execution.

4. **Dry-run before apply**: The following change types require a dry-run or validation step before the actual change is applied:
   - Firewall rule changes (verify rule syntax and match expectations)
   - VLAN modifications (verify trunk configuration and host assignments)
   - DNS zone changes (verify record syntax, check for conflicts)
   - IdP realm or client changes (verify configuration in staging first)

5. **Rollback procedure required**: Every change record must include a rollback procedure. If a change cannot be rolled back, this must be explicitly documented and the blast radius assessment must reflect the irreversibility.

6. **Verification steps required**: Every change must include post-change verification steps that confirm the change achieved its intended effect without side effects. Verification must be performed immediately after the change, not deferred.

7. **Change window compliance**: Non-emergency changes to production infrastructure must be executed within an approved maintenance window. The window must be communicated to affected stakeholders in advance.

## Validation

When reviewing or creating network/identity changes:

- [ ] Change record or issue exists before work begins
- [ ] Impact assessment documents blast radius and affected assets
- [ ] Approval obtained from someone other than the requestor
- [ ] Dry-run completed for firewall, VLAN, DNS, or IdP changes
- [ ] Rollback procedure is documented and feasible
- [ ] Post-change verification steps are defined
- [ ] Change is scheduled within an approved window (or marked emergency)

## Rationale

Network and identity changes have outsized blast radius relative to their apparent simplicity. A single misconfigured firewall rule can isolate an entire VLAN. A DNS typo can make services unreachable. An IdP misconfiguration can lock out every user. Controlled change processes ensure these changes are reviewed, tested, reversible, and auditable.

---
precedence: critical
overridable: true
activation: kernel
enforcement: critical
---

# Network Change Blast Radius

**Enforcement Level**: CRITICAL
**Scope**: All network configuration changes — VLAN, firewall, DNS, routing, tunnel, switch, and AP modifications
**Issue**: #777

## Principle

Network infrastructure is shared and hierarchical. A misconfigured VLAN trunk can isolate an entire building. A dropped firewall rule can expose services. A DNS change can make applications unreachable fleet-wide. Every network change carries outsized blast radius relative to the apparent simplicity of the operation. All network changes are classified as CRITICAL blast radius by default and must follow a controlled execution process.

## Mandatory Rules

1. **Every network change requires a tracked issue or change record**: No VLAN, firewall, DNS, routing, or tunnel change may be executed without a corresponding issue or change record created before work begins. Retroactive records are not acceptable except for pre-declared emergencies.

2. **Dry-run or validation required before apply**: The following change types require a validation or simulation step before the change is committed:
   - Firewall rule additions or removals (verify rule syntax; check position in chain)
   - VLAN modifications (verify trunk configuration and DHCP scope before tagging ports)
   - DNS zone changes (verify record syntax with `named-checkzone` or API validation)
   - Routing changes (verify next-hop reachability before modifying the routing table)
   - Tunnel configuration changes (verify route mapping in staging or with dry-run mode)

3. **OpsGate approval required for production changes**: Changes to any production network component require approval from someone other than the requestor before execution. Emergency changes may be applied first and approved within 24 hours, but the change record must be filed before the change begins.

4. **Out-of-band access must be confirmed before switch or firewall changes**: Before applying any change to a switch, router, or firewall that could interrupt management connectivity, confirm that out-of-band access (console, IPMI, serial, or physical) is available. Never proceed without this confirmation.

5. **Rollback procedure required**: Every network change record must include a documented rollback procedure. If a change cannot be rolled back (e.g., permanent IP reassignment with downstream dependencies), this must be stated explicitly and the blast radius assessment must reflect the irreversibility.

6. **Post-change verification is mandatory and immediate**: Verification steps must be executed immediately after the change is applied — not deferred. A change is not complete until verification passes.

7. **No simultaneous changes to adjacent systems**: Do not apply a VLAN change and a firewall change affecting the same segment in the same change window unless both are in the same change record with a combined rollback procedure. Overlapping changes obscure root cause when something breaks.

## Validation Checklist

When creating or reviewing a network change record:

- [ ] Change record or issue exists and was created before work began
- [ ] Impact assessment describes blast radius and lists all affected assets and services
- [ ] Approval obtained from someone other than the requestor (or emergency declaration on file)
- [ ] Dry-run or validation step completed for the change type
- [ ] Out-of-band access confirmed (for switch, router, or firewall changes)
- [ ] Rollback procedure is documented and tested or reviewed for feasibility
- [ ] Post-change verification steps are defined and will be executed immediately
- [ ] Adjacent changes are separated or consolidated with a shared rollback procedure

## Blast Radius Classification Reference

| Change Type | Potential Blast Radius | Minimum Gate |
|-------------|----------------------|-------------|
| VLAN add (new, no hosts) | Low — isolated to new VLAN | Issue + OpsGate |
| VLAN modify or remove | HIGH — may strand existing hosts | Issue + OpsGate + OOB confirmed |
| Trunk port reconfiguration | CRITICAL — may isolate multiple VLANs | Issue + OpsGate + OOB confirmed |
| Firewall rule add (allow) | Medium — expands attack surface | Issue + OpsGate |
| Firewall rule remove (allow) | CRITICAL — may break service flows | Issue + OpsGate + active connection check |
| DNS record add | Low — additive | Issue |
| DNS record modify or remove | HIGH — may break name resolution fleet-wide | Issue + OpsGate |
| Routing change | HIGH — may black-hole traffic | Issue + OpsGate + OOB confirmed |
| Tunnel route add | Medium — additive | Issue + OpsGate |
| Tunnel access policy change | CRITICAL — may lock out users or expose services | Issue + OpsGate |

## Violation Response

If an agent attempts to execute a network change without completing the required pre-conditions, the operation must be blocked. The agent must present the missing checklist items to the operator and await explicit authorization before proceeding. This is a hard stop, not a warning.

## Rationale

Network failures propagate. A misconfigured trunk port does not just break one host — it breaks every VLAN crossing that trunk. A dropped DNS record does not just make one service harder to reach — it silently breaks every client that relies on that record. The controlled change process exists because the time cost of validation is always less than the incident cost of an unreviewed network change.

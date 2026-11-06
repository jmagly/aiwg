---
name: sec-cert-scan
description: Scan all fleet services for TLS certificate expiry and chain validity
trigger: when the operator requests certificate scan, expiry check, or TLS audit
---

# Fleet Certificate Scan

## Purpose

Scan all fleet services for TLS certificate expiry and chain validity. Produce a consolidated report classifying certificates by threshold (HEALTHY, WARNING, BLOCK, INCIDENT, EXPIRED) per the `sec-cert-expiry-gates` rule, with actionable remediation recommendations.

## Workflow

### 1. Inventory Services with TLS

Scan fleet documentation to discover all services using TLS:

- Host profiles (`agentic/code/extensions/sys/templates/host-profile.yaml`) — extract services with TLS ports
- PKI hierarchy document (`templates/pki-hierarchy.yaml`) — identify CA-managed certs
- `cert-lifecycle-record.yaml` files — enumerate tracked certificates

```
Input: Fleet documentation directory or OpsInventory YAML
Output: List of (hostname, service, port, expected_cn, cert_path) tuples
```

Common TLS ports to include when not explicitly documented:

| Port | Service |
|------|---------|
| 443 | HTTPS |
| 636 | LDAPS |
| 993 | IMAPS |
| 995 | POP3S |
| 5432 | PostgreSQL with TLS |
| 6443 | Kubernetes API |
| 8443 | HTTPS alternate |
| 2376 | Docker TLS API |

### 2. Collect Certificate State

For each (host, port) pair, retrieve the TLS certificate chain:

```bash
# Retrieve and display full certificate chain from a live TLS service
echo | openssl s_client \
  -connect {host}:{port} \
  -servername {hostname} \
  -showcerts \
  2>/dev/null

# Extract just the leaf certificate for inspection
echo | openssl s_client -connect {host}:{port} -servername {hostname} 2>/dev/null \
  | openssl x509 -noout -subject -issuer -dates -serial -fingerprint -sha256

# Compute days until expiry
NOT_AFTER=$(echo | openssl s_client -connect {host}:{port} -servername {hostname} 2>/dev/null \
  | openssl x509 -noout -enddate 2>/dev/null | cut -d= -f2)
EXPIRY_EPOCH=$(date -d "$NOT_AFTER" +%s)
NOW_EPOCH=$(date +%s)
DAYS_REMAINING=$(( (EXPIRY_EPOCH - NOW_EPOCH) / 86400 ))
```

For certificates stored as files (collected via SSH):

```bash
# Check certificate file on host
openssl x509 -in {cert_path} -noout -subject -issuer -dates -serial -fingerprint -sha256

# Check all certificates in a directory
for cert in /etc/ssl/certs/*.pem; do
  printf "File: %s\n" "$cert"
  openssl x509 -in "$cert" -noout -subject -enddate 2>/dev/null || echo "PARSE_ERROR"
done
```

### 3. Verify Certificate Chain

For each leaf certificate, verify the chain to the fleet's trusted CA bundle:

```bash
# Verify chain against fleet CA bundle
openssl verify -CAfile {/etc/ssl/certs/org-ca-bundle.pem} \
  -untrusted {intermediate-chain.pem} \
  {leaf-cert.pem}

# Check for common chain issues
echo | openssl s_client -connect {host}:{port} -servername {hostname} 2>&1 \
  | grep -E "Verify return code:|certificate chain"
```

Flag these chain issues for review:
- Self-signed certificate (issuer = subject)
- Chain verification failure (return code != 0)
- Incomplete chain (intermediate not served by the host)
- Certificate CN/SAN mismatch with the hostname used to connect

### 4. Classify Certificates

Apply thresholds from `sec-cert-expiry-gates`:

| Status | Days Remaining | Action Required |
|--------|---------------|-----------------|
| EXPIRED | < 0 | Emergency — immediate renewal |
| INCIDENT | 0–1 | Trigger incident, page on-call |
| BLOCK | 2–7 | Block deployments to affected scope |
| WARNING | 8–30 | Create renewal ticket |
| HEALTHY | > 30 | No action required |

CA certificates use extended thresholds:
- Root CA: WARNING at ≤ 365 days, BLOCK at ≤ 180 days, INCIDENT at ≤ 90 days
- Intermediate CA: WARNING at ≤ 180 days, BLOCK at ≤ 90 days, INCIDENT at ≤ 30 days
- Issuing CA: WARNING at ≤ 90 days, BLOCK at ≤ 30 days, INCIDENT at ≤ 7 days

### 5. Produce Certificate Health Report

Output the following structured report:

```markdown
# Fleet Certificate Scan Report
**Scanned**: {YYYY-MM-DD HH:MM UTC}
**Operator**: {operator}
**Hosts Scanned**: {N}
**Services Scanned**: {N}

## Summary

| Status | Count |
|--------|-------|
| EXPIRED | {N} |
| INCIDENT (<1d) | {N} |
| BLOCK (<7d) | {N} |
| WARNING (<30d) | {N} |
| HEALTHY (>30d) | {N} |
| UNREACHABLE | {N} |
| CHAIN_ERROR | {N} |

## Action Required — EXPIRED and INCIDENT

| Host | Service | Port | Subject CN | Expiry | Days |
|------|---------|------|-----------|--------|------|
| {host} | {service} | {port} | {cn} | {YYYY-MM-DD} | {N} |

## BLOCK — Deployments Blocked

| Host | Service | Port | Subject CN | Expiry | Days |
|------|---------|------|-----------|--------|------|
| {host} | {service} | {port} | {cn} | {YYYY-MM-DD} | {N} |

## WARNING — Schedule Renewal

| Host | Service | Port | Subject CN | Expiry | Days | Renewal Method |
|------|---------|------|-----------|--------|------|----------------|
| {host} | {service} | {port} | {cn} | {YYYY-MM-DD} | {N} | {auto/manual} |

## Chain Errors

| Host | Port | Error | Detail |
|------|------|-------|--------|
| {host} | {port} | {CHAIN_INVALID\|SELF_SIGNED\|SAN_MISMATCH} | {description} |

## Healthy Certificates

| Host | Service | Port | Subject CN | Issuer | Expiry | Days |
|------|---------|------|-----------|--------|--------|------|
| {host} | {service} | {port} | {cn} | {issuer} | {YYYY-MM-DD} | {N} |

## Unreachable Hosts / Services

| Host | Service | Port | Error |
|------|---------|------|-------|
| {host} | {service} | {port} | {connection-refused\|timeout\|dns-failure} |
```

### 6. Remediation Recommendations

For each non-HEALTHY certificate:

- **EXPIRED / INCIDENT**: Identify the CA and renewal method from the `cert-lifecycle-record.yaml`. Initiate renewal immediately. If auto-renewal is configured but failed, diagnose the automation failure.
- **BLOCK**: Alert the operator with the specific deployment scope blocked. Confirm the renewal is scheduled and will complete before the next deployment window.
- **WARNING**: Create or update the renewal tracking ticket. Confirm renewal is scheduled within the warning period.
- **CHAIN_ERROR**: Check whether the intermediate certificate is being served by the host. Verify the CA bundle on the host is current.
- **SAN_MISMATCH**: Verify whether clients are using a hostname not included in the certificate's SAN. Issue a corrected certificate if needed.
- **UNREACHABLE**: Verify the host is online and the port is open. Confirm the service is running. Check firewall rules.

## Output

- `fleet-cert-report-{YYYY-MM-DD}.md` saved to `.aiwg/security/cert-reports/`
- Exit non-zero if any EXPIRED or BLOCK-threshold certificates are found (for CI/cron use)
- Update `cert-lifecycle-record.yaml` files with current state where they exist

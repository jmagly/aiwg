---
precedence: critical
overridable: true
activation: kernel
enforcement: critical
---

# Stream Credential and Configuration Safety

**Enforcement Level**: CRITICAL
**Scope**: All streaming service configurations, deployment files, and documentation
**Issue**: #491

## Principle

Stream keys and platform API tokens are bearer credentials — anyone who possesses them can broadcast to your channels. Leaked stream keys result in unauthorized broadcasts, channel bans, or permanent platform account suspension. Credential management for streaming services requires the same rigor as production database passwords.

## Mandatory Rules

1. **Never commit stream keys or platform tokens**: Stream keys (RTMP keys, SRT passphrases), platform API tokens, and OAuth credentials must never appear in:
   - Git repositories (including private repos)
   - Configuration files tracked by git
   - Documentation (including system-spec and stream-service templates)
   - CI/CD workflow files
   - Docker images or container layers

2. **Separate key storage from configuration**: Stream service configurations must use one of:
   - Environment variable substitution (`${STREAM_KEY}`)
   - External key files referenced by path (not committed)
   - Secret management systems (Vault, SOPS, etc.)
   - systemd `EnvironmentFile=` pointing to a non-committed file

3. **Validate configurations before deployment**: Before starting or restarting a stream service:
   - Verify the configuration file does not contain literal keys
   - Confirm environment variables or key files are populated
   - Test connectivity to input sources and output targets
   - Verify the stream key is valid (test mode if supported by platform)

4. **RTMP/SRT configuration validation**: Before deploying stream relay or ingest configurations:
   - Verify listen addresses are bound to expected interfaces (not 0.0.0.0 unless intentional)
   - Confirm authentication is enabled for ingest endpoints
   - Validate TLS/SSL settings for SRT connections
   - Check that recording paths have appropriate permissions and disk space

5. **Key rotation tracking**: Document when credentials were last rotated and where they are stored. Stale credentials increase the blast radius of any historical leak.

6. **Git history scanning**: Before making a repository public or sharing it, scan git history for accidentally committed stream keys:
   ```bash
   git log -p --all -S 'rtmp://' -- '*.conf' '*.yaml' '*.yml' '*.env'
   ```

## Detection Patterns

Flag any of the following in tracked files:

| Pattern | Risk |
|---------|------|
| `rtmp://...?key=` or `rtmp://...&key=` | Embedded RTMP stream key |
| `srt://...?passphrase=` | Embedded SRT passphrase |
| `stream_key:` followed by non-variable value | Literal key in config |
| Platform-specific key patterns (e.g., `sk_live_`, `rk_`) | Platform API token |
| Base64-encoded strings in stream configs | Possible encoded credential |

## Rationale

Stream keys are uniquely dangerous because exploitation is immediately visible (unauthorized broadcast) and consequences can be permanent (platform bans). Unlike a leaked API key that can be rotated silently, a leaked stream key used for a malicious broadcast can result in channel termination with no recovery path. Prevention is the only reliable strategy.

# AIWG Plugin Marketplace Guide

**Issue:** #282
**Version:** 2026.2.0
**Status:** Active

Search across configured local marketplaces with the [plugin-search guide](plugin-search.md).

## Overview

This guide documents the AIWG plugin marketplace distribution system for Claude Code. In AIWG vocabulary, a plugin is a marketplace delivery wrapper around an extension, addon, or framework payload. The marketplace provides pre-packaged, versioned wrappers that users can install with a single command.

## AIWG Plugin Registry

The AIWG marketplace hosts 4 official packages:

| Plugin | ID | Description | Size | Agents | Commands |
|--------|-----|-------------|------|--------|----------|
| **SDLC Complete** | `sdlc@aiwg` | Full software development lifecycle | ~2.5 MB | 35+ | 31 |
| **Marketing Kit** | `marketing@aiwg` | Complete marketing campaign management | ~1.8 MB | 20+ | 15 |
| **Core Utils** | `utils@aiwg` | Essential AIWG utilities and helpers | ~500 KB | 5 | 10 |
| **Voice Framework** | `voice@aiwg` | Voice profiles and content validation | ~800 KB | 8 | 6 |

**Registry Location:** `https://github.com/jmagly/aiwg`

**Manifest Format:** Claude Code plugin manifest (JSON)

## Installation

### Adding the Marketplace

First-time setup (one-time only):

```bash
# In Claude Code
/plugin marketplace add jmagly/ai-writing-guide
```

This registers the AIWG repository as a plugin source.

### Installing Plugins

Install individual plugins by ID:

```bash
# SDLC framework (most comprehensive)
/plugin install sdlc@aiwg

# Marketing operations
/plugin install marketing@aiwg

# Core utilities (required by most plugins)
/plugin install utils@aiwg

# Voice profiles
/plugin install voice@aiwg
```

### Verification

Check installed plugins:

```bash
# List all installed plugins
/plugin list

# Show plugin details
/plugin info sdlc@aiwg
```

Expected Claude Code output:
```
Installed Plugins:
  ✓ sdlc@aiwg v2026.2.0 (35 agents, 40 commands)
  ✓ utils@aiwg v2026.2.0 (5 agents, 10 commands)

Status: Active
Last Updated: 2026-02-06
```

## SHA Pinning for Security

### Why Pin SHAs

Plugin installations can reference specific git commit SHAs to ensure reproducible builds and prevent supply chain attacks.

**Use SHA pinning when:**
- Production deployments
- Team standardization required
- Security compliance mandates
- Preventing unexpected changes

**Skip SHA pinning for:**
- Personal development
- Rapid experimentation
- Auto-update preferences

### How to Pin

Plugins can specify exact commit SHAs in the manifest:

```json
{
  "id": "sdlc@aiwg",
  "version": "2026.2.0",
  "source": {
    "repository": "https://github.com/jmagly/aiwg",
    "ref": "7529ae7abc123...",  // Full commit SHA
    "type": "commit"
  }
}
```

**Finding the SHA:**

```bash
# Get latest commit SHA
git rev-parse HEAD

# Get SHA for specific version tag
git rev-parse v2026.2.0

# From GitHub
# Navigate to: https://github.com/jmagly/aiwg/commits/main
# Click any commit → copy full SHA from URL
```

### Installing with SHA Pin

```bash
# Install specific commit
/plugin install sdlc@aiwg --sha 7529ae7abc123...

# Or specify in project config
# .claude/plugins.json
{
  "plugins": [
    {
      "id": "sdlc@aiwg",
      "sha": "7529ae7abc123...",
      "auto_update": false
    }
  ]
}
```

### Verifying SHA Integrity

After installation, verify the SHA matches:

```bash
# Check installed plugin SHA
/plugin info sdlc@aiwg --show-sha

# Compare with expected
echo "Expected: 7529ae7abc123..."
echo "Installed: <output from above>"
```

**Integrity Check Workflow:**

1. Team decides on approved SHA
2. Document in `PLUGINS.md` or team wiki
3. All developers install with `--sha` flag
4. CI/CD validates SHA in automated checks
5. Update SHA only after team approval

## Auto-Update Behavior

### Default Behavior

By default, plugins check for updates on:
- Session start
- Manual update command
- Once per 24 hours (cached)

**Update check process:**

1. Query registry for latest version
2. Compare with installed version
3. If newer available, prompt user
4. User approves/declines update
5. If approved, download and install

### Controlling Auto-Update

**Disable for all plugins:**

```json
// .claude/config.json
{
  "plugins": {
    "auto_update": false,
    "check_on_start": false
  }
}
```

**Disable per plugin:**

```json
// .claude/plugins.json
{
  "plugins": [
    {
      "id": "sdlc@aiwg",
      "auto_update": false  // Pin this one
    },
    {
      "id": "utils@aiwg",
      "auto_update": true   // Keep this updated
    }
  ]
}
```

**Manual update only:**

```bash
# Check for updates without installing
/plugin check-updates

# Update specific plugin
/plugin update sdlc@aiwg

# Update all plugins
/plugin update --all
```

### Preventing Unwanted Updates

**Scenario 1: Team standardization**

Problem: Different team members on different versions.

Solution:
```bash
# Lock to specific SHA in team config
# .claude/plugins.json (committed to git)
{
  "plugins": [
    {
      "id": "sdlc@aiwg",
      "sha": "7529ae7abc123...",
      "auto_update": false
    }
  ]
}
```

**Scenario 2: CI/CD reproducibility**

Problem: Builds break due to plugin updates.

Solution:
```bash
# In CI config
- name: Install marketplace packages
  run: |
    /plugin install sdlc@aiwg --sha ${{ vars.AIWG_SDLC_SHA }}
    /plugin config set auto_update false
```

**Scenario 3: Security compliance**

Problem: Need approval process for updates.

Solution:
1. Disable auto-update globally
2. Create approval process:
   - Security team reviews new version
   - Approves specific SHA
   - Updates team config with approved SHA
   - Team updates plugins manually

**Scenario 4: Breaking changes**

Problem: New version introduces incompatible changes.

Solution:
```bash
# Stay on current version
/plugin pin sdlc@aiwg

# Later, when ready to migrate
/plugin unpin sdlc@aiwg
/plugin update sdlc@aiwg

# Test thoroughly, then re-pin
/plugin pin sdlc@aiwg --sha <new-sha>
```

## Publishing Workflow

### Overview

The publishing workflow ensures plugins are tested, versioned correctly, and distributed safely.

**Workflow stages:**

```
1. Prepare Release
   ↓
2. Update SHA Pins
   ↓
3. Test Installation
   ↓
4. Publish to Registry
   ↓
5. Verify Distribution
   ↓
6. Rollback if Needed
```

### 1. Prepare Release

**Before publishing:**

```bash
# Ensure clean working directory
git status

# Run full test suite
npm test

# Validate plugin metadata
aiwg validate-metadata

# Build distribution packages
aiwg package-all-plugins

# Verify package contents
tar -tzf dist/plugins/sdlc.plugin.tar.gz | head -20
```

**Update version:**

```json
// agentic/code/frameworks/sdlc-complete/manifest.json
{
  "id": "sdlc-complete",
  "version": "2026.2.0",  // Bump version
  "claudeCode": {
    "pluginId": "sdlc@aiwg",
    "version": "2026.2.0"   // Match here too
  }
}
```

**Update CHANGELOG:**

```markdown
## [2026.2.0] - 2026-02-06

### Added
- Task management integration
- MCP auto-mode support

### Fixed
- Plugin marketplace SHA pinning
```

### 2. Update SHA Pins

**Commit all changes:**

```bash
git add -A
git commit -m "feat: prepare v2026.2.0 release"
git push origin main
```

**Get commit SHA:**

```bash
# After push, get the commit SHA
RELEASE_SHA=$(git rev-parse HEAD)
echo "Release SHA: $RELEASE_SHA"
```

**Update plugin manifests:**

```json
// agentic/code/frameworks/sdlc-complete/manifest.json
{
  "claudeCode": {
    "source": {
      "repository": "https://github.com/jmagly/aiwg",
      "ref": "7529ae7abc123...",  // Update to $RELEASE_SHA
      "type": "commit"
    }
  }
}
```

**Commit SHA updates:**

```bash
git add agentic/code/*/manifest.json
git commit -m "chore: pin plugin SHAs to release commit"
git push origin main
```

### 3. Test Installation

**Fresh install test:**

```bash
# In a clean test directory
cd /tmp/test-plugin-install

# Start Claude Code session
# Run install command
/plugin marketplace add jmagly/ai-writing-guide
/plugin install sdlc@aiwg

# Verify
/plugin list
/plugin info sdlc@aiwg --show-sha

# Test basic functionality
/intake-wizard "Test project"
```

**Upgrade test:**

```bash
# In project with old version
/plugin update sdlc@aiwg

# Verify upgrade successful
/plugin info sdlc@aiwg
```

**SHA verification:**

```bash
# Verify SHA matches release
/plugin info sdlc@aiwg --show-sha
# Should output: $RELEASE_SHA
```

### 4. Publish to Registry

**Tag release:**

```bash
git tag -a v2026.2.0 -m "Release v2026.2.0"
git push origin v2026.2.0
```

**Create GitHub release:**

```bash
gh release create v2026.2.0 \
  --title "v2026.2.0" \
  --notes "$(cat docs/releases/v2026.2.0-announcement.md)" \
  dist/plugins/*.plugin.tar.gz
```

**Publish to npm (optional):**

```bash
# For npm-based CLI distribution
npm publish
```

### 5. Verify Distribution

**Check release visible:**

```bash
# Via GitHub API
gh release view v2026.2.0

# Via Claude Code (fresh session)
/plugin marketplace list
# Should show v2026.2.0 as latest
```

**Test end-to-end install:**

```bash
# New user flow simulation
/plugin marketplace add jmagly/ai-writing-guide
/plugin install sdlc@aiwg
/plugin info sdlc@aiwg

# Verify version is v2026.2.0
```

**Monitor for issues:**

- Check GitHub issues for install failures
- Monitor Discord/Telegram for reports
- Verify download counts incrementing

### 6. Rollback if Needed

**If critical issue found:**

```bash
# Mark release as draft (hides from marketplace)
gh release edit v2026.2.0 --draft

# Or delete entirely
gh release delete v2026.2.0

# Notify users
gh issue create \
  --title "Plugin v2026.2.0 temporarily unavailable" \
  --body "Critical issue found, please stay on v2026.1.5"
```

**Restore previous version:**

```bash
# Users can downgrade
/plugin uninstall sdlc@aiwg
/plugin install sdlc@aiwg --version v2026.1.5
```

**Fix and republish:**

```bash
# Fix issue
git commit -m "fix: critical plugin issue"
git push origin main

# Create patch release
git tag -a v2026.2.1 -m "Hotfix v2026.2.1"
git push origin v2026.2.1

# Publish with new version
gh release create v2026.2.1 ...
```

## CI/CD Pipeline

### Pre-Publish Validation Checklist

Automate validation before publishing:

```yaml
# .github/workflows/plugin-release.yml
name: Plugin Release Validation

on:
  push:
    tags:
      - 'v*'

jobs:
  validate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Setup Node
        uses: actions/setup-node@v4
        with:
          node-version: '24'

      - name: Install dependencies
        run: npm ci

      - name: Run tests
        run: npm test

      - name: Validate metadata
        run: npx aiwg validate-metadata

      - name: Check version consistency
        run: |
          # Verify package.json matches tag
          TAG_VERSION="${GITHUB_REF#refs/tags/v}"
          PKG_VERSION=$(jq -r .version package.json)
          if [ "$TAG_VERSION" != "$PKG_VERSION" ]; then
            echo "Version mismatch: tag=$TAG_VERSION, package=$PKG_VERSION"
            exit 1
          fi

      - name: Build plugins
        run: npx aiwg package-all-plugins

      - name: Verify plugin packages
        run: |
          for plugin in dist/plugins/*.plugin.tar.gz; do
            echo "Checking $plugin..."
            tar -tzf "$plugin" | grep manifest.json || exit 1
          done

      - name: Test installation
        run: |
          # Simulate plugin install
          mkdir -p /tmp/test-install/.claude/plugins
          tar -xzf dist/plugins/sdlc.plugin.tar.gz -C /tmp/test-install/.claude/plugins
          test -f /tmp/test-install/.claude/plugins/sdlc@aiwg/manifest.json

  publish:
    needs: validate
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Create GitHub Release
        uses: softprops/action-gh-release@v1
        with:
          files: dist/plugins/*.plugin.tar.gz
          body_path: docs/releases/${{ github.ref_name }}-announcement.md
```

### Validation Checklist

**Pre-flight checks:**

- [ ] All tests passing
- [ ] Metadata validation clean
- [ ] Version numbers consistent
- [ ] CHANGELOG updated
- [ ] Release docs created
- [ ] No uncommitted changes
- [ ] Main branch up to date

**Build checks:**

- [ ] All plugins build successfully
- [ ] Package sizes reasonable (<5 MB each)
- [ ] Manifest files present
- [ ] README and LICENSE included
- [ ] No sensitive data in packages

**Distribution checks:**

- [ ] SHA pins updated
- [ ] Git tag created
- [ ] GitHub release published
- [ ] npm published (if applicable)
- [ ] Release notes accurate

**Post-publish checks:**

- [ ] Test install works
- [ ] Test upgrade works
- [ ] SHA verification passes
- [ ] Basic functionality works
- [ ] No critical issues reported (24h)

## Troubleshooting

### Installation Fails

**Problem:** Plugin install command fails

**Diagnosis:**

```bash
# Check marketplace connection
/plugin marketplace list

# Verify repository access
curl -I https://github.com/jmagly/aiwg

# Check plugin availability
/plugin search aiwg
```

**Solutions:**

1. Marketplace not added:
   ```bash
   /plugin marketplace add jmagly/ai-writing-guide
   ```

2. Network issues:
   ```bash
   # Try direct install
   /plugin install https://github.com/jmagly/aiwg --plugin sdlc
   ```

3. Plugin not found:
   ```bash
   # Check exact plugin ID
   /plugin marketplace list | grep aiwg
   ```

### SHA Mismatch

**Problem:** Installed SHA doesn't match expected

**Diagnosis:**

```bash
/plugin info sdlc@aiwg --show-sha
# Compare with expected SHA
```

**Solutions:**

1. Reinstall with explicit SHA:
   ```bash
   /plugin uninstall sdlc@aiwg
   /plugin install sdlc@aiwg --sha <expected-sha>
   ```

2. Verify source:
   ```bash
   # Check manifest source
   cat ~/.claude/plugins/sdlc@aiwg/manifest.json | jq .source
   ```

### Auto-Update Conflicts

**Problem:** Plugin updates unexpectedly, breaks workflow

**Solution:**

```bash
# Disable auto-update
/plugin config set auto_update false

# Pin to working version
/plugin install sdlc@aiwg --sha <working-sha>

# Verify pinned
/plugin info sdlc@aiwg
```

## Best Practices

### For Users

1. **Pin SHAs in production** - Use explicit SHAs for critical projects
2. **Test updates in dev** - Always test plugin updates before rolling out
3. **Document your versions** - Track which SHAs your team uses
4. **Disable auto-update for stability** - Manual updates give you control

### For Publishers

1. **Always test before release** - Run full validation suite
2. **Use semantic versioning** - Follow CalVer consistently
3. **Update SHAs after commit** - Never reference uncommitted code
4. **Include rollback plan** - Know how to unpublish if needed
5. **Monitor post-release** - Watch for issues in first 24h

### For Teams

1. **Standardize plugin versions** - Use shared config in git
2. **Document approval process** - Who can approve updates?
3. **Test updates together** - Coordinate version bumps
4. **Keep audit trail** - Log when/why plugins updated

## References

- @.claude/rules/versioning.md - CalVer versioning rules
- @docs/cli/reference.md - CLI command reference
- @CLAUDE.md - Project-level installation guide
- @agentic/code/frameworks/sdlc-complete/manifest.json - Manifest example
- Issue #282 - Plugin marketplace verification

---

**Guide Version:** 2026.2.0
**Last Updated:** 2026-02-06
**Maintainer:** AIWG Team

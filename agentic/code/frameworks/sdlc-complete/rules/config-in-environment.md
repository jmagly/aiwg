---
enforcement: medium
name: config-in-environment
severity: MEDIUM
category: configuration
factor: 12-factor-III
activation: "bound"
summary: "Store environment-varying configuration outside source; centralize and validate startup reads, document variables, and load secrets from managers or referenced files."
bound_to:
  agents: ["cloud-architect", "deployment-manager", "devops-engineer", "security-auditor", "software-implementer"]
  skills: ["build-poc", "flow-deploy-to-production", "flow-release"]
  flows: ["flow-deploy-to-production", "flow-release"]
triggers:
  - "store deployment configuration in environment"
  - "validate environment variables at startup"
  - "document environment config and secret files"
---

# Config in the Environment

**Enforcement Level**: MEDIUM
## Rule

Deploy-time configuration values that differ between deployment environments (dev, staging, production) must be stored in environment variables, not in source code or checked-in config files.

**Why:** Deploy-time configuration that varies between environments is by definition environment-specific. Storing it in code produces one of three bad outcomes: (1) env-specific branches in source, (2) separate builds per environment (violates Factor V build/run separation), or (3) secrets accidentally committed.

**How to apply:**

### What belongs in environment variables
- Backing service URLs (database, cache, queue, external APIs)
- Credentials and tokens (already covered by `token-security.md`)
- Deploy-time release toggle settings that differ per environment
- Resource limits (thread pool size, connection pool size)
- Log level and observability endpoints
- Environment identity itself (`APP_ENV=production`)

### What does NOT belong in environment variables
- Business logic constants (tax rates, timeout constants that never differ per env)
- Code structure decisions (these are source code)
- Configuration-as-code for infrastructure (Terraform, Pulumi) — that's a separate concern

### Feature flags versus deploy-time configuration

Deploy-time configuration stays in environment variables ([12-Factor](https://12factor.net/config)).
Decisions that must change at runtime or per request go to the flag provider
([Unleash](https://docs.getunleash.io/guides/feature-flag-best-practices.md)). Static release toggles may stay in source or
config when no runtime change is needed ([Hodgson: prefer static configuration](https://martinfowler.com/articles/feature-toggles.html));
never use a flag provider as a store for ordinary static/rarely changing settings
([technical debt](https://launchdarkly.com/docs/guides/flags/technical-debt.md)). Provider selection alone does not move all config to flags.

### How to consume
- Read env vars at startup (fail-fast if required vars missing)
- Validate types and ranges (URL is parseable, port is a number, etc.)
- Provide a `.env.example` file at project root documenting every env var used
- Use a config object/struct that centralizes all env reads (no scattered `os.getenv` calls)

### Secrets within config
- Follow `rules/token-security.md` — secrets load from secret managers or files referenced by env vars, not directly from env
- Example: `DATABASE_URL_FILE=/run/secrets/db_url` rather than `DATABASE_URL=postgres://...` in the orchestrator

## What to check

1. **`.env.example` exists at project root** and lists every env var the application reads
2. **No hardcoded URLs, hostnames, or ports** in source files (exception: defaults for local dev marked as such)
3. **No per-environment branches** like `if APP_ENV == "production"` scattered in business logic (use the config object instead)
4. **Config validation at startup** — app fails fast if required env vars are missing or malformed
5. **Documentation**: every env var has a description in `.env.example` or `deployment-environment-template.md`

## Acceptable deviations (require ADR)

- **Library defaults for optional settings** — hardcoding a reasonable default is fine; document why in code
- **Build-time configuration** (feature compile flags for native binaries) — different mechanism, justify why env vars won't work
- **Legacy code being migrated** — temporary, with explicit remediation plan

## Related

- Factor III (config) — https://12factor.net/config
- `rules/token-security.md` — secrets handling (covers the subset that are credentials)
- `rules/stateless-processes.md` — processes depend on env config to be interchangeable
- Issue #821 — 12-factor gap analysis

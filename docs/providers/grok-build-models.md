# Grok Build model discovery and role policy

Grok Build is the CLI and agent harness (`--provider grok-build`). Its model
aliases are selectors passed to that harness. An alias such as `my-model` may
map to a different API `model` ID at a custom OpenAI-compatible endpoint.
`grok-build-0.1`, `grok-4.6`, and similar API names are not automatically
Grok Build provider IDs or verified selectors.

Run `aiwg models sources --provider grok-build --json` to inspect active
configuration layers, observed aliases, credential availability, and the
provenance of selected values. `aiwg models audit --provider grok-build --json`
and `aiwg models resolve --provider grok-build --role coding --json` include
the same provenance plus role resolution. Use `--model <observed-alias>` for an
explicit read-only override. An unknown alias fails with a diagnostic. When
exactly one alias is discovered and no mapping is configured, all three roles
inherit that alias. When multiple aliases are available, configure each role
or select one explicitly; AIWG never guesses an xAI API ID.

Configure project-specific AIWG role policy in `models.json`:

```json
{
  "providers": {
    "grok-build": {
      "reasoning": "my-reasoning-alias",
      "coding": "my-coding-alias",
      "efficiency": "my-efficient-alias"
    }
  }
}
```

Configure actual Grok model aliases in `$GROK_HOME/config.toml` (default
`~/.grok/config.toml`), for example `[model.my-coding-alias]` with `model`,
`base_url`, and `env_key` fields. AIWG reads `grok inspect --json` first to
discover which configuration files the installed runtime actually loaded.
Current InspectReport versions list config sources without effective model
values, so AIWG reads only relevant model fields from those reported files.
It does not read credential values, API keys, extra header values, or endpoint
URLs into audit output. Native command stderr is classified without echoing it.
If Grok reports no model aliases or defaults, AIWG reports unresolved rather
than claiming its built-in catalog or a marketing model ID is installed.

The Grok configuration order is compiled defaults, system managed, user
managed, user config, project config, environment config overlay, user
requirements, system requirements, environment variables, then CLI flags.
The later ordinary value wins, while requirements `models.default` and
`models.allowed_models` are policy constraints that cannot be overridden.
Only Grok's supported MCP, plugin, permission, and MCP output-size settings
are accepted from project `.grok/config.toml`; project model sections are
ignored and flagged. `$GROK_HOME` is used consistently for user config and
requirements. AIWG does not write any Grok model or requirements config.

`grok inspect --json` may change shape across CLI versions. AIWG reports an
explicit version-drift error if config sources disappear. Models requiring a
named credential show only `available` or `unavailable`; actual endpoint
access still depends on Grok's runtime authentication and network state.

Sources: [Grok Build settings](https://docs.x.ai/build/settings),
[enterprise configuration](https://docs.x.ai/build/enterprise), and
[Grok Build overview](https://docs.x.ai/build/overview).

# Offline SDK fixtures

Run only where the official SDKs are already installed; these scripts do not
install packages or load any secret. Do not replace missing SDKs with a stub:

- `node ${CLAUDE_PLUGIN_ROOT}/fixtures/sdk-node.mjs`
- `python3 ${CLAUDE_PLUGIN_ROOT}/fixtures/sdk-python.py`

API source: [TestData](https://launchdarkly.com/docs/sdk/features/test-data-sources.md),
last verified 2026-11-25. AIWG guidance: use test-only data, disable event delivery,
assert both states and fallback, bound initialization and close in finally.
Never label the separate host-hook fixture suite as actual SDK validation.
Node/Python lifecycle signatures require verification against installed SDK versions.

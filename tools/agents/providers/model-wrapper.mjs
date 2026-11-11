// Apply canonical wrapper pins and read-only controls after each provider's native translation.
import { load, dump } from 'js-yaml';
import { importImpl } from '../../_resolve-impl.mjs';
const { MODEL_WRAPPER_DEFINITIONS } = await importImpl(import.meta.url, 'models/wrapper-definitions.js');
// These TypeScript graphs import siblings by their compiled .js names, so they
// load only from dist/. Run `npm run build:cli` before using a checkout's tools.
async function compiled(module) {
  try { return await importImpl(import.meta.url, module); }
  catch (error) {
    if (error?.code !== 'ERR_MODULE_NOT_FOUND') throw error;
    throw Object.assign(new Error(`provider translators need the compiled ${module} from dist/; run \`npm run build:cli\` first (${error.message})`),
      { code: 'AIWG_BUILD_REQUIRED', cause: error });
  }
}
const { loadProviderModelCatalog } = await compiled('models/catalog-policy.js');
const { resolveWrapperPin } = await compiled('models/wrapper-enforcement.js');

function parse(content) {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  return match ? { metadata: load(match[1]) || {}, body: match[2] } : null;
}

/** Ordinary agents retain their provider translator; only the five canonical wrappers opt in. */
export function withModelWrapper(provider, translate) {
  return (source, content, opts = {}) => {
    const parsed = parse(content);
    const wrapper = MODEL_WRAPPER_DEFINITIONS.find(item => item.name === parsed?.metadata.name);
    if (!wrapper) return translate(source, content, opts);
    const catalog = opts.modelCatalog || loadProviderModelCatalog();
    const config = opts.modelsConfig?.[provider]?.[wrapper.role];
    const sourceModel = parsed.metadata.model;
    const override = parsed.metadata['model-override'] || opts[`${wrapper.role}Model`]
      || config?.model || (sourceModel && !['opus', 'sonnet', 'haiku', 'inherit', 'auto'].includes(sourceModel) ? sourceModel : undefined);
    // Reuse #2643 election checks, including catalog entries marked user-elected.
    // Wrappers never supply election authority, even if a parent session has it.
    const effort = parsed.metadata['model-effort'] || parsed.metadata.model_reasoning_effort
      || parsed.metadata.reasoningEffort || parsed.metadata.thinkingLevel || parsed.metadata.effort
      || config?.reasoningEffort;
    const { tier, role, model: pin, effort: nativeEffort, controls, enforcement } =
      resolveWrapperPin(provider, wrapper, { catalog, override, effort });
    // Legacy translators read a single tools line; normalize YAML lists before mapping.
    const toolList = parsed.metadata.tools;
    const normalized = Array.isArray(toolList) && ['antigravity', 'copilot', 'factory', 'windsurf'].includes(provider)
      ? content.replace(/^tools:[^\n]*(?:\n[ \t]+- [^\n]*)*/m,
        `tools: ${provider === 'antigravity' ? `[${toolList.join(', ')}]` : JSON.stringify(toolList)}`)
      : content;
    const mapped = translate(source, normalized, opts);
    const notice = `AIWG wrapper tier: ${tier}; catalog role: ${role}. `
      + `Tier enforcement: ${enforcement}; effort: ${nativeEffort ? `pinned (${nativeEffort})` : 'not enforced per wrapper'}. `
      + (pin ? `Model selector: ${pin}.` : 'The automatic selector is not a model pin. Model control is inherited or informational; stop unless the conductor confirms the required non-flagship session.');
    if (provider === 'codex') {
      let output = mapped.replace(/^model = .*$/m, `model = ${JSON.stringify(pin)}`);
      if (!pin) throw new Error(`${source}: Codex wrapper needs a catalog model pin`);
      output = output.replace(/^model_reasoning_effort = .*$/m, `model_reasoning_effort = ${JSON.stringify(nativeEffort)}`);
      output = output.replace(/^developer_instructions = (.*)$/m, (_line, value) =>
        `developer_instructions = ${JSON.stringify(`${notice}\n\n${JSON.parse(value)}`)}`);
      if (wrapper.readOnly) output += 'sandbox_mode = "read-only"\n';
      return output;
    }
    const target = parse(mapped);
    if (!target) return `${mapped.trim()}\n\n${notice}\n`;
    const metadata = target.metadata;
    if (pin) metadata[controls.model] = pin;
    else delete metadata.model;
    // Portable input aliases are not provider controls. Emit only the resolved native field.
    for (const key of ['effort', 'model-effort', 'model_reasoning_effort', 'reasoningEffort', 'thinkingLevel']) {
      if (key !== controls.effort || !nativeEffort) delete metadata[key];
    }
    if (nativeEffort) metadata[controls.effort] = nativeEffort;
    if (metadata['model-tier']) metadata['model-tier'] = tier;
    if (wrapper.readOnly) {
      if (provider === 'opencode') {
        // OpenCode uses permission rules rather than a tools list. Unknown tools deny.
        metadata.permission = { '*': 'deny', read: 'allow', grep: 'allow', glob: 'allow',
          bash: 'ask', edit: 'deny', task: 'deny' };
      } else if (provider === 'cursor') metadata.readonly = true;
      else if (provider === 'claude') metadata.disallowedTools = ['Write', 'Edit', 'Task', 'Agent'];
    }
    let header = dump(metadata, { lineWidth: -1, noRefs: true });
    // Keep the translator's own tools line (Factory JSON, Copilot quoted list);
    // the wrapper never changes tools, and a block list breaks those formats.
    const nativeHeader = mapped.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/)?.[1] ?? '';
    const nativeTools = nativeHeader.match(/^tools:[^\n]*(?:\n[ \t]+- [^\n]*)*/m)?.[0];
    if (nativeTools) header = header.replace(/^tools:[^\n]*(?:\n[ \t]+- [^\n]*)*/m, () => nativeTools);
    return `---\n${header}---\n\n${notice}\n\n${target.body.trim()}\n`;
  };
}

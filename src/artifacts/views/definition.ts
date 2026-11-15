/**
 * View definition parser and validator.
 *
 * @implements #1207
 * @see docs/architecture/index-and-manifest-loading.md
 */

import { load as loadYaml, dump as dumpYaml } from 'js-yaml';
import type {
  AggregateStrategy,
  Producer,
  RefreshSchedule,
  ViewDefinition,
} from './types.js';

const VALID_AGGREGATES: AggregateStrategy[] = [
  'concat',
  'summarize',
  'filter-true',
  'filter-false',
  'json-merge',
];

const VALID_PRODUCERS: Producer[] = ['rlm-batch', 'rlm-query'];

const VALID_SCHEDULES: RefreshSchedule[] = ['never', 'daily', 'weekly', 'monthly'];

const NAME_RE = /^[a-z0-9][a-z0-9-_]*$/;

export class ViewValidationError extends Error {
  constructor(public readonly issues: string[]) {
    super(`Invalid view definition:\n  - ${issues.join('\n  - ')}`);
    this.name = 'ViewValidationError';
  }
}

/** Parse a YAML string and validate as a ViewDefinition. Throws on failure. */
export function parseViewYaml(yaml: string): ViewDefinition {
  const raw = loadYaml(yaml);
  return validate(raw);
}

/** Validate an arbitrary value as a ViewDefinition. Throws ViewValidationError. */
export function validate(value: unknown): ViewDefinition {
  const issues: string[] = [];
  const v = (value ?? {}) as Record<string, unknown>;

  if (typeof v['name'] !== 'string' || !NAME_RE.test(v['name'])) {
    issues.push("'name' must be a kebab-case string [a-z0-9-_]");
  }
  if (typeof v['prompt'] !== 'string' || v['prompt'].trim().length === 0) {
    issues.push("'prompt' must be a non-empty string");
  }

  const producer = v['producer'];
  if (typeof producer !== 'string' || !VALID_PRODUCERS.includes(producer as Producer)) {
    issues.push(`'producer' must be one of: ${VALID_PRODUCERS.join(', ')}`);
  }

  const aggregate = v['aggregate'];
  if (typeof aggregate !== 'string' || !VALID_AGGREGATES.includes(aggregate as AggregateStrategy)) {
    issues.push(`'aggregate' must be one of: ${VALID_AGGREGATES.join(', ')}`);
  }

  const inputs = (v['inputs'] ?? {}) as Record<string, unknown>;
  const inputModes = ['glob', 'query', 'neighbors-of', 'neighborsOf'].filter(
    (k) => k in inputs,
  );
  if (inputModes.length === 0) {
    issues.push("'inputs' must specify exactly one of: glob, query, neighbors-of");
  } else if (inputModes.length > 1) {
    issues.push(
      `'inputs' must specify exactly one mode (got: ${inputModes.join(', ')})`,
    );
  }

  if (inputs['glob'] !== undefined && typeof inputs['glob'] !== 'string') {
    issues.push("'inputs.glob' must be a string");
  }
  if (inputs['query'] !== undefined && typeof inputs['query'] !== 'string') {
    issues.push("'inputs.query' must be a string");
  }
  const neighbors = (inputs['neighbors-of'] ?? inputs['neighborsOf']) as
    | Record<string, unknown>
    | undefined;
  if (neighbors !== undefined) {
    if (typeof neighbors !== 'object' || neighbors === null) {
      issues.push("'inputs.neighbors-of' must be an object with {id, depth, direction}");
    } else {
      if (typeof neighbors['id'] !== 'string') issues.push("'inputs.neighbors-of.id' is required");
      const depth = neighbors['depth'];
      if (typeof depth !== 'number' || depth < 1) {
        issues.push("'inputs.neighbors-of.depth' must be a positive integer (default 1)");
      }
      const direction = neighbors['direction'];
      if (
        direction !== undefined &&
        direction !== 'in' &&
        direction !== 'out' &&
        direction !== 'both'
      ) {
        issues.push("'inputs.neighbors-of.direction' must be one of: in, out, both");
      }
    }
  }

  const refresh = (v['refresh'] ?? {}) as Record<string, unknown>;
  const onArtifactChange = refresh['on_artifact_change'] ?? refresh['onArtifactChange'];
  if (onArtifactChange !== undefined && typeof onArtifactChange !== 'boolean') {
    issues.push("'refresh.on_artifact_change' must be boolean");
  }
  const schedule = refresh['schedule'];
  if (schedule !== undefined && !VALID_SCHEDULES.includes(schedule as RefreshSchedule)) {
    issues.push(`'refresh.schedule' must be one of: ${VALID_SCHEDULES.join(', ')}`);
  }
  const manualOnly = refresh['manual_only'] ?? refresh['manualOnly'];
  if (manualOnly !== undefined && typeof manualOnly !== 'boolean') {
    issues.push("'refresh.manual_only' must be boolean");
  }

  const outputFormat = v['output_format'] ?? v['outputFormat'] ?? 'json';
  if (
    outputFormat !== 'json' &&
    outputFormat !== 'markdown' &&
    outputFormat !== 'text'
  ) {
    issues.push("'output_format' must be one of: json, markdown, text");
  }

  if (issues.length > 0) {
    throw new ViewValidationError(issues);
  }

  // Normalize the inputs into the canonical TS shape
  const canonicalInputs: ViewDefinition['inputs'] = {};
  if (typeof inputs['glob'] === 'string') canonicalInputs.glob = inputs['glob'];
  if (typeof inputs['query'] === 'string') canonicalInputs.query = inputs['query'];
  if (neighbors) {
    canonicalInputs.neighborsOf = {
      id:        neighbors['id'] as string,
      depth:     (neighbors['depth'] as number) ?? 1,
      direction: ((neighbors['direction'] as 'in' | 'out' | 'both') ?? 'both'),
      ...(typeof neighbors['graph'] === 'string' ? { graph: neighbors['graph'] as string } : {}),
    };
  }

  return {
    name:         v['name'] as string,
    description:  typeof v['description'] === 'string' ? (v['description'] as string) : undefined,
    producer:     producer as Producer,
    inputs:       canonicalInputs,
    prompt:       v['prompt'] as string,
    aggregate:    aggregate as AggregateStrategy,
    refresh: {
      onArtifactChange: typeof onArtifactChange === 'boolean' ? onArtifactChange : true,
      schedule:         (schedule as RefreshSchedule) ?? 'never',
      manualOnly:       typeof manualOnly === 'boolean' ? manualOnly : false,
    },
    outputFormat: (outputFormat as 'json' | 'markdown' | 'text') ?? 'json',
  };
}

/** Render a ViewDefinition back to canonical YAML. */
export function dumpViewYaml(def: ViewDefinition): string {
  const out: Record<string, unknown> = {
    name:        def.name,
    ...(def.description ? { description: def.description } : {}),
    producer:    def.producer,
    inputs:      renderInputs(def.inputs),
    prompt:      def.prompt,
    aggregate:   def.aggregate,
    refresh: {
      on_artifact_change: def.refresh.onArtifactChange,
      schedule:           def.refresh.schedule,
      manual_only:        def.refresh.manualOnly,
    },
    output_format: def.outputFormat,
  };
  return dumpYaml(out, { lineWidth: 100, noRefs: true });
}

function renderInputs(inputs: ViewDefinition['inputs']): Record<string, unknown> {
  if (inputs.glob) return { glob: inputs.glob };
  if (inputs.query) return { query: inputs.query };
  if (inputs.neighborsOf) {
    return {
      'neighbors-of': {
        id:        inputs.neighborsOf.id,
        depth:     inputs.neighborsOf.depth,
        direction: inputs.neighborsOf.direction,
        ...(inputs.neighborsOf.graph ? { graph: inputs.neighborsOf.graph } : {}),
      },
    };
  }
  return {};
}

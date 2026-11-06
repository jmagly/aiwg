// Shape template relationships consistently for show, discover, and prompt lookup.
import { discoveryIdForEntry } from './query-engine-entries.js';
import type { RelationsReader, RelationTargetType } from './relations.js';
import type { MetadataEntry } from './types.js';

export interface TemplateRelationDescriptor {
  id: string;
  type: string;
  name: string;
  path?: string;
  title: string;
  show_command: string;
}

export function templateRelationFields(entry: MetadataEntry, reader?: RelationsReader | null, limit = Infinity, includePaths = true): {
  templates?: TemplateRelationDescriptor[];
  used_by?: TemplateRelationDescriptor[];
} {
  if (!reader) return {};
  const describe = (type: string, id: string, item: { name: string; path: string; title?: string }): TemplateRelationDescriptor => {
    const aliases = type === 'template' ? reader.index.aliases.templates?.[item.name]
      : reader.index.aliases.targets[`${type}:${item.name}`];
    const selector = aliases?.length === 1 && /^[a-zA-Z0-9][a-zA-Z0-9_.:-]*$/.test(item.name) ? item.name : id;
    return { id, type, name: item.name, ...(includePaths ? { path: item.path } : {}), title: item.title ?? item.name,
      show_command: `aiwg show ${type} ${selector}` };
  };
  const id = discoveryIdForEntry(entry);
  if (entry.type === 'template') {
    return { used_by: reader.targetsForTemplate(id).flatMap(target => {
      const item = reader.index.targets[`${target.type}:${target.id}`];
      return item ? [describe(target.type, target.id, { ...item, title: reader.index.artifacts?.[target.id]?.title })] : [];
    }) };
  }
  if (!['skill', 'agent', 'flow', 'command'].includes(entry.type)) return {};
  return { templates: reader.templatesForTarget(entry.type as RelationTargetType, id).slice(0, limit).flatMap(templateId => {
    const template = reader.index.templates?.[templateId];
    return template ? [describe('template', templateId, template)] : [];
  }) };
}

export function templateRelationLines(fields: ReturnType<typeof templateRelationFields>): string[] {
  return Object.entries(fields).filter(([, items]) => items?.length).flatMap(([key, items]) => [
    `\n## ${key === 'templates' ? 'Templates' : 'Used by'}`,
    ...items!.map(item => `- ${item.name} (${item.type}): ${item.title} — \`${item.show_command}\``),
  ]);
}

// Extend validation's existing batch entry point with explicit campaign comparisons.
import { readFile } from 'node:fs/promises';
import { maskProse } from './prose-mask.js';
import { checkCampaignSize, scanCampaignPatterns } from './campaign-patterns.js';
import { diagnoseWritingBatch } from './contextual-diagnostics.js';
import type { WritingValidationEngine, ValidationResult } from './validation-engine.js';
import type { ValidationContext } from './validation-rules.js';

export async function validateCampaign(engine: WritingValidationEngine, files: string[], context?: ValidationContext): Promise<Map<string, ValidationResult>> {
  checkCampaignSize(files.length);
  const documents = await Promise.all(files.map(async id => ({ id, content: await readFile(id, 'utf8') })));
  const campaign = scanCampaignPatterns(documents.map(d => ({ ...d, content: maskProse(d.content) })));
  const diagnostics = diagnoseWritingBatch(documents, { cross: true });
  const results = new Map<string, ValidationResult>();
  for (const d of documents) {
    const result = await engine.validate(d.content, context, campaign.get(d.id));
    const assisted = result.contextualDiagnostics!.diagnostics.filter(f => f.confidence.kind === 'model-assisted');
    result.contextualDiagnostics = diagnostics.get(d.id);
    result.contextualDiagnostics!.diagnostics.push(...assisted);
    result.contextualDiagnostics!.diagnostics.sort((a, b) => a.start - b.start || a.end - b.end || a.ruleId.localeCompare(b.ruleId));
    results.set(d.id, result);
  }
  return results;
}

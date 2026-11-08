import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { parseFrontmatter } from '../../../tools/agents/providers/base-frontmatter.mjs';
import { renderAgentToml } from '../../../tools/agents/providers/codex.mjs';

const models = {
  reasoning: 'gpt-5.4',
  coding: 'gpt-5.5',
  efficiency: 'gpt-5.4-mini',
};

const lfSource = [
  '---',
  'name: reviewer',
  'description: Reviews code changes',
  'model: claude-opus-4-7',
  'model-effort: high',
  '---',
  '',
  'Inspect the changes and report concrete risks.',
  '',
].join('\n');

const crlfSource = lfSource.replace(/\n/g, '\r\n');
const expectedToml = [
  'name = "reviewer"',
  'description = "Reviews code changes"',
  'developer_instructions = "Inspect the changes and report concrete risks."',
  'model = "gpt-5.4"',
  'model_reasoning_effort = "high"',
  '',
].join('\n');

const actualAgentPath = fileURLToPath(new URL(
  '../../../agentic/code/frameworks/sdlc-complete/agents/accessibility-specialist.md',
  import.meta.url,
));
const actualAgent = readFileSync(actualAgentPath, 'utf8');

describe('shared provider frontmatter line endings', () => {
  it('preserves LF parsing and metadata extraction', () => {
    const parsed = parseFrontmatter(lfSource);

    expect(parsed.frontmatter).toBe([
      'name: reviewer',
      'description: Reviews code changes',
      'model: claude-opus-4-7',
      'model-effort: high',
    ].join('\n'));
    expect(parsed.metadata).toEqual({
      name: 'reviewer',
      description: 'Reviews code changes',
      model: 'claude-opus-4-7',
    });
    expect(renderAgentToml('/tmp/reviewer.md', lfSource, models)).toBe(expectedToml);
  });

  it('parses CRLF frontmatter and preserves the body line endings', () => {
    const parsed = parseFrontmatter(crlfSource);

    expect(parsed.frontmatter).toBe([
      'name: reviewer',
      'description: Reviews code changes',
      'model: claude-opus-4-7',
      'model-effort: high',
    ].join('\n'));
    expect(parsed.metadata).toMatchObject({
      name: 'reviewer',
      description: 'Reviews code changes',
      model: 'claude-opus-4-7',
    });
    expect(parsed.body).toBe('\r\nInspect the changes and report concrete risks.\r\n');
    expect(renderAgentToml('/tmp/reviewer.md', crlfSource, models)).toBe(expectedToml);
  });

  it('normalizes mixed LF and CRLF only inside captured YAML frontmatter', () => {
    const mixed = [
      '---\r\n',
      'name: mixed\n',
      'description: Mixed line endings\r\n',
      'model: claude-opus-4-7\n',
      'model-effort: high\r\n',
      '---\n',
      '\r\nInstructions stay CRLF.\r\n',
    ].join('');
    const parsed = parseFrontmatter(mixed);

    expect(parsed.frontmatter).toBe([
      'name: mixed',
      'description: Mixed line endings',
      'model: claude-opus-4-7',
      'model-effort: high',
    ].join('\n'));
    expect(parsed.metadata).toMatchObject({
      name: 'mixed',
      description: 'Mixed line endings',
      model: 'claude-opus-4-7',
    });
    expect(parsed.body).toBe('\r\nInstructions stay CRLF.\r\n');
  });

  it('returns the whole input as body when frontmatter is missing', () => {
    const body = 'Plain Markdown without metadata.\n';
    expect(parseFrontmatter(body)).toEqual({ frontmatter: null, body, metadata: {} });
    expect(() => renderAgentToml('/tmp/missing.md', body, models)).toThrow('missing YAML frontmatter');
  });

  it.each([
    ['malformed opening delimiter', '--\nname: reviewer\n---\nBody\n'],
    ['malformed closing delimiter', '---\nname: reviewer\n--\nBody\n'],
    ['lone-CR delimiters remain unsupported', '---\rname: reviewer\r---\rBody\r'],
  ])('rejects %s without relaxing delimiter validation', (_label, input) => {
    expect(parseFrontmatter(input)).toEqual({ frontmatter: null, body: input, metadata: {} });
  });

  it('recognizes empty delimiters but keeps Codex validation strict', () => {
    const empty = '---\r\n\r\n---\r\nBody\r\n';
    const parsed = parseFrontmatter(empty);

    expect(parsed).toEqual({ frontmatter: '', body: 'Body\r\n', metadata: {} });
    expect(() => renderAgentToml('/tmp/empty.md', empty, models)).toThrow('missing YAML frontmatter');
  });

  it('parses and renders the real accessibility specialist agent', () => {
    const parsed = parseFrontmatter(actualAgent);

    expect(parsed.frontmatter).not.toBeNull();
    expect(parsed.metadata).toMatchObject({ name: 'Accessibility Specialist' });
    expect(parsed.frontmatter).toContain('description: Web accessibility compliance expert.');

    const rendered = renderAgentToml(actualAgentPath, actualAgent, models);
    expect(rendered).toContain('name = "Accessibility Specialist"');
    expect(rendered).toContain('description = ');
    expect(rendered).toContain('developer_instructions = ');
  });
});

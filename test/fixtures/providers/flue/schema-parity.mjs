// Compare the public input projections against authoritative MCP tools/list schemas.
import assert from 'node:assert/strict';

function normalized(schema) {
  if (Array.isArray(schema)) return schema.map(normalized);
  if (!schema || typeof schema !== 'object') return schema;
  return Object.fromEntries(Object.entries(schema)
    .filter(([key]) => !['description', '$schema'].includes(key))
    .map(([key, value]) => [key, normalized(value)]));
}

export function assertSchemaParity(inputs, listing) {
  const schemas = Object.fromEntries(listing.map(tool => [tool.name, tool.inputSchema]));
  const discover = schemas.discover;
  const shown = ['skill', 'agent', 'command', 'rule'];
  const object = (source, properties, required) => ({
    type: source.type, properties, required, additionalProperties: source.additionalProperties,
  });
  assert.deepEqual(normalized(inputs.aiwg_discover), normalized(object(discover, {
    query: discover.properties.phrase, type: discover.properties.type,
  }, (discover.required ?? []).filter(key => ['phrase', 'type'].includes(key)).map(key => key === 'phrase' ? 'query' : key))));
  for (const type of shown) {
    const show = schemas[`${type}-show`];
    assert.equal(show.properties.section.type, 'array');
    assert.deepEqual(normalized(inputs.aiwg_show), normalized(object(show, {
      type: { type: 'string', enum: shown }, name: show.properties.name,
      section: show.properties.section.items,
    }, ['type', ...(show.required ?? []).filter(key => ['name', 'section'].includes(key))])));
    // These are fixed by the wrapper, not advertised as caller-controlled data.
    assert.equal(show.properties.rules.type, 'boolean');
    assert.equal(show.properties.with_rule_bodies.type, 'boolean');
  }
  const write = schemas['artifact-write'];
  assert.deepEqual(normalized(inputs.aiwg_artifact_write), normalized(object(write, {
    path: write.properties.path, content: write.properties.content,
  }, (write.required ?? []).filter(key => ['path', 'content'].includes(key)))));
  // A newly supported show type must be consciously handled by this projection.
  const showTypes = discover.properties.type.enum.filter(type => shown.includes(type));
  assert.deepEqual(showTypes.sort(), [...shown].sort());
}

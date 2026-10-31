// Minimal schema builders for wrapper units; real Valibot is exercised by the lab smoke.
export const string = () => ({ jsonSchema: { type: 'string' } });
export const picklist = values => ({ jsonSchema: { type: 'string', enum: values } });
export const optional = wrapped => ({ ...wrapped, optional: true });
export const strictObject = entries => ({
  jsonSchema: {
    type: 'object',
    properties: Object.fromEntries(Object.entries(entries).map(([key, value]) => [key, value.jsonSchema])),
    required: Object.keys(entries).filter(key => !entries[key].optional),
    additionalProperties: false,
  },
});

// Own the two mutually exclusive publication request shapes.
import { z } from 'zod';

const absolute = z.string().startsWith('/').max(4096).refine(value => !value.includes('\0'));
const check = z.strictObject({
  id: z.string().min(1).max(256), command: absolute,
  args: z.array(z.string().max(65536).refine(value => !value.includes('\0'))).max(256).optional(),
  cwd: absolute.optional(),
  envNames: z.array(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/)).max(128).optional(),
  timeoutMs: z.number().int().positive().max(86400000).optional(),
});
export const typedStopSchema = z.strictObject({
  status: z.enum(['denied', 'blocked']),
  code: z.string().regex(/^[A-Z][A-Z0-9_]{2,63}$/),
  blocking_rule: z.string().min(1).max(2000).refine(value => value.trim().length > 0),
  launch_count: z.literal(0),
  uncertainty_statement: z.string().max(4000).optional(),
  reason: z.string().max(4000).optional(),
});
export const typedStopDeliverySchema = z.strictObject({ deliverablePath: absolute, typedStop: typedStopSchema });
export const publicationSchema = z.union([
  z.strictObject({ run_dir: absolute, artifact_path: absolute.optional(), deliverable_path: absolute, checks: z.array(check).min(1).max(32) }),
  z.strictObject({ deliverable_path: absolute, typed_stop: typedStopSchema }),
]);

// The SDK advertises only object schemas. Preserve the strict union in both
// its advertised JSON Schema and validation, with a stable refusal code.
export const publicationInputSchema = z.looseObject({}).superRefine((input, context) => {
  const parsed = publicationSchema.safeParse(input);
  if (!parsed.success) context.addIssue({ code: 'custom', message: `TYPED_STOP_INVALID: ${parsed.error.message}` });
}).meta({ anyOf: z.toJSONSchema(publicationSchema).anyOf });

export const invalidTypedStop = message => Object.assign(new Error(`TYPED_STOP_INVALID: ${message}`), { code: 'TYPED_STOP_INVALID' });

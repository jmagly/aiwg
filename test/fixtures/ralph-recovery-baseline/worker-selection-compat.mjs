// Preserves the independent recovery baseline while accepting additive #2642 policy fields.
export function amendWorkerSelectionShape(body) {
  const marker = 'export const WorkerSelectionPolicySchema = z.object({\n';
  if (!body.includes(marker)) throw new Error('Review the frozen worker-selection schema before refreshing');
  return body.replace(
    ' * Only import routing and this pin header differ from the baseline body.',
    ' * Import routing, this pin header and #2642 optional policy fields differ from the baseline body.',
  ).replace(marker, marker
    + "  strategy: z.enum(['cost-effective', 'balanced', 'quality']).optional(),\n"
    + "  maxAutoTier: z.enum(['economy', 'standard', 'premium', 'flagship', 'max-quality']).optional(),\n");
}

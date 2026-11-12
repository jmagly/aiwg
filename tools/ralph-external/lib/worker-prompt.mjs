// Add the final-output contract to launch-time briefs without changing the bound source brief.
export function workerPromptBrief(brief, finalPath) {
  const text = Buffer.isBuffer(brief) ? new TextDecoder('utf-8', { fatal: true }).decode(brief) : brief;
  return Buffer.from(`[Worker final-output contract]
Write one strict workerClaims JSON object to this exact absolute path: ${JSON.stringify(finalPath)}
The task's answer alone (for example {"facts":[],"warning":""}) is not the final-output wrapper.
Required minimal wrapper example (replace the summary and report your actual status):
{"version":1,"status":"completed","summary":"Task result","claims":[],"artifacts":[],"checks":[],"limitations":[]}
Allowed status: completed, partial, blocked, failed. Keep all seven fields; add no other top-level fields.
Put the answer in summary or a separate task artifact. For each listed artifact use
{"path":"answer.json","digest":"sha256:<64 lowercase hex characters>","change":"created"}
with a real digest and a file beneath the worker tree. Each claim and check is an object, never a string:
{"id":"claim-1","text":"What you did or found","evidence":[{"ref":"answer.json","digest":"sha256:<64 lowercase hex characters>"}]}
{"checkId":"check-1","exitCode":0,"evidence":{"ref":"answer.json","digest":"sha256:<64 lowercase hex characters>"},"environment":"worker tree"}
Evidence items use "ref", not "path". Each limitation is a plain string. Empty collections are allowed.
Keep this JSON separate from stdout, stderr and last-message captures. A file at the worker-tree root
does not satisfy a different declared final-output path. Worker claims remain unverified.

[Task]
${text}`);
}

// File-based profiles receive a private derived brief through the existing artifact lifecycle.
export function workerPromptArtifacts(invocation, { brief, invocationId } = {}) {
  if (brief === undefined || invocation.stdin !== 'closed') return invocation;
  const text = Buffer.isBuffer(brief) ? brief.toString('utf8') : brief;
  const prompt = workerPromptBrief(brief, invocation.finalPath).toString('utf8');
  if (invocation.argv.includes(invocation.briefPath)) {
    const name = 'launcher-worker-brief', prefix = '.handoff/worker-brief-';
    return { ...invocation, invocationId,
      argv: invocation.argv.map(token => token === invocation.briefPath ? `\${artifact:${name}}` : token),
      artifacts: [...(invocation.artifacts ?? []), { name, content: prompt, location: 'workspace-relative',
        prefix, relativePath: `${prefix}${invocationId}/brief.md` }] };
  }
  // Skill-file profiles embed the brief after frontmatter. Preserve their framing.
  return { ...invocation, artifacts: invocation.artifacts?.map(artifact => ({ ...artifact,
    content: text && artifact.content.includes(text) ? artifact.content.replace(text, () => prompt) : artifact.content })) };
}

'use agent';
import { readFileSync } from 'node:fs';
import { defineSkill, useModel, useSkill, useTool } from '@flue/runtime';
import { aiwg_discover, aiwg_show, aiwg_artifact_write } from '../aiwg/tools.ts';
import { useAiwgSpecialists } from '../aiwg/specialists.ts';

// Mount deployed instructions explicitly: workspace discovery needs a sandbox.
const sdlc = defineSkill({
  name: 'sdlc-quickref',
  description: 'Find AIWG software development workflows and their governing rules.',
  instructions: readFileSync('.agents/skills/sdlc-quickref/SKILL.md', 'utf8'),
});

export function Assistant() {
  useModel(process.env.FLUE_MODEL || 'openrouter/anthropic/claude-haiku-4.5');
  useTool(aiwg_discover);
  useTool(aiwg_show);
  useTool(aiwg_artifact_write);
  useSkill(sdlc);
  useAiwgSpecialists();
  return `Help with software development. For a review request, in this conversation:
1. Call aiwg_discover to find the sdlc-quickref skill.
2. Call aiwg_show for that skill and read its governing rules.
3. Activate sdlc-quickref using activate_skill before proceeding.
4. Delegate the supplied code or change description to code-reviewer using task.
5. Save the review with aiwg_artifact_write at reviews/example.md.
Use only these AIWG tools for artifact writes. Report the saved path and findings.
If no code was supplied, ask for it. Follow the governing rules.`;
}

// Validate the static skill contract shared by package builds and deployments.
import { parse } from 'yaml';
import path from 'node:path';
export function validateFlueSkill(content, file) {
  const frontmatter = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  let metadata;
  try { metadata = frontmatter && parse(frontmatter[1]); }
  catch (error) { throw new Error(`${file}: invalid Flue frontmatter: ${error.message}`); }
  if (metadata?.name !== path.basename(path.dirname(file))) throw new Error(`${file}: Flue skill name must equal its directory`);
  if (typeof metadata.description !== 'string' || metadata.description.length < 1 || metadata.description.length > 1024) {
    throw new Error(`${file}: Flue skill description must contain 1-1024 characters`);
  }
  return metadata;
}

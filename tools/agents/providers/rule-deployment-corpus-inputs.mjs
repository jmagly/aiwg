// Preview live corpus inputs without copying or sealing a never-committed source snapshot.
import path from 'node:path';
import { snapshotPreimages, within } from './rule-deployment-state.mjs';

export function corpusInputPlan(original, corpusRoot, sourceTree, pool) {
  const preview = original.dryRun === true;
  return {
    preimages: preview ? [] : pool?.preimages ?? snapshotPreimages([
      sourceTree, path.join(corpusRoot, 'prebuilt', 'framework-relations'),
      path.join(corpusRoot, 'package.json'), path.join(corpusRoot, 'schemas'),
    ]),
    snapshotRequired: !preview && !pool,
    snapshotRoot: temp => preview ? corpusRoot : pool?.snapshotRoot ?? path.join(temp, 'input'),
    // Binding discovery may return absolute corpus paths. These are already
    // readable in a preview; copying each selected target would rebuild the
    // snapshot piecemeal. Output still renders in the isolated project stage.
    isLiveInput: file => preview && within(corpusRoot, file),
  };
}

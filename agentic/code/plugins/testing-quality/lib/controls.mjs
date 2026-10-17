import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import path from 'node:path';
import { artifact, digest, readDocument, validateContract } from './contracts.mjs';
import { inventoryWorkspace } from './inventory.mjs';
import { collectEvidence, verifyReceipt } from './collector.mjs';
import { applyPlan, rollbackPlan } from './normalization.mjs';
import { targetPath, writeNew, writeAtomic } from './workspace.mjs';

const diag = (code, message) => ({ code, message });
function expectedInventory(inventory, plan) {
  const spec = structuredClone(inventory.spec);
  for (const change of plan.spec.changes) {
    const file = spec.files.find(f => f.path === change.path);
    file.hash = change.after.hash; file.size = Buffer.byteLength(change.after.content);
  }
  spec.snapshotHash = digest({ root: spec.root, protocolHash: spec.protocolHash, files: spec.files.map(({path,hash,role,isSource})=>({path,hash,role,isSource})) });
  return { ...inventory, spec };
}
function checkPlan(plan, inventory) {
  if (plan?.kind !== 'TestNormalizationPlan' || plan.spec?.root !== inventory.spec.root || !Array.isArray(plan.spec.changes) || !plan.spec.changes.length) throw new Error('Control requires a nonempty normalization plan bound to the target root');
  if (plan.spec.planHash !== digest({root:plan.spec.root,purpose:plan.spec.purpose,changes:plan.spec.changes})) throw new Error('Control plan hash mismatch');
  let changed = false;
  for (const change of plan.spec.changes) {
    const file = inventory.spec.files.find(f => f.path === change.path);
    if (!file || file.role !== 'source' || !file.isSource) throw new Error(`Control edits must target existing inventoried source, never tests/configuration: ${change.path}`);
    if (typeof change.before?.content !== 'string' || typeof change.after?.content !== 'string' || change.before.hash !== file.hash || digest(change.before.content) !== change.before.hash || digest(change.after.content) !== change.after.hash || change.before.mode !== change.after.mode) throw new Error('Control plan must preserve existing source identity/mode and contain valid before/after content');
    changed ||= change.before.hash !== change.after.hash;
  }
  if (!changed) throw new Error('Control must actually change source behavior input');
}
function laneRecord(receipt, definition) {
  if (receipt?.spec?.mode !== 'execution') throw new Error('Controls require execution receipts');
  const lane = receipt.spec.lanes.find(l => l.id === definition.id);
  if (!lane || lane.mode !== 'execution' || !lane.process || lane.process.reason !== 'exit' || lane.process.signal || lane.diagnostics.length || !lane.normalized.complete || lane.normalized.errors.length) throw new Error('Lane has absent, incomplete or contradictory execution evidence');
  const argv = definition.command.argv.map(a => a.replaceAll('{runId}',receipt.spec.runId));
  if (digest(lane.process.argv) !== digest(argv) || lane.process.environment.explicitValuesHash !== digest(definition.command.env ?? {})) throw new Error('Receipt did not execute the configured lane recipe');
  return lane;
}
function targetStates(lane, ids, state) {
  return ids.length > 0 && ids.every(id => lane.normalized.cases.some(c => c.id === id && c.status === state));
}
function outcome(baseline, mutation, restored, definition, control) {
  const before = laneRecord(baseline, definition), after = laneRecord(mutation, definition), final = laneRecord(restored, definition);
  if (before.process.exitCode !== 0 || final.process.exitCode !== 0 || !targetStates(before,control.testIds,'passed') || !targetStates(final,control.testIds,'passed')) throw new Error('Target cases must pass before and after the control');
  const ids = lane => lane.normalized.cases.map(c=>c.id).sort();
  if (digest(ids(before)) !== digest(ids(after)) || digest(ids(before)) !== digest(ids(final))) throw new Error('Control changed registered/executed case identities');
  if (after.process.exitCode !== 0 && targetStates(after,control.testIds,'failed')) return 'killed';
  if (after.process.exitCode === 0 && targetStates(after,control.testIds,'passed')) return 'survived';
  throw new Error('Control failure was not attributable to every selected test case');
}
async function readLocal(root, relative) {
  const file = await targetPath(root, relative, {write:true});
  return readDocument(file);
}
function checkRunnerEntrypoints(root, definition, plan) {
  const argvPaths = new Set(definition.command.argv.filter(a => !a.startsWith('-')).map(a => path.relative(root, path.resolve(root, a)).split(path.sep).join('/')));
  if (plan.spec.changes.some(c => argvPaths.has(c.path))) throw new Error('Control cannot edit the runner command entrypoint');
}
function boundRecipe(control, definition) {
  if (digest(control.command) !== digest(definition.command) || digest(control.result) !== digest(definition.result)) throw new Error('Control command/result must exactly match its lane recipe');
  if (!Array.isArray(control.testIds) || !control.testIds.length || new Set(control.testIds).size !== control.testIds.length) throw new Error('Control requires unique target test IDs');
}
function receiptStatus(controls, sourceRestored) {
  if (!sourceRestored || !controls.length || controls.some(c=>c.status==='unknown')) return 'unknown';
  return controls.every(c=>c.status==='killed') ? 'passed' : 'failed';
}

/** Explicit opt-in control execution: mutate only source, run the same lane, restore in finally.
 * `controlId`, when set, scopes execution to a single declared control (by id) within the
 * selected lane(s), producing one small receipt instead of one receipt per lane covering every
 * control. `assess` already aggregates verified negative-control receipts across `--evidence`
 * inputs by laneId/controlId, so collecting controls one at a time and passing each receipt as
 * its own `--evidence` input is equivalent to one combined receipt for assessment purposes. */
export async function collectControls(root, protocol, { evidence, lane='all', controlId=null, outputDir } = {}) {
  root = await fs.realpath(root);
  await validateContract(evidence, 'test-run-receipt.v1');
  const current = await inventoryWorkspace(root, protocol);
  const baselineErrors = await verifyReceipt(root,protocol,evidence,{inventory:current});
  if (baselineErrors.length) throw new Error(`Negative-control baseline is invalid: ${JSON.stringify(baselineErrors)}`);
  const selected = protocol.spec.lanes.filter(l=>lane==='all'||l.id===lane);
  if (!selected.length) throw new Error(`Unknown control lane ${lane}`);
  if (controlId !== null && !selected.some(l => (l.negativeControls ?? []).some(c => c.id === controlId))) throw new Error(`Unknown control ${controlId} for lane ${lane}`);
  const runId=crypto.randomUUID(), directory=outputDir ?? `.aiwg/testing/conformance/controls/${runId}`;
  const controls=[], diagnostics=[];
  const spec={root,protocolHash:digest(protocol),snapshotHash:current.spec.snapshotHash,runId,baseline:evidence,controls,diagnostics,sourceRestored:true,status:'unknown'};
  const result=artifact('TestNegativeControlReceipt',spec,{name:protocol.metadata.name});
  const persist=async()=>{spec.status=receiptStatus(controls,spec.sourceRestored);delete spec.receiptHash;spec.receiptHash=digest(spec);await validateContract(result,'negative-control-receipt.v1');await writeAtomic(root,`${directory}/journal.json`,result);};
  await writeNew(root,`${directory}/journal.json`,result);
  outer: for (const definition of selected) {
    if (!definition.negativeControls?.length) { controls.push({laneId:definition.id,controlId:null,testIds:[],status:'unknown',diagnostics:[diag('CONTROL_UNCONFIGURED','No negative controls declared for selected lane')]});await persist();continue; }
    const scoped = controlId === null ? definition.negativeControls : definition.negativeControls.filter(c => c.id === controlId);
    if (!scoped.length) continue;
    for (const control of scoped) {
      const record={laneId:definition.id,controlId:control.id,testIds:[...control.testIds],status:'unknown',diagnostics:[]};controls.push(record);
      let applied;
      try {
        boundRecipe(control,definition);
        const before=laneRecord(evidence,definition);
        if (before.process.exitCode!==0 || !targetStates(before,control.testIds,'passed')) throw new Error('Baseline target cases must pass before mutation');
        const plan=await readLocal(root,control.changePlan);checkPlan(plan,current);record.plan=plan;
        // Refuse runner entrypoint edits even when a broad source glob classifies them as source.
        checkRunnerEntrypoints(root,definition,plan);
        await persist();
        applied=await applyPlan(root,plan,{receiptPath:`${directory}/control-${controls.length}-apply.json`});record.applyReceipt=applied;await persist();
        record.mutationReceipt=await collectEvidence(root,protocol,{mode:'execution',lane:definition.id,outputDir:`${directory}/control-${controls.length}-mutant`});
        const errors=await verifyReceipt(root,protocol,record.mutationReceipt,{inventory:expectedInventory(current,plan)});
        if(errors.length)throw new Error(`Mutant evidence failed verification: ${JSON.stringify(errors)}`);
      } catch(error) {record.diagnostics.push(diag('CONTROL_UNVERIFIED',error.message)); if(error.receipt)record.partialReceipt=error.receipt;}
      finally {
        if(applied){
          try {record.rollbackReceipt=await rollbackPlan(root,applied,{receiptPath:`${directory}/control-${controls.length}-rollback.json`});}
          catch(error){record.diagnostics.push(diag('CONTROL_RESTORE_FAILED',error.message));if(error.receipt)record.partialRollbackReceipt=error.receipt;}
        }
        const restored=await inventoryWorkspace(root,protocol);
        spec.sourceRestored=restored.spec.snapshotHash===current.spec.snapshotHash && !record.partialReceipt && (!applied || record.rollbackReceipt?.spec.status==='rolled-back');
        if(!spec.sourceRestored)record.diagnostics.push(diag('CONTROL_SOURCE_NOT_RESTORED','Stop control execution and inspect transaction journals before recovery'));
        await persist();
      }
      if(!spec.sourceRestored)break outer;
      if(applied && record.rollbackReceipt && !record.diagnostics.length){
        try {
          record.restoredReceipt=await collectEvidence(root,protocol,{mode:'execution',lane:definition.id,outputDir:`${directory}/control-${controls.length}-restored`});
          const errors=await verifyReceipt(root,protocol,record.restoredReceipt,{inventory:current});
          if(errors.length)throw new Error(`Restored execution failed verification: ${JSON.stringify(errors)}`);
          record.status=outcome(evidence,record.mutationReceipt,record.restoredReceipt,definition,control);
        } catch(error){record.diagnostics.push(diag('CONTROL_UNVERIFIED',error.message));}
      }
      await persist();
    }
  }
  spec.sourceRestored=spec.sourceRestored && (await inventoryWorkspace(root,protocol)).spec.snapshotHash===current.spec.snapshotHash;
  await persist();await writeNew(root,`${directory}/receipt.json`,result);
  return result;
}

/** Verify retained raw baseline/mutant/restored evidence against the exact plan delta. */
export async function verifyControls(root, protocol, receipt, {inventory}={}) {
  const errors=[];
  try {
    root=await fs.realpath(root);
    await validateContract(receipt,'negative-control-receipt.v1');
    if(receipt?.kind!=='TestNegativeControlReceipt'||!receipt.spec)throw new Error('Expected TestNegativeControlReceipt');
    const {receiptHash,...bound}=receipt.spec;
    if(digest(bound)!==receiptHash)throw new Error('Negative-control receipt digest mismatch');
    const current=inventory??await inventoryWorkspace(root,protocol);
    if(receipt.spec.root!==root||receipt.spec.protocolHash!==digest(protocol)||receipt.spec.snapshotHash!==current.spec.snapshotHash||!receipt.spec.sourceRestored)throw new Error('Negative-control receipt has stale/unrestored source');
    errors.push(...await verifyReceipt(root,protocol,receipt.spec.baseline,{inventory:current}));
    const seen=new Set();
    for(const record of receipt.spec.controls){
      const key=JSON.stringify([record.laneId,record.controlId]);if(seen.has(key))throw new Error('Duplicate control record');seen.add(key);
      const definition=protocol.spec.lanes.find(l=>l.id===record.laneId);
      const control=definition?.negativeControls?.find(c=>c.id===record.controlId);
      if(!control){errors.push(diag('CONTROL_UNCONFIGURED',`No configured control for ${key}`));continue;}
      try {
        boundRecipe(control,definition);
        if(digest(control.testIds)!==digest(record.testIds))throw new Error('Control target binding mismatch');
        checkPlan(record.plan,current);
        checkRunnerEntrypoints(root,definition,record.plan);
        const archivedPlan=await readLocal(root,control.changePlan);
        if(digest(archivedPlan)!==digest(record.plan))throw new Error('Configured change plan changed after control execution');
        for(const [field,status] of [['applyReceipt','applied'],['rollbackReceipt','rolled-back']]){
          const value=record[field];if(value?.spec?.status!==status||value.spec.planHash!==record.plan.spec.planHash||digest(value.spec.changes)!==digest(record.plan.spec.changes))throw new Error(`Missing/mismatched ${field}`);
          if(digest(await readLocal(root,value.spec.receiptPath))!==digest(value))throw new Error(`Archived ${field} changed`);
        }
        errors.push(...await verifyReceipt(root,protocol,record.mutationReceipt,{inventory:expectedInventory(current,record.plan)}));
        errors.push(...await verifyReceipt(root,protocol,record.restoredReceipt,{inventory:current}));
        const actual=outcome(receipt.spec.baseline,record.mutationReceipt,record.restoredReceipt,definition,control);
        if(actual!==record.status||record.diagnostics.length)throw new Error('Control status does not match its actual execution evidence');
      }catch(error){errors.push(diag('CONTROL_UNVERIFIED',`${key}: ${error.message}`));}
    }
    if(receiptStatus(receipt.spec.controls,receipt.spec.sourceRestored)!==receipt.spec.status)errors.push(diag('CONTROL_STATUS_MISMATCH','Aggregate control status does not match outcomes'));
  }catch(error){errors.push(diag('INVALID_CONTROL_RECEIPT',error.message));}
  return errors;
}

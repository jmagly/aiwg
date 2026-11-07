// Merge Factory hook documents without replacing operator registrations.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { parseJson } from '../../mcp/json-document.mjs';

export interface FactoryHook {
  [key: string]: unknown;
  type?: string;
  command?: string;
  _aiwg_managed?: boolean;
  _aiwg_id?: string;
}
export interface FactoryGroup { [key: string]: unknown; hooks: FactoryHook[] }
export interface FactoryDocument { [key: string]: unknown; hooks?: Record<string, FactoryGroup[]> }

// droid reads hooks.json as a top-level event map; only settings.json nests events under `hooks`.
// Earlier AIWG releases wrote the nested shape into hooks.json, which droid ignored, so read both.
function isHooksFile(file: string): boolean {
  return path.basename(file) === 'hooks.json';
}

function fromHooksFile(raw: Record<string, unknown>): FactoryDocument {
  const doc: FactoryDocument = {};
  const events: Record<string, FactoryGroup[]> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (Array.isArray(value)) events[key] = value as FactoryGroup[];
    else if (key !== 'hooks') doc[key] = value;
  }
  const nested = raw.hooks;
  if (nested !== undefined) {
    if (!nested || typeof nested !== 'object' || Array.isArray(nested)) return { ...doc, hooks: nested as never };
    for (const [event, groups] of Object.entries(nested as Record<string, FactoryGroup[]>)) {
      events[event] = Array.isArray(events[event]) && Array.isArray(groups) ? [...events[event], ...groups] : groups;
    }
  }
  if (Object.keys(events).length) doc.hooks = events;
  return doc;
}

export function readFactoryDocument(file: string): FactoryDocument {
  try {
    const raw = parseJson(fs.readFileSync(file, 'utf8')) as FactoryDocument;
    const doc = raw && typeof raw === 'object' && !Array.isArray(raw) && isHooksFile(file) ? fromHooksFile(raw) : raw;
    if (!doc || typeof doc !== 'object' || Array.isArray(doc)
      || (doc.hooks !== undefined && (!doc.hooks || typeof doc.hooks !== 'object' || Array.isArray(doc.hooks)))) {
      throw new Error(`Invalid Factory hooks object: ${file}`);
    }
    for (const groups of Object.values(doc.hooks ?? {})) {
      if (!Array.isArray(groups) || groups.some(group => !group || !Array.isArray(group.hooks)
        || group.hooks.some(hook => !hook || typeof hook !== 'object'))) {
        throw new Error(`Invalid Factory matcher groups: ${file}`);
      }
    }
    return doc;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw error;
  }
}

export function writeFactoryDocument(file: string, doc: FactoryDocument): void {
  const { hooks, ...rest } = doc;
  const content = JSON.stringify(isHooksFile(file) ? { ...rest, ...(hooks ?? {}) } : doc, null, 2) + '\n';
  if (fs.existsSync(file) && fs.readFileSync(file, 'utf8') === content) return;
  if (fs.existsSync(file)) {
    const original = fs.readFileSync(file, 'utf8');
    if (original !== JSON.stringify(parseJson(original), null, 2) + '\n') {
      fs.copyFileSync(file, `${file}.aiwg-backup-${randomUUID()}`);
    }
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp.${randomUUID()}`;
  try {
    fs.writeFileSync(temporary, content, { flag: 'wx' });
    fs.renameSync(temporary, file);
  } finally { fs.rmSync(temporary, { force: true }); }
}

export function isFactoryManaged(hook: FactoryHook): boolean {
  return hook._aiwg_managed === true || /^aiwg (?:sync|refresh) --dry-run --quiet$/.test(hook.command ?? '');
}

export function removeFactoryManaged(doc: FactoryDocument, id?: string): boolean {
  let changed = false;
  for (const [event, groups] of Object.entries(doc.hooks ?? {})) {
    doc.hooks![event] = groups.flatMap(group => {
      const hooks = group.hooks.filter(hook => !(isFactoryManaged(hook)
        && (!id || hook._aiwg_id === id || (id === 'aiwg-session' && /^aiwg (?:sync|refresh) --dry-run --quiet$/.test(hook.command ?? '')))));
      if (hooks.length === group.hooks.length) return [group];
      changed = true;
      return hooks.length ? [{ ...group, hooks }] : [];
    });
    if (!doc.hooks![event].length) delete doc.hooks![event];
  }
  if (doc.hooks && !Object.keys(doc.hooks).length) delete doc.hooks;
  return changed;
}

/** Read all migration inputs before writes; retain user fallback hooks once shadowed. */
export function factoryHookDocuments(directory: string) {
  const file = path.join(directory, 'hooks.json');
  const legacyFile = path.join(directory, 'hooks/hooks.json');
  const settingsFile = path.join(directory, 'settings.json');
  const doc = readFactoryDocument(file);
  const legacy = readFactoryDocument(legacyFile);
  const settings = readFactoryDocument(settingsFile);
  for (const [key, value] of Object.entries(legacy)) if (key !== 'hooks' && !(key in doc)) doc[key] = value;
  doc.hooks ??= {};
  const managedSettings: FactoryDocument = { hooks: Object.fromEntries(Object.entries(settings.hooks ?? {})
    .map(([event, groups]) => [event, groups.flatMap(group => {
      const hooks = group.hooks.filter(isFactoryManaged);
      return hooks.length ? [{ ...group, hooks }] : [];
    })])) };
  const fallback = !fs.existsSync(file) && !fs.existsSync(legacyFile);
  for (const input of [legacy, fallback ? settings : managedSettings]) {
    for (const [event, groups] of Object.entries(input.hooks ?? {})) {
      const target = doc.hooks[event] ??= [];
      for (const group of groups) if (!target.some(entry => JSON.stringify(entry) === JSON.stringify(group))) target.push(group);
    }
  }
  const migratedSettings = removeFactoryManaged(settings);
  return { file, doc, legacyFile, settingsFile, settings, migratedSettings };
}

export function saveFactoryHooks(state: ReturnType<typeof factoryHookDocuments>): void {
  // Commit the active hook document before removing legacy registrations.
  writeFactoryDocument(state.file, state.doc);
  if (state.migratedSettings) writeFactoryDocument(state.settingsFile, state.settings);
  fs.rmSync(state.legacyFile, { force: true });
}

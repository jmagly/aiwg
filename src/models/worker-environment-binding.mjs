/** Bind desktop session endpoints without binding the volatile D-Bus GUID hint. */
import { qualificationDigest } from './qualification-digest.mjs';

const desktopNames = new Set(['DISPLAY', 'DBUS_SESSION_BUS_ADDRESS', 'XDG_RUNTIME_DIR']);
// Presence alone cannot distinguish a different desktop/runtime directory.
// Keep those endpoints bound; qualification's login probe establishes visibility
// at that time, not the continued validity of a volatile D-Bus GUID hint.

export function workerEnvironmentValue(name, value) {
  // The worker receives the original address. Only comparison drops the GUID
  // hint; unix:path selects the session bus. Preserve other transports/options
  // and every address in a fallback list so endpoint changes still invalidate.
  return name === 'DBUS_SESSION_BUS_ADDRESS' && typeof value === 'string'
    ? value.split(';').map(address => /^unix:path=[^,;]+(?:,|$)/.test(address)
      ? address.replace(/,guid=[0-9a-fA-F]+(?=,|$)/g, '') : address).join(';') : value;
}

export function workerEnvironmentScope(environment) {
  return Object.fromEntries(Object.entries(environment).filter(([name]) => name !== 'PATH')
    .map(([name, value]) => [name, workerEnvironmentValue(name, value)]));
}

export function workerDesktopEnvironmentBindings(environment) {
  // Never persist values or add credentials/other ambient variables to this map.
  return Object.fromEntries(Object.entries(environment).filter(([name]) => desktopNames.has(name))
    .map(([name, value]) => [name, qualificationDigest(workerEnvironmentValue(name, value))]));
}

export function changedWorkerDesktopEnvironment(installation, environment) {
  const bindings = installation.environmentBindings;
  if (bindings === undefined) return []; // Older signed approvals retain their scope check.
  if (!bindings || typeof bindings !== 'object' || Array.isArray(bindings)
    || Object.entries(bindings).some(([name, digest]) => !desktopNames.has(name)
      || !installation.environmentNames?.includes(name) || !/^sha256:[a-f0-9]{64}$/.test(digest))) {
    throw new Error('Invalid desktop environment bindings');
  }
  return Object.entries(bindings).filter(([name, digest]) => environment[name] !== undefined
    && qualificationDigest(workerEnvironmentValue(name, environment[name])) !== digest).map(([name]) => name).sort();
}

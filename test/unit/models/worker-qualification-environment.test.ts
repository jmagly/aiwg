import { expect, it } from 'vitest';
import { workerQualificationEnvironmentError } from '../../../src/models/worker-qualification-environment.js';
import { WorkerPolicyError } from '../../../src/models/provider-policy.js';
import { workerInvocationDiagnostic } from '../../../src/serve/worker-invocation.js';
import { workerDesktopEnvironmentBindings, workerEnvironmentScope } from '../../../src/models/worker-environment-binding.mjs';

it('reports only missing names and treats empty values as present', () => {
  const rejections = [{ registration: 0, reason: 'environment-name' }];
  const records = [{ installation: { environmentNames: ['DISPLAY', 'DBUS_SESSION_BUS_ADDRESS', 'XDG_RUNTIME_DIR'] } }];
  const error = workerQualificationEnvironmentError(rejections, records, { DISPLAY: '', XDG_RUNTIME_DIR: 'synthetic-private-runtime' });
  expect(workerInvocationDiagnostic(error, '/request')).toEqual({ code: 'OG_ENVIRONMENT_MISMATCH',
    pointer: '/parallelism/clis', message: expect.stringContaining('qualification: DBUS_SESSION_BUS_ADDRESS.') });
  expect(JSON.stringify(error)).not.toContain('synthetic-private-runtime');
  expect(workerQualificationEnvironmentError(rejections, records,
    { DISPLAY: '', DBUS_SESSION_BUS_ADDRESS: '', XDG_RUNTIME_DIR: '' })).toBeNull();
});

it.each(['signature-invalid', 'signature-unknown-keyid', 'signature-missing', 'signature-trust-unavailable', 'record-identity'])(
  'does not disclose environment names from an unverified record (%s)', reason => {
    expect(workerQualificationEnvironmentError([{ registration: 0, reason }],
      [{ installation: { environmentNames: ['PRIVATE_ENV_NAME'] } }], {})).toBeNull();
  });

it.each(['signature-invalid', 'signature-unknown-keyid'])(
  'keeps the existing %s diagnostic', reason => {
    const error = new WorkerPolicyError('OG_ADAPTER_UNQUALIFIED', 'internal', { rejections: [{ registration: 0, reason }] });
    expect(workerInvocationDiagnostic(error, '/parallelism/clis')).toEqual({ code: 'OG_ADAPTER_UNQUALIFIED',
      pointer: '/parallelism/clis', message: 'Worker installation signature is invalid or its keyid is untrusted. Re-run aiwg doctor --probe-workers --qualify.' });
  });

it.each([
  { environmentNames: ['DISPLAY', 'value\nPRIVATE'] },
  { environmentNames: ['DISPLAY', 42] },
  { environmentNames: 'PRIVATE' },
  { environmentNames: ['DISPLAY'], environment: { PRIVATE: 'synthetic-private-value' } },
])('keeps malformed or value-bearing records generic', installation => {
  expect(workerQualificationEnvironmentError([{ registration: 0, reason: 'environment-name' }], [{ installation }], {})).toBeNull();
});

it('combines and sorts names from verified environment failures only', () => {
  const error = workerQualificationEnvironmentError([
    { registration: 0, reason: 'environment-name' }, { registration: 1, reason: 'signature-invalid' },
    { registration: 2, reason: 'environment-name' }, { registration: null, reason: 'environment-name' },
  ], [
    { installation: { environmentNames: ['XDG_RUNTIME_DIR', 'DISPLAY'] } },
    { installation: { environmentNames: ['PRIVATE_ENV_NAME'] } },
    { installation: { environmentNames: ['DISPLAY', 'DBUS_SESSION_BUS_ADDRESS'] } },
  ], {});
  expect(error?.message).toContain('qualification: DBUS_SESSION_BUS_ADDRESS, DISPLAY, XDG_RUNTIME_DIR.');
  expect(error?.message).not.toContain('PRIVATE_ENV_NAME');
});

it('names changed desktop variables without disclosing either value (T-OG-03/12)', () => {
  const original = { DISPLAY: ':synthetic-private-old', DBUS_SESSION_BUS_ADDRESS: 'unix:path=/private/old-bus',
    XDG_RUNTIME_DIR: '/private/old-runtime' };
  const current = { DISPLAY: ':synthetic-private-new', DBUS_SESSION_BUS_ADDRESS: 'unix:path=/private/new-bus',
    XDG_RUNTIME_DIR: '/private/new-runtime' };
  const installation = { environmentNames: Object.keys(original), environmentBindings: workerDesktopEnvironmentBindings(original) };
  const error = workerQualificationEnvironmentError([{ registration: 0, reason: 'environment-value' }], [{ installation }], current);
  const diagnostic = workerInvocationDiagnostic(error, '/request');
  expect(diagnostic).toMatchObject({ code: 'OG_ENVIRONMENT_MISMATCH', pointer: '/parallelism/clis',
    message: expect.stringContaining('changed since qualification: DBUS_SESSION_BUS_ADDRESS, DISPLAY, XDG_RUNTIME_DIR.') });
  for (const value of [...Object.values(original), ...Object.values(current)]) {
    expect(JSON.stringify({ diagnostic, error })).not.toContain(value);
  }
});

it('normalizes only unix:path GUID hints and keeps credentials out of desktop bindings (T-OG-03/12)', () => {
  const address = 'unix:path=/synthetic/bus';
  expect(workerEnvironmentScope({ DBUS_SESSION_BUS_ADDRESS: `${address},guid=abc123`, DISPLAY: ':1' }))
    .toEqual(workerEnvironmentScope({ DBUS_SESSION_BUS_ADDRESS: address, DISPLAY: ':1' }));
  for (const value of [`${address},other=abc123`, 'unix:path=/different/bus', 'tcp:host=example,guid=abc123',
    'unix:abstract=synthetic,guid=abc123', `${address};unix:path=/different/bus`]) {
    expect(workerEnvironmentScope({ DBUS_SESSION_BUS_ADDRESS: value }))
      .not.toEqual(workerEnvironmentScope({ DBUS_SESSION_BUS_ADDRESS: address }));
  }
  expect(Object.keys(workerDesktopEnvironmentBindings({ DISPLAY: ':1', CURSOR_API_KEY: 'synthetic-key',
    PRIVATE: 'synthetic-private' }))).toEqual(['DISPLAY']);
  expect(workerEnvironmentScope({ CURSOR_API_KEY: 'synthetic-key' })).toEqual({ CURSOR_API_KEY: 'synthetic-key' });
});

it('does not disclose changed names for unverified or malformed bindings', () => {
  const installation = { environmentNames: ['DISPLAY'], environmentBindings: workerDesktopEnvironmentBindings({ DISPLAY: ':1' }) };
  expect(workerQualificationEnvironmentError([{ registration: 0, reason: 'signature-invalid' }],
    [{ installation }], { DISPLAY: ':2' })).toBeNull();
  expect(workerQualificationEnvironmentError([{ registration: 0, reason: 'environment-value' }],
    [{ installation: { ...installation, environmentBindings: { PRIVATE: 'value' } } }], { DISPLAY: ':2' })).toBeNull();
});

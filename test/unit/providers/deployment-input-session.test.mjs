// Update-scoped input reuse is bounded by source identity and session lifetime.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { deploymentSessionInput, withDeploymentInputSession } from '../../../src/providers/deployment-input-session.mjs';

const stager = () => ({ create: vi.fn(() => ({})), dispose: vi.fn() });
afterEach(() => vi.restoreAllMocks());

describe('deployment input session', () => {
  it('stages unchanged redeploy inputs once, including nested calls', async () => {
    const fake = stager();
    const stage = () => deploymentSessionInput('corpus', fake.create, fake.dispose);
    expect(stage()).toBeUndefined();
    await withDeploymentInputSession(async () => {
      const first = stage();
      expect(await withDeploymentInputSession(async () => stage())).toBe(first);
      expect(stage()).toBe(first);
      expect(fake.create).toHaveBeenCalledTimes(1);
      expect(fake.dispose).not.toHaveBeenCalled();
    });
    expect(fake.dispose).toHaveBeenCalledTimes(1);
    await withDeploymentInputSession(async () => stage());
    expect(fake.create).toHaveBeenCalledTimes(2);
    expect(fake.dispose).toHaveBeenCalledTimes(2);
  });

  it('keeps distinct source roots and concurrent updates independent', async () => {
    const fake = stager();
    await Promise.all(['one', 'two'].map(() => withDeploymentInputSession(async () => {
      for (const key of ['first', 'second', 'first']) deploymentSessionInput(key, fake.create, fake.dispose);
    })));
    expect(fake.create).toHaveBeenCalledTimes(4);
    expect(fake.dispose).toHaveBeenCalledTimes(4);
  });

  it('cleans up a failed update and does not retain inputs in later work', async () => {
    const fake = stager();
    await expect(withDeploymentInputSession(async () => {
      deploymentSessionInput('corpus', fake.create, fake.dispose);
      throw new Error('deployment failed');
    })).rejects.toThrow('deployment failed');
    expect(fake.dispose).toHaveBeenCalledTimes(1);
    expect(deploymentSessionInput('corpus', fake.create, fake.dispose)).toBeUndefined();
  });

  it('releases every input even if a disposer fails', async () => {
    const other = stager();
    await expect(withDeploymentInputSession(async () => {
      deploymentSessionInput('bad', () => ({}), () => { throw new Error('cleanup failed'); });
      deploymentSessionInput('other', other.create, other.dispose);
    })).rejects.toThrow('Failed to dispose deployment inputs');
    expect(other.dispose).toHaveBeenCalledTimes(1);
  });

  it('preserves the work error and attaches disposal errors when both fail', async () => {
    const workError = new Error('deployment failed', { cause: new Error('projection failed') });
    const disposeError = new Error('cleanup failed');
    const other = stager();
    await expect(withDeploymentInputSession(async () => {
      deploymentSessionInput('bad', () => ({}), () => { throw disposeError; });
      deploymentSessionInput('other', other.create, other.dispose);
      throw workError;
    })).rejects.toBe(workError);
    expect(workError.disposeErrors).toEqual([disposeError]);
    expect(workError.cause.message).toBe('projection failed');
    expect(other.dispose).toHaveBeenCalledTimes(1);
    expect(deploymentSessionInput('bad', vi.fn(), vi.fn())).toBeUndefined();
  });

  it('surfaces aggregated disposal errors after successful work', async () => {
    const disposeError = new Error('cleanup failed');
    await expect(withDeploymentInputSession(async () => {
      deploymentSessionInput('bad', () => ({}), () => { throw disposeError; });
      return 'deployed';
    })).rejects.toMatchObject({
      name: 'AggregateError', message: 'Failed to dispose deployment inputs', errors: [disposeError],
    });
  });
});

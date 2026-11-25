/** Check Cursor authentication visibility in the cleared worker environment without inference. */
import { execFile } from 'node:child_process';
import { promisify, stripVTControlCharacters } from 'node:util';

const remedy = 'Restore DISPLAY, DBUS_SESSION_BUS_ADDRESS and XDG_RUNTIME_DIR for the desktop OS keyring login, or set CURSOR_API_KEY for a headless host, then qualify again.';

export async function checkCursorWorkerAuth({ executable, environment, cwd }) {
  let output;
  try {
    const probe = promisify(execFile)(executable, ['status'], {
      cwd, env: environment, timeout: 10_000, maxBuffer: 64 * 1024, killSignal: 'SIGKILL',
    });
    probe.child.stdin.end();
    const { stdout, stderr } = await probe;
    output = stripVTControlCharacters(`${stdout}\n${stderr}`);
  } catch {
    // CLI errors may contain account identities, credentials or local paths.
    throw new Error(`Cursor worker authentication probe (cursor-agent status) failed in the rendered worker environment. ${remedy}`);
  }
  if (/\b(?:not logged in|not authenticated|unauthenticated|authentication required)\b/i.test(output)) {
    throw new Error(`Cursor login is not visible in the rendered worker environment (cursor-agent status). ${remedy}`);
  }
  if (!/\b(?:logged in as\s+\S|authenticated (?:via|with|as)\s+\S|using (?:an? )?api key\b)/i.test(output)) {
    throw new Error(`Cursor worker authentication was not confirmed: unrecognized cursor-agent status response in the rendered worker environment. ${remedy}`);
  }
  return { status: 'passed' };
}

import { mkdtempSync } from '../../helpers/temp-dir.js';
import { writeExecutableSync } from '../../helpers/write-executable.js';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

import {
  buildTranscriptSidecar,
  canonicalTranscriptPayload,
  preflight,
} from '../../../agentic/code/frameworks/media-curator/skills/transcribe-media/scripts/transcribe_media.mjs';

const scriptPath = resolve('agentic/code/frameworks/media-curator/skills/transcribe-media/scripts/transcribe_media.mjs');

function sha256Urn(value) {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'aiwg-media-adapter-'));
}

function createFakeWhisperx(dir) {
  const binDir = join(dir, 'bin');
  const script = join(binDir, 'whisperx');
  mkdirSync(binDir, { recursive: true });
  writeFileSync(join(dir, 'media.wav'), 'fixture-media-bytes', 'utf8');
  writeFileSync(join(dir, 'marker'), '', 'utf8');
  rmSync(join(dir, 'marker'), { force: true });
  writeExecutableSync(script, `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$@" > "${dir}/argv.log"
media="$1"
shift
out_dir=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --output_dir) out_dir="$2"; shift 2 ;;
    *) shift ;;
  esac
done
mkdir -p "$out_dir"
printf 'called\\n' > "${dir}/marker"
cat > "$out_dir/$(basename "$media" .wav).json" <<'JSON'
{
  "language": "en",
  "segments": [
    { "start": 0, "end": 1.25, "speaker": "SPEAKER_00", "text": "Hello from speaker zero." },
    { "start": 1.25, "end": 2.5, "speaker": "SPEAKER_01", "text": "Reply from speaker one." }
  ]
}
JSON
exit "$\{FAKE_WHISPERX_EXIT:-0}"
`);
  return {
    binDir,
    mediaPath: join(dir, 'media.wav'),
    markerPath: join(dir, 'marker'),
    argvLogPath: join(dir, 'argv.log'),
  };
}

describe('transcribe-media WhisperX adapter', () => {
  it('converts two-speaker WhisperX JSON into canonical transcript sidecars', () => {
    const dir = tempDir();
    try {
      const mediaPath = join(dir, 'two-speaker.wav');
      writeFileSync(mediaPath, 'media-bytes', 'utf8');
      const native = {
        language: 'en',
        segments: [
          { start: 0, end: 1.2, speaker: 'SPEAKER_00', text: ' First speaker. ' },
          { start: 1.2, end: 2.4, speaker: 'SPEAKER_01', text: 'Second   speaker.' },
        ],
      };

      const sidecar = buildTranscriptSidecar({
        native,
        mediaPath,
        nativePath: join(dir, 'native.json'),
        options: {
          sourceUrl: 'https://example.invalid/watch',
          language: 'en',
          generatedAt: '2026-07-25T00:00:00.000Z',
          credentialProvider: 'env:HF_TOKEN',
          minSpeakers: 2,
          maxSpeakers: 2,
        },
      });

      expect(sidecar.schema).toBe('aiwg.media.transcript.v1');
      expect(sidecar.segments.map((segment) => segment.speaker)).toEqual(['SPEAKER_00', 'SPEAKER_01']);
      expect(sidecar.segments[0]).toMatchObject({ id: 'seg-000001', start: '00:00:00.000', end: '00:00:01.200' });
      expect(sidecar.source.sha256).toBe(sha256Urn('media-bytes'));
      expect(sidecar.provenance.credential_provider).toEqual({ type: 'env', name: 'HF_TOKEN' });
      expect(sidecar.transcript.tool.speaker_constraints).toEqual({ min_speakers: 2, max_speakers: 2 });
      expect(JSON.stringify(sidecar)).not.toContain('secret');
      expect(sidecar.transcript.sha256).toBe(sha256Urn(canonicalTranscriptPayload(sidecar.segments)));
      expect(sidecar.transcript.quality.limitations.join(' ')).toMatch(/anonymous clustering/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('checks missing gated-model authorization before running WhisperX', () => {
    const dir = tempDir();
    try {
      const fake = createFakeWhisperx(dir);
      const output = join(dir, 'out.transcript.json');
      const plan = join(dir, 'out.plan.json');
      const result = spawnSync(process.execPath, [
        scriptPath,
        'run',
        '--media', fake.mediaPath,
        '--output', output,
        '--plan-output', plan,
        '--diarize',
        '--credential-provider', 'env:HF_TOKEN',
      ], { timeout: 60_000,
        cwd: resolve('.'),
        env: { ...process.env, PATH: `${fake.binDir}:${process.env.PATH}`, HF_TOKEN: '' },
        encoding: 'utf8',
      });

      expect(result.status).toBe(2);
      expect(existsSync(fake.markerPath)).toBe(false);
      expect(existsSync(output)).toBe(false);
      const planJson = JSON.parse(readFileSync(plan, 'utf8'));
      expect(planJson.schema).toBe('aiwg.media.transcript-plan.v1');
      expect(planJson.status).toBe('blocked-credential-missing');
      expect(planJson.credential_provider).toEqual({ type: 'env', name: 'HF_TOKEN' });
      expect(JSON.stringify(planJson)).not.toContain('top-secret-token');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('runs WhisperX with known speaker constraints without placing tokens on argv', () => {
    const dir = tempDir();
    try {
      const fake = createFakeWhisperx(dir);
      const output = join(dir, 'out.transcript.json');
      const result = spawnSync(process.execPath, [
        scriptPath,
        'run',
        '--media', fake.mediaPath,
        '--output', output,
        '--work-dir', join(dir, 'native'),
        '--diarize',
        '--credential-provider', 'env:HF_TOKEN',
        '--min-speakers', '2',
        '--max-speakers', '2',
      ], { timeout: 60_000,
        cwd: resolve('.'),
        env: { ...process.env, PATH: `${fake.binDir}:${process.env.PATH}`, HF_TOKEN: 'top-secret-token' },
        encoding: 'utf8',
      });

      expect(result.status).toBe(0);
      const sidecar = JSON.parse(readFileSync(output, 'utf8'));
      expect(sidecar.segments).toHaveLength(2);
      expect(new Set(sidecar.segments.map((segment) => segment.speaker)).size).toBe(2);
      const argvLog = readFileSync(fake.argvLogPath, 'utf8');
      expect(argvLog).toContain('--min_speakers');
      expect(argvLog).toContain('--max_speakers');
      expect(argvLog).not.toContain('top-secret-token');
      expect(JSON.stringify(sidecar)).not.toContain('top-secret-token');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('preserves partial transcription output as degraded when diarization exits non-zero', () => {
    const dir = tempDir();
    try {
      const fake = createFakeWhisperx(dir);
      const output = join(dir, 'out.transcript.json');
      const result = spawnSync(process.execPath, [
        scriptPath,
        'run',
        '--media', fake.mediaPath,
        '--output', output,
        '--work-dir', join(dir, 'native'),
        '--diarize',
        '--credential-provider', 'env:HF_TOKEN',
      ], { timeout: 60_000,
        cwd: resolve('.'),
        env: {
          ...process.env,
          PATH: `${fake.binDir}:${process.env.PATH}`,
          HF_TOKEN: 'top-secret-token',
          FAKE_WHISPERX_EXIT: '19',
        },
        encoding: 'utf8',
      });

      expect(result.status).toBe(0);
      const sidecar = JSON.parse(readFileSync(output, 'utf8'));
      expect(sidecar.transcript.quality.status).toBe('degraded-diarization-failed');
      expect(sidecar.transcript.quality.limitations.join(' ')).toMatch(/exited with code 19/i);
      expect(sidecar.provenance.used.some((entry) => basename(entry) === 'media.json')).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reports compute and credential state during preflight', () => {
    const result = preflight({
      adapter: 'whisperx',
      media: resolve('agentic/code/frameworks/media-curator/skills/transcribe-media/examples/sample.transcript.json'),
      output: join(tempDir(), 'out.json'),
      diarize: true,
      credentialProvider: 'env:HF_TOKEN',
    }, { HF_TOKEN: 'present' });

    expect(result.diarize).toBe(true);
    expect(result.credential_provider).toEqual({ type: 'env', name: 'HF_TOKEN' });
    expect(result.compute.tools).toHaveProperty('whisperx');
    expect(result.errors.some((error) => error.includes('Credential provider'))).toBe(false);
  });
});

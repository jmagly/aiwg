import type { AiwgConfig, DispatchHostThresholds } from './aiwg-config.js';
import type { HostResourceSample, HostResourceReaders } from './host-resource-runtime.mjs';
export interface HostResourceCap { threshold: string; limit?: number | null; running?: number }
export interface HostResourceReport {
  measured: HostResourceSample;
  freshness: {
    collectedAt: string | null; evaluatedAt: string | null; ageMs: number | null; maxAgeMs: number;
    status: 'fresh' | 'stale' | 'unavailable'; reason?: string;
  };
  thresholds: DispatchHostThresholds | null;
  origins: Record<string, string[]>;
  slots: number;
  ok: boolean;
  limits: Array<{ threshold: string; slots: number }>;
  failures: Array<{ signal: string; reason: string; actual?: number; threshold?: number }>;
  counting?: string;
  limitingThreshold?: string;
  groups: Array<{ group: string; maxParallel: number | null; slots: number | null; reason: string }>;
}
export function hostResourceReport(input?: {
  group?: string; config?: AiwgConfig; live?: HostResourceSample; readers?: HostResourceReaders; paths?: string[];
  thresholdOverlay?: DispatchHostThresholds; caps?: HostResourceCap[];
  now?: () => number;
}): HostResourceReport;

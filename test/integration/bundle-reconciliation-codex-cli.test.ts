// Keep the real Codex ownership cases in a separately balanced deployment file.
import 'vitest'; // Declare runner ownership; the shared cases import its test APIs.
import { registerProviderReconciliation } from '../helpers/bundle-reconciliation-provider-cases.js';

registerProviderReconciliation('codex');

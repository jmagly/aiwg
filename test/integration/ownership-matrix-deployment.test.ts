// The marketing full-copy deploy and redeploy belong to the serial release matrix.
import { describe } from 'vitest';
import { frameworkOwnershipTests } from '../helpers/ownership-deployment.js';

describe('release framework ownership matrix', () => {
  // A full-copy marketing deploy took 52 s on titan and over 180 s on a GitHub-hosted
  // runner (v2026.10.17 publish run 41108255527); the lane itself is bounded at 30 min.
  frameworkOwnershipTests('marketing', 'media-marketing-kit', 600_000);
});

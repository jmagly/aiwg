// The marketing full-copy deploy and redeploy belong to the serial release matrix.
import { describe } from 'vitest';
import { frameworkOwnershipTests } from '../helpers/ownership-deployment.js';

describe('release framework ownership matrix', () => {
  frameworkOwnershipTests('marketing', 'media-marketing-kit');
});

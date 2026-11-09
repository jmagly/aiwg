// Fake local worker: use the public check in the worker's actual cwd, without inherited approval state.
import { checkHitlAuthorization } from '../../../src/policy/hitl-check.js';
import { pendingAction } from './process-authorization.js';
const checked = await checkHitlAuthorization(process.cwd(), { ...pendingAction(), actor: `worker:${process.argv[2]}` });
process.stdout.write(JSON.stringify(checked));

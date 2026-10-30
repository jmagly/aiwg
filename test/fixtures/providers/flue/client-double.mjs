// Adapt the repository's SDK 1.x client to SDK 2.x callTool options for offline units.
import { Client as SdkClient } from '@modelcontextprotocol/sdk/client/index.js';
export class Client extends SdkClient {
  callTool(params, options) { return super.callTool(params, undefined, options); }
}

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { evaluationFixture } from './fixture.js';
const fixture = evaluationFixture();
await fixture.server.connect(new StdioServerTransport());
process.stdin.once('end', () => {
  void fixture.close();
});

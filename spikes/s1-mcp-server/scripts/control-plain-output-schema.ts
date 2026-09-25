// Control experiment: with a plain (success-only) outputSchema, does the TypeScript SDK
// client reject an isError result that carries the error envelope in structuredContent?
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const server = new Server({ name: 'control', version: '0' }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 't',
      inputSchema: { type: 'object' },
      outputSchema: { type: 'object', properties: { value: { type: 'number' } }, required: ['value'], additionalProperties: false },
    },
  ],
}));
server.setRequestHandler(CallToolRequestSchema, async () => ({
  isError: true,
  content: [{ type: 'text', text: 'No home.' }],
  structuredContent: { code: 'home_not_found', category: 'not_found', message: 'No home.', retryable: false },
}));

const [a, b] = InMemoryTransport.createLinkedPair();
await server.connect(a);
const client = new Client({ name: 'c', version: '0' });
await client.connect(b);
await client.listTools();
try {
  const r = await client.callTool({ name: 't', arguments: {} });
  console.log('ACCEPTED', JSON.stringify(r));
} catch (e) {
  console.log('REJECTED', e instanceof Error ? e.message : String(e));
}
await client.close();

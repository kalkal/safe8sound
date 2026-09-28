import { readFile } from 'node:fs/promises';
import type { CardAssets } from './card-resource.js';
import { createCardServer } from './handler.js';
import { startNodeServer } from './node-server.js';

const root = new URL('../../', import.meta.url);

// Read on every resources/read so a rebuilt card shows up without restarting the server.
async function loadAssets(): Promise<CardAssets> {
  const [tokensCss, cardCss, cardJs] = await Promise.all([
    readFile(new URL('generated/tokens.css', root), 'utf8'),
    readFile(new URL('src/card/card.css', root), 'utf8'),
    readFile(new URL('dist/card/card.js', root), 'utf8'),
  ]);
  return { tokensCss, cardCss, cardJs };
}

const port = Number(process.env['S3_MCP_PORT'] ?? 3100);
const handler = createCardServer({ loadAssets, logger: { log: (entry) => console.error(JSON.stringify(entry)) } });
const server = await startNodeServer(handler, { host: '127.0.0.1', port });
console.log(`S3 MCP server listening on ${server.url}`);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => void server.close().then(() => process.exit(0)));
}

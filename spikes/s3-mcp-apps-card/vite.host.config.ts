import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const mcpPort = Number(process.env['S3_MCP_PORT'] ?? 3100);

// The host page and /mcp share one origin through the proxy, so the spike needs no CORS.
export default defineConfig({
  root: 'src/host',
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    proxy: { '/mcp': `http://127.0.0.1:${mcpPort}` },
  },
});

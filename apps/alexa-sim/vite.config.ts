import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv } from 'vite';
import { phoneProxy, requirePhoneProxy } from './vite.phone-proxy.js';

export default defineConfig(({ mode }) => {
  const proxy = phoneProxy(process.env);
  requirePhoneProxy({ ...loadEnv(mode, process.cwd(), 'VITE_'), ...process.env }, proxy);
  return {
    plugins: [react()],
    // The family phone's /phone/inbox, with its token added here on the dev server (never in the bundle).
    server: { host: '127.0.0.1', port: 5318, strictPort: true, ...(proxy && { proxy }) },
  };
});

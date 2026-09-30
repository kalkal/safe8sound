import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// The ui:// card bundle: one ES module with everything inlined (React, ext-apps, Zod), so the card
// document needs no network. Built, never committed (decision in #21); CI builds it before the e2e tests.
export default defineConfig({
  plugins: [react()],
  define: { 'process.env.NODE_ENV': JSON.stringify('production') },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    minify: true,
    lib: { entry: 'src/app/main.tsx', formats: ['es'], fileName: () => 'card-app.js' },
    rolldownOptions: { output: { codeSplitting: false } },
  },
});

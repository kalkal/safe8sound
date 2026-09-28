import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// Single ES module for the card; the server inlines it into the ui:// resource HTML.
export default defineConfig({
  plugins: [react()],
  define: { 'process.env.NODE_ENV': JSON.stringify('production') },
  build: {
    outDir: 'dist/card',
    emptyOutDir: true,
    minify: true,
    lib: { entry: 'src/card/main.tsx', formats: ['es'], fileName: () => 'card.js' },
    rolldownOptions: { output: { codeSplitting: false } },
  },
});

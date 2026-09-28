import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  test: {
    include: ['test/**/*.test.{ts,tsx}'],
    // Threads instead of forks: this machine sometimes crashes new processes at startup (0xC0000005).
    pool: 'threads',
    maxWorkers: 2,
    testTimeout: 20_000,
  },
});

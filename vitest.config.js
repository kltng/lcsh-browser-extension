import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    setupFiles: ['./test/setup.js'],
    include: ['src/**/__tests__/*.test.js']
    // The ordinary timeout stays at the vitest default, so an unrelated hang is
    // still caught quickly. The one CPU-heavy test (the SPEC-P5 §12 row 8
    // 4 GiB vector) carries its own per-test override.
  }
});

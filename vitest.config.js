import { defineConfig } from 'vitest/config';

export default defineConfig({
  // SPEC-P5 §21: the hook tests run with the fault build's definition; the
  // shipped configurations define it as false (see faultsConfig.test.js).
  define: { __LCSH_FAULTS__: true },
  test: {
    environment: 'node',
    setupFiles: ['./test/setup.js'],
    include: ['src/**/__tests__/*.test.js']
    // The ordinary timeout stays at the vitest default, so an unrelated hang is
    // still caught quickly. The one CPU-heavy test (the SPEC-P5 §12 row 8
    // 4 GiB vector) carries its own per-test override.
  }
});

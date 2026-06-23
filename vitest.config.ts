import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Several suites (gateway, connector, server.integration, delegate, image,
    // search) spawn REAL downstream MCP child processes over stdio. Running those
    // files in parallel forks oversubscribes the machine, so subprocess handshakes
    // intermittently miss their timeouts — a flake that only shows under load.
    // Run test files sequentially for deterministic results; the suite is small,
    // so the modest wall-clock cost is worth a non-flaky public CI.
    fileParallelism: false,
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
});

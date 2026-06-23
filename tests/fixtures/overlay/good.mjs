// A minimal private-overlay module fixture. Proves the BYO path end-to-end:
// the loader imports this file and calls register(), which adds one tool.
export function register(server, deps) {
  server.registerTool(
    'overlay_demo',
    { description: 'Demo tool contributed by a private overlay module.', inputSchema: {} },
    async () => deps.text('hello from a private overlay module'),
  );
}

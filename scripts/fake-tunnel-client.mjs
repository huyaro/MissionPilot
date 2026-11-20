#!/usr/bin/env node
// Fake tunnel-client for tests — mimics `tunnel-client run`: serves /healthz
// on a random localhost port, writes the health URL to --health.url-file,
// stays alive. FAKE_TUNNEL_EXIT_AFTER_MS: exit(1) after that delay
// (to test the manager's restart behavior).
import { createServer } from 'node:http';
import { writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
const urlFileIdx = args.indexOf('--health.url-file');
const urlFile = urlFileIdx >= 0 ? args[urlFileIdx + 1] : null;

const server = createServer((req, res) => {
  if (req.url === '/healthz' || req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok' }));
  } else {
    res.writeHead(404);
    res.end();
  }
});

server.listen(0, '127.0.0.1', () => {
  const port = server.address().port;
  if (urlFile) writeFileSync(urlFile, `http://127.0.0.1:${port}/healthz`);
  process.stdout.write(`fake tunnel-client listening on 127.0.0.1:${port}\n`);
});

const exitAfter = Number(process.env.FAKE_TUNNEL_EXIT_AFTER_MS ?? 0);
if (exitAfter > 0) setTimeout(() => process.exit(1), exitAfter);

// Stay alive until killed.
setInterval(() => {}, 1000);

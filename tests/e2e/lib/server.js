import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';

const FIXTURES = new URL('../fixtures/', import.meta.url);
const PAGES = new Set(['page.html', 'other.html']);

// Serves the fixture pages on 127.0.0.1, on a port the system picks.
export async function startFixtureServer() {
  const server = createServer((request, response) => {
    const name = new URL(request.url, 'http://127.0.0.1').pathname.slice(1);
    if (!PAGES.has(name)) {
      response.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
      return;
    }
    readFile(new URL(name, FIXTURES)).then(
      (body) => response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(body),
      () => response.writeHead(500, { 'content-type': 'text/plain' }).end('unreadable fixture'),
    );
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  return {
    origin,
    url: (name) => `${origin}/${name}`,
    close: () => new Promise((resolve) => {
      server.closeAllConnections();
      server.close(resolve);
    }),
  };
}

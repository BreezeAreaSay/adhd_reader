/*
 * The test web server: the repository's files (fixtures, node_modules for the React app), a
 * server-rendered React page at /ssr-react, and documents the tests generate (serve()).
 */
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png' };
// Served with csp.html to check that the extension copes with a strict Content-Security-Policy.
const STRICT_CSP = "default-src 'self'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self'";

/**
 * A React 18 app rendered on the server (streaming, with a <Suspense> boundary) and hydrated in the
 * browser after `?hydrateAfter=` ms; the boundary's lazy part arrives `?lazyAfter=` ms after that.
 * Hydration errors are collected in window.__recoverable.
 */
function renderSsrPage(req, res) {
  const React = require('react');
  const { renderToPipeableStream } = require('react-dom/server');
  const makeSsrApp = require('./fixtures/ssr-app.js');
  const params = new URL(req.url, 'http://x').searchParams;
  const hydrateAfter = Number(params.get('hydrateAfter') || 0);
  const lazyAfter = Number(params.get('lazyAfter') || 0);
  const App = makeSsrApp(React, 0);
  const stream = renderToPipeableStream(React.createElement(App), {
    onAllReady() {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.write('<!doctype html><html lang="en"><head><meta charset="utf-8"><title>SSR</title></head><body><div id="root">');
      stream.pipe(res);
    },
  });
  const tail = `</div>
    <script src="/node_modules/react/umd/react.production.min.js"></script>
    <script src="/node_modules/react-dom/umd/react-dom.production.min.js"></script>
    <script src="/tests/fixtures/ssr-app.js"></script>
    <script>
      window.__recoverable = [];
      setTimeout(() => {
        ReactDOM.hydrateRoot(document.getElementById('root'), React.createElement(makeSsrApp(React, ${lazyAfter})), {
          onRecoverableError: (error) => window.__recoverable.push(String(error && error.message || error)),
        });
      }, ${hydrateAfter});
    </script></body></html>`;
  const end = res.end.bind(res);
  res.end = (chunk, ...rest) => {
    if (chunk) res.write(chunk);
    return end(tail, ...rest);
  };
}

/** Starts the server on a free port: { baseUrl, serve(pathname, body, headers) → url, close() }. */
async function startServer() {
  const routes = new Map(); // pathname → { body, headers }
  const server = http.createServer((req, res) => {
    const pathname = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    const file = path.join(ROOT, pathname);
    if (pathname === '/favicon.ico') {
      res.writeHead(204).end();
      return;
    }
    if (pathname === '/ssr-react') {
      renderSsrPage(req, res);
      return;
    }
    if (routes.has(pathname)) {
      const { body, headers } = routes.get(pathname);
      res.writeHead(200, { 'content-length': String(Buffer.byteLength(body)), ...headers });
      res.end(req.method === 'HEAD' ? undefined : body);
      return;
    }
    if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404).end();
      return;
    }
    const headers = { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' };
    if (pathname.endsWith('/csp.html')) headers['content-security-policy'] = STRICT_CSP;
    res.writeHead(200, headers);
    fs.createReadStream(file).pipe(res);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  return {
    baseUrl,
    serve(pathname, body, headers = {}) {
      routes.set(pathname, { body, headers });
      return `${baseUrl}${pathname}`;
    },
    close() {
      // Pages left open by a failed test keep connections alive, which would keep the process running.
      server.closeAllConnections();
      server.close();
    },
  };
}

module.exports = { startServer, ROOT };

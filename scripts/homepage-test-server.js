#!/usr/bin/env node
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createGzip } from 'node:zlib';

const ROOT = path.resolve(process.cwd(), 'public');
const PORT = Number(process.env.PORT || 4173);
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.wasm': 'application/wasm',
  '.txt': 'text/plain; charset=utf-8'
};

const server = http.createServer((req, res) => {
  let pathname;
  try { pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname); }
  catch { res.writeHead(400).end('Bad Request'); return; }

  if (pathname === '/') pathname = '/index.html';
  if (pathname.startsWith('/api/')) {
    res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: 'API is not part of the homepage static audit server' }));
    return;
  }

  const normalized = path.normalize(pathname).replace(/^(\.\.(\/|\\|$))+/, '');
  let file = path.resolve(ROOT, '.' + path.sep + normalized.replace(/^[/\\]+/, ''));
  if (!file.startsWith(ROOT + path.sep) && file !== path.join(ROOT, 'index.html')) {
    res.writeHead(403).end('Forbidden');
    return;
  }

  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
    // Firebase Hosting rewrites extensionless tool URLs to the shared tool shell.
    if (!path.extname(pathname)) file = path.join(ROOT, 'tool.html');
    else {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not Found');
      return;
    }
  }

  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.writeHead(404).end('Not Found');
    return;
  }
  const contentType = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
  const headers = {
    'Content-Type': contentType,
    'Cache-Control': 'no-store',
    'Vary': 'Accept-Encoding'
  };
  const acceptsGzip = /\\bgzip\\b/i.test(req.headers['accept-encoding'] || '');
  const compressible = /^(?:text\\/|application\\/(?:javascript|json|xml)|image\\/svg\\+xml)/i.test(contentType);
  if (acceptsGzip && compressible) {
    res.writeHead(200, { ...headers, 'Content-Encoding': 'gzip' });
    fs.createReadStream(file).pipe(createGzip({ level: 6 })).pipe(res);
  } else {
    res.writeHead(200, headers);
    fs.createReadStream(file).pipe(res);
  }
});

server.listen(PORT, '127.0.0.1', () => console.log('Homepage test server listening on http://127.0.0.1:' + PORT));

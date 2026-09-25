import { createReadStream, existsSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import { timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import {
  buildSources,
  go2rtcDocument,
  mergeForPreview,
  normalize,
  readCameras,
  toPublic,
  types,
  writeCameras,
} from './cameras.js';
import {
  PUBLIC_DIR,
  loadConfig,
  publicBase,
  webrtcCandidates,
} from './config.js';
import { createGo2rtc } from './go2rtc.js';

const config = await loadConfig();
const go2rtc = createGo2rtc();
let cameras = await readCameras();

function cameraHosts() {
  const hosts = [];
  for (const camera of cameras) {
    const raw = camera.host || '';
    if (raw && !raw.includes('/')) hosts.push(raw);
    if (camera.url) {
      try { hosts.push(new URL(camera.url).hostname); } catch { /* skip a partial URL */ }
    }
  }
  return hosts;
}

async function persistGo2rtc() {
  await go2rtc.writeYaml(go2rtcDocument(cameras, webrtcCandidates(config, cameraHosts())));
}

async function refreshStreams(names) {
  await persistGo2rtc();
  const work = async () => {
    if (!go2rtc.running) await go2rtc.start();
    for (const name of names) {
      const camera = cameras.find((item) => item.id === name || item.id === name.replace(/_sub$/, ''));
      if (!camera) {
        await go2rtc.removeStream(name);
        continue;
      }
      const sources = buildSources(camera);
      const source = name.endsWith('_sub') ? sources.sub : sources.main;
      await go2rtc.replaceStream(name, source);
    }
    await persistGo2rtc();
  };
  try {
    await work();
  } catch (error) {
    console.error(`[go2rtc] reload failed (${error.message}), restarting`);
    await persistGo2rtc();
    await go2rtc.stop();
    await go2rtc.start();
  }
}

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

function loopback(req) {
  const address = req.socket.remoteAddress || '';
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

function authorized(req) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  const left = Buffer.from(token);
  const right = Buffer.from(config.token);
  if (left.length !== right.length || left.length === 0) return false;
  return timingSafeEqual(left, right);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 1_000_000) {
        reject(new Error('Request is too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!chunks.length) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new Error('Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

function present(camera, req, info) {
  return toPublic(camera, info, publicBase(config, req));
}

async function handleApi(req, res, pathname) {
  if (req.method === 'GET' && pathname === '/api/v1/session') {
    if (!loopback(req)) {
      json(res, 401, { error: 'Enter the API token from data/config.yaml' });
      return;
    }
    json(res, 200, { token: config.token });
    return;
  }

  if (!authorized(req)) {
    json(res, 401, { error: 'Sign in with the API token' });
    return;
  }

  if (req.method === 'GET' && pathname === '/api/v1/presets') {
    json(res, 200, { types: types() });
    return;
  }

  if (req.method === 'GET' && pathname === '/api/v1/go2rtc') {
    json(res, 200, await go2rtc.info());
    return;
  }

  if (req.method === 'POST' && pathname === '/api/v1/go2rtc/update') {
    try {
      json(res, 200, await go2rtc.update());
    } catch (error) {
      json(res, 502, { error: error.message });
    }
    return;
  }

  if (req.method === 'GET' && pathname === '/api/v1/cameras') {
    const info = await go2rtc.listStreams();
    const list = cameras.map((camera) => {
      try {
        return present(camera, req, info);
      } catch (error) {
        return { id: camera.id, name: camera.name, type: camera.type, status: 'offline', error: error.message };
      }
    });
    json(res, 200, { cameras: list });
    return;
  }

  if (req.method === 'POST' && pathname === '/api/v1/cameras/preview') {
    const body = await readBody(req);
    try {
      const existing = cameras.find((camera) => camera.id === body.id);
      const camera = mergeForPreview(body, existing);
      json(res, 200, { maskedUrl: buildSources(camera).masked });
    } catch (error) {
      json(res, 200, { maskedUrl: '', error: error.message });
    }
    return;
  }

  if (req.method === 'POST' && pathname === '/api/v1/cameras/test') {
    const body = await readBody(req);
    try {
      const existing = cameras.find((camera) => camera.id === body.id);
      const camera = normalize(body, cameras, existing);
      const sources = buildSources(camera);
      await go2rtc.replaceStream('__probe', sources.main);
      const picture = await go2rtc.snapshot('__probe');
      json(res, 200, { ok: true, snapshot: `data:image/jpeg;base64,${picture.toString('base64')}` });
    } catch (error) {
      json(res, 200, { ok: false, error: error.message || 'Camera did not answer' });
    } finally {
      await go2rtc.removeStream('__probe').catch(() => {});
      await persistGo2rtc().catch(() => {});
    }
    return;
  }

  if (req.method === 'POST' && pathname === '/api/v1/cameras') {
    const body = await readBody(req);
    const camera = normalize(body, cameras, null);
    cameras = [...cameras, camera];
    await writeCameras(cameras);
    await refreshStreams([camera.id, `${camera.id}_sub`]);
    const info = await go2rtc.listStreams();
    json(res, 201, present(camera, req, info));
    return;
  }

  const one = pathname.match(/^\/api\/v1\/cameras\/([a-z0-9][a-z0-9_-]{0,40})$/);
  if (one) {
    const id = one[1];
    const index = cameras.findIndex((camera) => camera.id === id);
    if (index < 0) {
      json(res, 404, { error: 'Camera not found' });
      return;
    }
    if (req.method === 'GET') {
      const info = await go2rtc.listStreams();
      json(res, 200, present(cameras[index], req, info));
      return;
    }
    if (req.method === 'PUT') {
      const body = await readBody(req);
      const camera = normalize(body, cameras, cameras[index]);
      cameras = cameras.map((item) => (item.id === id ? camera : item));
      await writeCameras(cameras);
      await refreshStreams([id, `${id}_sub`]);
      const info = await go2rtc.listStreams();
      json(res, 200, present(camera, req, info));
      return;
    }
    if (req.method === 'DELETE') {
      cameras = cameras.filter((camera) => camera.id !== id);
      await writeCameras(cameras);
      await refreshStreams([id, `${id}_sub`]);
      json(res, 200, { ok: true });
      return;
    }
  }

  json(res, 404, { error: 'Not found' });
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

async function handleStatic(req, res, pathname) {
  const requestPath = pathname === '/' ? '/index.html' : pathname;
  const filePath = path.normalize(path.join(PUBLIC_DIR, requestPath));
  const relative = path.relative(PUBLIC_DIR, filePath);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    res.writeHead(403);
    res.end();
    return;
  }
  try {
    const info = await stat(filePath);
    if (!info.isFile()) throw new Error('not a file');
    const type = MIME[path.extname(filePath)] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-cache' });
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    createReadStream(filePath).pipe(res);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not found');
  }
}

function proxyWeb(req, res) {
  const headers = { ...req.headers, host: '127.0.0.1:1984' };
  const upstream = http.request({
    hostname: '127.0.0.1',
    port: 1984,
    path: req.url,
    method: req.method,
    headers,
  }, (upstreamRes) => {
    res.writeHead(upstreamRes.statusCode || 502, upstreamRes.headers);
    upstreamRes.pipe(res);
  });
  upstream.on('error', () => {
    if (!res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Restreamer is not running');
    } else {
      res.end();
    }
  });
  req.pipe(upstream);
}

function proxyWs(req, socket, head) {
  const upstream = net.connect(1984, '127.0.0.1', () => {
    let raw = `${req.method} ${req.url} HTTP/1.1\r\n`;
    for (const [key, value] of Object.entries(req.headers)) {
      if (key.toLowerCase() === 'host') continue;
      const items = Array.isArray(value) ? value : [value];
      for (const item of items) raw += `${key}: ${item}\r\n`;
    }
    raw += 'host: 127.0.0.1:1984\r\n\r\n';
    upstream.write(raw);
    if (head?.length) upstream.write(head);
    upstream.pipe(socket);
    socket.pipe(upstream);
  });
  const fail = () => {
    socket.destroy();
    upstream.destroy();
  };
  upstream.on('error', fail);
  socket.on('error', fail);
}

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
}

const server = http.createServer(async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }
  const url = new URL(req.url || '/', 'http://localhost');
  try {
    if (url.pathname.startsWith('/api/')) {
      await handleApi(req, res, url.pathname);
      return;
    }
    if (url.pathname === '/rtc' || url.pathname.startsWith('/rtc/')) {
      req.url = url.pathname.slice(4) + url.search || '/';
      if (!req.url.startsWith('/')) req.url = `/${req.url}`;
      proxyWeb(req, res);
      return;
    }
    await handleStatic(req, res, decodeURIComponent(url.pathname));
  } catch (error) {
    if (!res.headersSent) json(res, 400, { error: error.message || 'Request failed' });
  }
});

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url || '/', 'http://localhost');
  if (!(url.pathname === '/rtc' || url.pathname.startsWith('/rtc/'))) {
    socket.destroy();
    return;
  }
  req.url = `${url.pathname.slice(4)}${url.search}` || '/';
  if (!req.url.startsWith('/')) req.url = `/${req.url}`;
  proxyWs(req, socket, head);
});

async function shutdown() {
  await go2rtc.stop();
  server.close();
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

await persistGo2rtc();
try {
  await go2rtc.ensureBinary();
  await go2rtc.start();
} catch (error) {
  console.error(`[go2rtc] ${error.message}`);
}

server.listen(config.port, config.host, () => {
  const ips = webrtcCandidates(config, cameraHosts()).filter((item) => !item.startsWith('127.0.0.1'));
  const links = ips.slice(0, 3).map((item) => `http://${item.replace(':8555', `:${config.port}`)}`);
  console.log(`PrismCam is ready at http://127.0.0.1:${config.port}`);
  if (links.length) console.log(`On this network: ${links.join('  ')}`);
  if (existsSync('/.dockerenv') && !config.publicHost) {
    console.log('Set PRISMCAM_PUBLIC_HOST to this machine’s LAN address so phones can play video.');
  }
  if (config.created) console.log('API token created in data/config.yaml');
});

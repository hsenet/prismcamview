import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { stringify } from './yaml.js';
import {
  BIN_DIR,
  GO2RTC_ARCHIVE,
  GO2RTC_ASSET,
  GO2RTC_CONFIG_PATH,
  GO2RTC_EXE,
  PINNED_GO2RTC,
  VERSION_PATH,
} from './config.js';

const execFileAsync = promisify(execFile);
const API = 'http://127.0.0.1:1984';
const RELEASES = 'https://api.github.com/repos/AlexxIT/go2rtc/releases/latest';

function compareVersions(left, right) {
  const parse = (value) => String(value || '').replace(/^v/, '').split('.').map((part) => Number(part) || 0);
  const a = parse(left);
  const b = parse(right);
  const length = Math.max(a.length, b.length);
  for (let i = 0; i < length; i += 1) {
    const delta = (a[i] || 0) - (b[i] || 0);
    if (delta !== 0) return delta;
  }
  return 0;
}

async function unzip(zipPath, destination) {
  await mkdir(destination, { recursive: true });
  const zip = zipPath.replace(/'/g, "''");
  const dest = destination.replace(/'/g, "''");
  await execFileAsync('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    `Expand-Archive -LiteralPath '${zip}' -DestinationPath '${dest}' -Force`,
  ]);
}

async function findBinary(dir, binaryName) {
  const { readdir } = await import('node:fs/promises');
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isFile() && entry.name.toLowerCase() === binaryName.toLowerCase()) return full;
    if (entry.isDirectory()) {
      const nested = await findBinary(full, binaryName);
      if (nested) return nested;
    }
  }
  return null;
}

async function downloadFile(url, destination) {
  const response = await fetch(url, {
    headers: { 'User-Agent': 'prismcamview' },
    redirect: 'follow',
  });
  if (!response.ok) throw new Error(`Download failed (${response.status}) for ${url}`);
  await pipeline(response.body, createWriteStream(destination));
}

export function createGo2rtc() {
  let child = null;
  let stopping = false;
  let version = '';
  let latestCache = { at: 0, tag: '' };
  let chain = Promise.resolve();
  let updateLock = false;

  function queue(task) {
    const run = chain.then(task, task);
    chain = run.then(() => {}, () => {});
    return run;
  }

  async function readVersion() {
    try {
      version = (await readFile(VERSION_PATH, 'utf8')).trim();
    } catch {
      version = '';
    }
    return version;
  }

  async function ensureBinary() {
    await mkdir(BIN_DIR, { recursive: true });
    await readVersion();
    try {
      await readFile(GO2RTC_EXE);
      if (!version) {
        version = PINNED_GO2RTC;
        await writeFile(VERSION_PATH, `${version}\n`);
      }
      return version;
    } catch {
      /* download the pinned release */
    }
    await installRelease(PINNED_GO2RTC, { replace: false });
    return version;
  }

  async function installRelease(tag, { replace }) {
    const url = `https://github.com/AlexxIT/go2rtc/releases/download/${tag}/${GO2RTC_ASSET}`;
    const staging = path.join(BIN_DIR, 'staging');
    const downloadPath = path.join(BIN_DIR, GO2RTC_ARCHIVE ? 'go2rtc.zip' : path.basename(GO2RTC_EXE));
    const binaryName = path.basename(GO2RTC_EXE);
    await rm(staging, { recursive: true, force: true });
    await mkdir(staging, { recursive: true });
    console.log(`[go2rtc] downloading ${tag} (${GO2RTC_ASSET})`);
    let exe;
    if (GO2RTC_ARCHIVE) {
      await downloadFile(url, downloadPath);
      await unzip(downloadPath, staging);
      exe = await findBinary(staging, binaryName);
    } else {
      exe = path.join(staging, binaryName);
      await downloadFile(url, exe);
    }
    if (!exe) throw new Error(`Downloaded release did not contain ${binaryName}`);
    if (process.platform !== 'win32') await chmod(exe, 0o755);
    if (replace) await stop();
    const backup = `${GO2RTC_EXE}.bak`;
    let backedUp = false;
    try {
      await moveFile(GO2RTC_EXE, backup);
      backedUp = true;
    } catch {
      /* first install */
    }
    try {
      await moveFile(exe, GO2RTC_EXE);
      await writeFile(VERSION_PATH, `${tag}\n`);
      version = tag;
    } catch (error) {
      if (backedUp) {
        try { await moveFile(backup, GO2RTC_EXE); } catch { /* keep the failed message */ }
      }
      throw error;
    }
    await rm(staging, { recursive: true, force: true });
    if (GO2RTC_ARCHIVE) await rm(downloadPath, { force: true });
    console.log(`[go2rtc] installed ${tag}`);
  }

  async function latestRelease() {
    if (Date.now() - latestCache.at < 60 * 60 * 1000 && latestCache.tag) return latestCache.tag;
    const response = await fetch(RELEASES, {
      headers: {
        'User-Agent': 'prismcamview',
        Accept: 'application/vnd.github+json',
      },
    });
    if (!response.ok) throw new Error(`GitHub returned ${response.status}`);
    const body = await response.json();
    latestCache = { at: Date.now(), tag: body.tag_name || '' };
    return latestCache.tag;
  }

  function start() {
    if (child) return Promise.resolve();
    stopping = false;
    return new Promise((resolve, reject) => {
      const proc = spawn(GO2RTC_EXE, ['-config', GO2RTC_CONFIG_PATH], {
        cwd: path.dirname(GO2RTC_CONFIG_PATH),
        windowsHide: true,
      });
      proc.intentional = false;
      child = proc;
      let settled = false;
      const fail = (error) => {
        if (settled) return;
        settled = true;
        reject(error);
      };
      proc.once('error', fail);
      proc.stdout.on('data', (chunk) => process.stdout.write(`[go2rtc] ${chunk}`));
      proc.stderr.on('data', (chunk) => process.stderr.write(`[go2rtc] ${chunk}`));
      proc.once('exit', (code) => {
        if (child === proc) child = null;
        if (!settled) {
          fail(new Error(`go2rtc exited with code ${code}`));
          return;
        }
        if (!proc.intentional && !stopping) {
          console.error('[go2rtc] exited, restarting in 1s');
          setTimeout(() => {
            start().catch((error) => console.error('[go2rtc]', error.message));
          }, 1000);
        }
      });
      waitReady().then(() => {
        settled = true;
        resolve();
      }).catch((error) => {
        proc.intentional = true;
        proc.kill();
        fail(error);
      });
    });
  }

  async function waitReady() {
    for (let i = 0; i < 50; i += 1) {
      try {
        const response = await fetch(`${API}/api`, { signal: AbortSignal.timeout(500) });
        if (response.ok || response.status === 401) return;
      } catch {
        /* still starting */
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    throw new Error('go2rtc did not open its API on 127.0.0.1:1984');
  }

  function stop() {
    stopping = true;
    const proc = child;
    child = null;
    if (!proc) return Promise.resolve();
    proc.intentional = true;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        proc.kill();
        resolve();
      }, 4000);
      proc.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
      proc.kill();
    });
  }

  async function moveFile(from, to) {
    let last;
    for (let attempt = 0; attempt < 10; attempt += 1) {
      try {
        await rename(from, to);
        return;
      } catch (error) {
        last = error;
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
    }
    throw last;
  }

  async function request(method, pathname, { timeout = 8000, raw = false } = {}) {
    const response = await fetch(`${API}${pathname}`, {
      method,
      signal: AbortSignal.timeout(timeout),
    });
    if (raw) {
      const buffer = Buffer.from(await response.arrayBuffer());
      if (!response.ok) {
        throw new Error(buffer.toString('utf8').trim() || `go2rtc ${response.status}`);
      }
      return buffer;
    }
    const text = await response.text();
    if (!response.ok) throw new Error(text.trim() || `go2rtc ${response.status}`);
    if (!text) return null;
    try { return JSON.parse(text); } catch { return text; }
  }

  async function listStreams() {
    try {
      return await queue(() => request('GET', '/api/streams'));
    } catch {
      return {};
    }
  }

  async function replaceStream(name, source) {
    return queue(async () => {
      const del = new URLSearchParams({ src: name });
      await request('DELETE', `/api/streams?${del}`).catch(() => {});
      const patch = new URLSearchParams({ name, src: source });
      await request('PATCH', `/api/streams?${patch}`);
    });
  }

  async function removeStream(name) {
    return queue(async () => {
      const del = new URLSearchParams({ src: name });
      await request('DELETE', `/api/streams?${del}`).catch(() => {});
    });
  }

  async function snapshot(name) {
    const query = new URLSearchParams({ src: name });
    const buffer = await queue(() => request('GET', `/api/frame.jpeg?${query}`, { timeout: 20000, raw: true }));
    if (!buffer || buffer.length < 32 || buffer[0] !== 0xff || buffer[1] !== 0xd8) {
      throw new Error('Camera did not return a picture');
    }
    return buffer;
  }

  async function writeYaml(document) {
    await writeFile(GO2RTC_CONFIG_PATH, stringify(document));
  }

  async function info() {
    await readVersion();
    let latest = '';
    let updateAvailable = false;
    try {
      latest = await latestRelease();
      updateAvailable = Boolean(latest) && compareVersions(latest, version) > 0;
    } catch {
      latest = '';
    }
    return {
      version: version || null,
      latest: latest || null,
      updateAvailable,
      running: Boolean(child),
    };
  }

  async function update() {
    if (updateLock) throw new Error('An update is already running');
    updateLock = true;
    try {
      const tag = await latestRelease();
      if (!tag) throw new Error('Could not read the latest go2rtc release');
      await readVersion();
      if (compareVersions(tag, version) <= 0) {
        return { version, latest: tag, updateAvailable: false, running: Boolean(child) };
      }
      await installRelease(tag, { replace: true });
      await start();
      return info();
    } finally {
      updateLock = false;
    }
  }

  return {
    ensureBinary,
    start,
    stop,
    info,
    update,
    listStreams,
    replaceStream,
    removeStream,
    snapshot,
    writeYaml,
    get running() { return Boolean(child); },
  };
}

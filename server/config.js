import { randomBytes } from 'node:crypto';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parse, stringify } from './yaml.js';

export const ROOT = path.resolve(import.meta.dirname, '..');
export const DATA_DIR = path.join(ROOT, 'data');
export const PUBLIC_DIR = path.join(ROOT, 'public');
export const CONFIG_PATH = path.join(DATA_DIR, 'config.yaml');
export const CAMERAS_PATH = path.join(DATA_DIR, 'cameras.yaml');
export const GO2RTC_CONFIG_PATH = path.join(DATA_DIR, 'go2rtc.yaml');
export const BIN_DIR = path.join(DATA_DIR, 'bin');
export const VERSION_PATH = path.join(DATA_DIR, 'go2rtc.version');

export const PINNED_GO2RTC = 'v1.9.14';

// SHA-256 of the v1.9.14 GitHub release assets this server can install.
export const PINNED_GO2RTC_SHA256 = {
  'go2rtc_win64.zip': 'dd4167d75cb04abe618855b7c71f8658bd009f60c1a71835d134d2c11c939907',
  'go2rtc_win_arm64.zip': '814be0f6d8669025c7bccdd1f026ffaf613abae5352239f4ec84de543b94594a',
  go2rtc_linux_amd64: '32d616af226bd731678ffde328b94cfb94e30339bfefc469cfb76323144615a6',
  go2rtc_linux_arm64: '359fabade8a7a51e81a55fe6df6b0ef81764a5e1d63179577534eaaa71904b50',
  'go2rtc_mac_arm64.zip': '919b78adc759d6b3883d1e1b2ac915ac0985bb903ff1897b4d228527bd64690c',
  'go2rtc_mac_amd64.zip': '9b0b9a27a4dc3a5b8b93376e7e8fc2787c6af624a512842622be84aec0171c7a',
};
export const DEFAULT_PORT = 8787;

export function go2rtcPackage() {
  const { platform, arch } = process;
  if (platform === 'win32' && arch === 'x64') return { asset: 'go2rtc_win64.zip', binaryName: 'go2rtc.exe', archive: true };
  if (platform === 'win32' && arch === 'arm64') return { asset: 'go2rtc_win_arm64.zip', binaryName: 'go2rtc.exe', archive: true };
  if (platform === 'linux' && arch === 'x64') return { asset: 'go2rtc_linux_amd64', binaryName: 'go2rtc', archive: false };
  if (platform === 'linux' && arch === 'arm64') return { asset: 'go2rtc_linux_arm64', binaryName: 'go2rtc', archive: false };
  if (platform === 'darwin' && arch === 'arm64') return { asset: 'go2rtc_mac_arm64.zip', binaryName: 'go2rtc', archive: true };
  if (platform === 'darwin' && arch === 'x64') return { asset: 'go2rtc_mac_amd64.zip', binaryName: 'go2rtc', archive: true };
  throw new Error(`No go2rtc build for ${platform} ${arch}`);
}

const go2rtcBuild = go2rtcPackage();
export const GO2RTC_ASSET = go2rtcBuild.asset;
export const GO2RTC_EXE = path.join(BIN_DIR, go2rtcBuild.binaryName);
export const GO2RTC_ARCHIVE = go2rtcBuild.archive;

export function lanAddresses() {
  const ips = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const net of list || []) {
      const family = net.family;
      if (net.internal) continue;
      if (family !== 'IPv4' && family !== 4) continue;
      if (net.address.startsWith('169.254.')) continue;
      ips.push(net.address);
    }
  }
  const rank = (ip) => {
    if (ip.startsWith('192.168.')) return 0;
    if (ip.startsWith('10.')) return 1;
    if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(ip)) return 2;
    return 3;
  };
  return [...new Set(ips)].sort((a, b) => rank(a) - rank(b));
}

function prefixScore(ip, hosts) {
  return Math.max(0, ...hosts.map((host) => {
    const a = String(ip).split('.');
    const b = String(host).split('.');
    let score = 0;
    for (let i = 0; i < 4; i += 1) {
      if (a[i] !== b[i]) break;
      score += 1;
    }
    return score;
  }));
}

export function webrtcCandidates(config, hosts = []) {
  const override = String(config.publicHost || '').trim().replace(/^https?:\/\//, '').replace(/:\d+$/, '');
  const ips = override ? [override] : lanAddresses();
  const unique = [...new Set(ips)].sort((a, b) => prefixScore(b, hosts) - prefixScore(a, hosts));
  const candidates = unique.map((ip) => `${ip}:8555`);
  if (!candidates.includes('127.0.0.1:8555')) candidates.push('127.0.0.1:8555');
  return candidates;
}

function defaultConfig() {
  return {
    listen: `0.0.0.0:${DEFAULT_PORT}`,
    token: randomBytes(24).toString('hex'),
    publicHost: '',
  };
}

export async function writePrivate(file, contents) {
  await writeFile(file, contents, { mode: 0o600 });
  try {
    await chmod(file, 0o600);
  } catch {
    /* Windows does not apply Unix file modes */
  }
}

export async function loadConfig() {
  await mkdir(DATA_DIR, { recursive: true });
  let created = false;
  let file;
  try {
    file = await readFile(CONFIG_PATH, 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const fresh = defaultConfig();
    await writePrivate(CONFIG_PATH, stringify(fresh));
    created = true;
    file = stringify(fresh);
  }
  const parsed = parse(file) || {};
  const config = {
    listen: String(parsed.listen || `0.0.0.0:${DEFAULT_PORT}`),
    token: String(parsed.token || ''),
    publicHost: String(process.env.PRISMCAM_PUBLIC_HOST || parsed.publicHost || '').trim(),
  };
  if (!config.token) {
    config.token = randomBytes(24).toString('hex');
    await writePrivate(CONFIG_PATH, stringify(config));
    created = true;
  }
  const match = config.listen.match(/^(.*):(\d+)$/);
  if (!match) throw new Error(`config.yaml listen must look like 0.0.0.0:${DEFAULT_PORT}`);
  return {
    ...config,
    host: match[1] || '0.0.0.0',
    port: Number(match[2]),
    created,
  };
}

export function publicBase(config, req) {
  const configured = String(config.publicHost || '').trim();
  if (configured) {
    if (/^https?:\/\//.test(configured)) return configured.replace(/\/$/, '');
    const withPort = configured.includes(':') ? configured : `${configured}:${config.port}`;
    return `http://${withPort}`;
  }
  const host = req?.headers?.host || `127.0.0.1:${config.port}`;
  return `http://${host}`;
}

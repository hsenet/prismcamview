import { readFile, writeFile } from 'node:fs/promises';
import { parse, stringify } from './yaml.js';
import { CAMERAS_PATH } from './config.js';
import {
  CAMERA_TYPES,
  buildSources,
  hostOf,
  isCameraType,
  localSub,
  maskRtsp,
} from './presets.js';

const ID_RE = /^[a-z0-9][a-z0-9_-]{0,40}$/;

function slug(name) {
  const base = String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40);
  return base || 'camera';
}

function uniqueId(name, cameras, preferred) {
  const want = preferred && ID_RE.test(preferred) ? preferred : slug(name);
  if (!cameras.some((camera) => camera.id === want)) return want;
  let n = 2;
  while (cameras.some((camera) => camera.id === `${want}-${n}`)) n += 1;
  return `${want}-${n}`.slice(0, 41);
}

function restoreSecret(url, previous) {
  if (!url || !url.includes('••••') || !previous) return url;
  const nextHost = hostOf(url.replaceAll('••••', 'x'));
  const prevHost = hostOf(previous);
  if (!nextHost || nextHost !== prevHost) return url;
  const match = String(previous).match(/\/\/(?:[^/@]*:)([^@]*)@/);
  const password = match ? decodeURIComponent(match[1]) : '';
  if (!password) return url;
  return url.replaceAll('••••', password);
}

export function playback(base, streamId) {
  const root = base.replace(/\/$/, '');
  const wsRoot = root.replace(/^http/, 'ws');
  const query = `src=${encodeURIComponent(streamId)}`;
  return {
    webrtc: `${wsRoot}/rtc/api/ws?${query}`,
    whep: `${root}/rtc/api/webrtc?${query}`,
    hls: `${root}/rtc/api/stream.m3u8?${query}&mp4`,
    snapshot: `${root}/rtc/api/frame.jpeg?${query}`,
  };
}

function producerLive(producer) {
  if (!producer || typeof producer !== 'object') return false;
  if (Array.isArray(producer.receivers) && producer.receivers.length > 0) return true;
  if (Number(producer.bytes_recv) > 0) return true;
  if (Array.isArray(producer.medias) && producer.medias.length > 0) return true;
  return false;
}

export function streamStatus(info, id) {
  const names = [id, `${id}_sub`];
  const present = names.some((name) => info?.[name]);
  const live = names.some((name) => (info?.[name]?.producers || []).some(producerLive));
  if (live) return 'live';
  if (present) return 'connecting';
  return 'offline';
}

function publicFields(camera, sources) {
  return {
    id: camera.id,
    name: camera.name,
    type: camera.type,
    host: sources.host || camera.host || '',
    port: Number(camera.port) || 554,
    username: camera.username || '',
    channel: Number(camera.channel) || 1,
    pathStyle: camera.pathStyle || 'hikvision',
    path: camera.path || '',
    subPath: camera.subPath || '',
    url: camera.type === 'generic' ? maskRtsp(camera.url) : '',
    subUrl: camera.type === 'generic' && camera.subUrl ? maskRtsp(camera.subUrl) : '',
    hasPassword: Boolean(camera.password || (camera.url && camera.url.includes('@'))),
    maskedUrl: sources.masked,
  };
}

export function toPublic(camera, info, base) {
  const sources = buildSources(camera);
  return {
    ...publicFields(camera, sources),
    status: streamStatus(info, camera.id),
    streams: {
      main: playback(base, camera.id),
      sub: playback(base, `${camera.id}_sub`),
    },
  };
}

export async function readCameras() {
  let file;
  try {
    file = await readFile(CAMERAS_PATH, 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return [];
  }
  const parsed = parse(file) || {};
  const list = Array.isArray(parsed) ? parsed : parsed.cameras;
  return Array.isArray(list) ? list : [];
}

export async function writeCameras(cameras) {
  const body = stringify({ cameras });
  await writeFile(CAMERAS_PATH, body);
}

export function streamMap(cameras) {
  const streams = {};
  for (const camera of cameras) {
    const sources = buildSources(camera);
    streams[camera.id] = [sources.main];
    streams[`${camera.id}_sub`] = [sources.sub];
  }
  return streams;
}

export function go2rtcDocument(cameras, candidates, apiPassword) {
  return {
    log: { level: 'info' },
    api: {
      listen: '127.0.0.1:1984',
      username: 'prism',
      password: apiPassword,
    },
    rtsp: {
      listen: '127.0.0.1:8554',
    },
    webrtc: {
      listen: ':8555',
      candidates,
    },
    streams: streamMap(cameras),
  };
}

function cleanText(value, max = 200) {
  return String(value ?? '').trim().slice(0, max);
}

export function normalize(input, cameras, existing) {
  const body = input && typeof input === 'object' ? input : {};
  const type = cleanText(body.type, 40);
  if (!isCameraType(type)) throw new Error('Choose a camera type');
  const name = cleanText(body.name, 80);
  if (!name) throw new Error('Name is required');

  const id = existing
    ? existing.id
    : uniqueId(name, cameras, cleanText(body.id, 41));
  if (!ID_RE.test(id)) throw new Error('Camera id must use letters, numbers, dashes, or underscores');

  const camera = {
    id,
    name,
    type,
    host: cleanText(body.host, 200),
    port: Number(body.port) || Number(existing?.port) || 554,
    username: cleanText(body.username, 120),
    password: cleanText(body.password, 200) || existing?.password || '',
    channel: Number(body.channel) || Number(existing?.channel) || 1,
    pathStyle: cleanText(body.pathStyle, 40) || existing?.pathStyle || 'hikvision',
    path: cleanText(body.path, 300) || (body.path === '' ? '' : existing?.path || ''),
    subPath: cleanText(body.subPath, 300) || (body.subPath === '' ? '' : existing?.subPath || ''),
  };

  if (type === 'generic') {
    const incoming = cleanText(body.url, 1000);
    const subIncoming = cleanText(body.subUrl, 1000);
    if (!incoming) camera.url = existing?.url || '';
    else camera.url = restoreSecret(incoming, existing?.url);
    if (subIncoming.includes('••••')) camera.subUrl = restoreSecret(subIncoming, existing?.subUrl);
    else camera.subUrl = subIncoming || '';
    if (String(camera.url).includes('••••') || String(camera.subUrl || '').includes('••••')) {
      throw new Error('Re-enter the password when the camera address changes');
    }
    if (!camera.url) throw new Error('Paste an RTSP URL');
    delete camera.password;
  } else if (!camera.password && !existing?.password) {
    throw new Error('Password is required');
  }

  if (!['hikvision', 'h264', 'custom'].includes(camera.pathStyle)) camera.pathStyle = 'hikvision';
  buildSources(camera);
  return camera;
}

export function mergeForPreview(input, existing) {
  const body = input && typeof input === 'object' ? input : {};
  const type = cleanText(body.type, 40) || existing?.type || 'generic';
  const camera = {
    id: existing?.id || 'preview',
    name: cleanText(body.name, 80) || existing?.name || 'Preview',
    type,
    host: cleanText(body.host, 200),
    port: Number(body.port) || 554,
    username: cleanText(body.username, 120),
    password: cleanText(body.password, 200) || existing?.password || '',
    channel: Number(body.channel) || 1,
    pathStyle: cleanText(body.pathStyle, 40) || 'hikvision',
    path: cleanText(body.path, 300),
    subPath: cleanText(body.subPath, 300),
    url: restoreSecret(cleanText(body.url, 1000), existing?.url) || '',
    subUrl: restoreSecret(cleanText(body.subUrl, 1000), existing?.subUrl) || '',
  };
  if (type !== 'generic' && !camera.password) camera.password = '';
  return camera;
}

export function types() {
  return CAMERA_TYPES;
}

export { buildSources, hostOf, localSub, maskRtsp };

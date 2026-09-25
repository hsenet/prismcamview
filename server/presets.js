export const CAMERA_TYPES = [
  { id: 'hikvision', label: 'Hikvision' },
  { id: 'ezviz', label: 'Ezviz' },
  { id: 'tapo', label: 'Tapo' },
  { id: 'dahua', label: 'Dahua' },
  { id: 'reolink', label: 'Reolink' },
  { id: 'generic', label: 'Raw RTSP URL' },
];

const TYPE_IDS = new Set(CAMERA_TYPES.map((type) => type.id));
const TCP = '#transport=tcp';

export function isCameraType(type) {
  return TYPE_IDS.has(type);
}

function channelNumber(camera) {
  const n = Number(camera.channel);
  return Number.isInteger(n) && n > 0 ? n : 1;
}

export function rtspUrl({ username, password, host, port, path }) {
  const portNum = Number(port) || 554;
  const pathname = String(path || '').startsWith('/') ? String(path) : `/${path || ''}`;
  const auth = username
    ? `${encodeURIComponent(username)}:${encodeURIComponent(password ?? '')}@`
    : '';
  const url = `rtsp://${auth}${host}:${portNum}${pathname}`;
  return url.includes('#transport=') ? url : `${url}${TCP}`;
}

export function withTransport(url) {
  const value = String(url || '').trim();
  if (!value) return '';
  return value.includes('#transport=') ? value : `${value}${TCP}`;
}

export function maskRtsp(url) {
  return String(url || '').replace(/(\/\/[^:/@]*:)([^@]*)(@)/, '$1••••$3');
}

export function hostOf(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

function describePaths(camera) {
  const ch = channelNumber(camera);
  const style = camera.pathStyle || 'hikvision';
  switch (camera.type) {
    case 'hikvision':
      return {
        main: `/Streaming/Channels/${ch}01`,
        sub: `/Streaming/Channels/${ch}02`,
      };
    case 'ezviz':
      if (style === 'h264') {
        return {
          main: `/h264/ch${ch}/main/av_stream`,
          sub: `/h264/ch${ch}/sub/av_stream`,
        };
      }
      if (style === 'custom') {
        if (!String(camera.path || '').trim()) {
          throw new Error('Ezviz custom path is required');
        }
        return {
          main: String(camera.path).trim(),
          sub: String(camera.subPath || '').trim(),
        };
      }
      return {
        main: `/Streaming/Channels/${ch}01`,
        sub: `/Streaming/Channels/${ch}02`,
      };
    case 'tapo':
      return { main: '/stream1', sub: '/stream2' };
    case 'dahua':
      return {
        main: `/cam/realmonitor?channel=${ch}&subtype=0`,
        sub: `/cam/realmonitor?channel=${ch}&subtype=1`,
      };
    case 'reolink': {
      const id = String(ch).padStart(2, '0');
      return {
        main: `/h264Preview_${id}_main`,
        sub: `/h264Preview_${id}_sub`,
      };
    }
    default:
      throw new Error('Choose a camera type');
  }
}

export function localSub(id) {
  return `rtsp://127.0.0.1:8554/${id}`;
}

export function buildSources(camera) {
  if (!camera.id) throw new Error('Camera id is required');
  if (camera.type === 'generic') {
    const main = withTransport(camera.url);
    if (!main.startsWith('rtsp://')) throw new Error('RTSP URL must start with rtsp://');
    const sub = camera.subUrl ? withTransport(camera.subUrl) : localSub(camera.id);
    return { main, sub, masked: maskRtsp(main), host: hostOf(main) };
  }
  if (!String(camera.host || '').trim()) throw new Error('Host is required');
  const paths = describePaths(camera);
  const main = rtspUrl({ ...camera, path: paths.main });
  const sub = paths.sub
    ? rtspUrl({ ...camera, path: paths.sub })
    : localSub(camera.id);
  return { main, sub, masked: maskRtsp(main), host: String(camera.host).trim() };
}

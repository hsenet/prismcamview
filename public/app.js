const state = {
  token: '',
  view: 'live',
  cameras: [],
  layout: localStorage.getItem('prism.layout') || '4',
  editing: null,
  go2rtc: null,
  message: '',
  playerFailed: false,
};

const main = document.createElement('main');
let previewTimer = 0;
let renderGen = 0;

function el(tag, props = {}, kids = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === 'class') node.className = value;
    else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2).toLowerCase(), value);
    else if (value != null && value !== false) node.setAttribute(key, value);
  }
  for (const kid of kids) node.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  return node;
}

function text(tag, value, props) {
  return el(tag, props, [value ?? '']);
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    method: options.method || 'GET',
    headers: {
      'Content-Type': 'application/json',
      ...(state.token ? { Authorization: `Bearer ${state.token}` } : {}),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const data = await response.json().catch(() => ({}));
  if (response.status === 401) {
    state.token = '';
    if (!options.quiet) renderSetup();
    throw new Error(data.error || 'Sign in required');
  }
  if (!response.ok) throw new Error(data.error || 'Request failed');
  return data;
}

function statusLabel(status) {
  if (status === 'live') return 'Live';
  if (status === 'offline') return 'Offline';
  return 'Connecting';
}

function pill(status) {
  return el('span', { class: 'pill', 'data-status': status || 'connecting' }, [statusLabel(status)]);
}

function showBanner(message) {
  state.message = message || '';
  const existing = document.querySelector('.banner');
  if (!message) {
    existing?.remove();
    return;
  }
  const node = text('div', message, { class: 'banner', role: 'status' });
  if (existing) existing.replaceWith(node);
  else main.prepend(node);
}

async function ensurePlayer() {
  if (customElements.get('video-stream')) return true;
  try {
    await import('/rtc/video-stream.js');
    return true;
  } catch {
    return false;
  }
}

function attach(host, playback, { audio = false, onStatus } = {}) {
  if (!playback?.webrtc || !customElements.get('video-stream')) return null;
  const node = document.createElement('video-stream');
  node.mode = 'webrtc,mse,hls';
  node.media = audio ? 'video,audio' : 'video';
  node.visibilityThreshold = 0.35;
  host.appendChild(node);
  const video = node.video;
  const mark = (status) => onStatus?.(status);
  mark('connecting');
  const giveUp = setTimeout(() => mark('offline'), 15000);
  video?.addEventListener('playing', () => {
    clearTimeout(giveUp);
    mark('live');
  });
  video?.addEventListener('waiting', () => mark('connecting'));
  video?.addEventListener('error', () => {
    clearTimeout(giveUp);
    mark('offline');
  });
  try {
    const url = new URL(playback.webrtc);
    node.src = `${url.pathname}${url.search}`;
  } catch {
    node.src = playback.webrtc;
  }
  return node;
}

function openFullscreen(camera) {
  closeFullscreen();
  const stage = el('div', { class: 'stage' });
  const status = pill('connecting');
  const layer = el('section', { class: 'fullscreen' }, [
    el('header', {}, [
      el('button', { class: 'primary', type: 'button', onclick: closeFullscreen }, ['Back']),
      text('strong', camera.name),
      status,
    ]),
    stage,
  ]);
  document.body.append(layer);
  attach(stage, camera.streams?.main, {
    audio: true,
    onStatus: (value) => {
      status.dataset.status = value;
      status.textContent = statusLabel(value);
    },
  });
  layer.tabIndex = -1;
  layer.focus();
}

function closeFullscreen() {
  document.querySelector('.fullscreen')?.remove();
}

function liveView() {
  const tiles = state.cameras.filter((camera) => camera.streams);
  if (!tiles.length) {
    return el('section', { class: 'empty' }, [
      el('div', { class: 'card' }, [
        text('h1', 'No cameras yet'),
        text('p', 'Add an RTSP feed and it will show up on this wall.'),
        el('button', {
          class: 'primary',
          type: 'button',
          onclick: () => { state.view = 'cameras'; state.editing = 'new'; render(); },
        }, ['Add a camera']),
      ]),
    ]);
  }
  const grid = el('div', { class: 'grid', 'data-layout': state.layout });
  for (const camera of tiles) {
    const status = pill(camera.status);
    const stage = el('div', { class: 'stage' });
    grid.append(el('article', {
      class: 'tile',
      role: 'button',
      tabindex: '0',
      'aria-label': `Open ${camera.name}`,
      onclick: () => openFullscreen(camera),
    }, [
      stage,
      el('div', { class: 'overlay' }, [
        text('span', camera.name, { class: 'name' }),
        status,
      ]),
    ]));
    stage.dataset.camera = camera.id;
    stage._status = status;
    stage._playback = camera.streams.sub;
  }
  const layouts = ['1', '4', '9', '16'].map((value) => el('button', {
    type: 'button',
    'aria-pressed': state.layout === value ? 'true' : 'false',
    onclick: () => {
      state.layout = value;
      localStorage.setItem('prism.layout', value);
      render();
    },
  }, [value]));
  return el('section', { class: 'live' }, [
    el('div', { class: 'livebar' }, [
      text('span', `${tiles.length} camera${tiles.length === 1 ? '' : 's'}`, { class: 'hint' }),
      el('div', { class: 'layouts' }, layouts),
    ]),
    grid,
  ]);
}

async function mountTiles(gen) {
  const ready = await ensurePlayer();
  if (gen !== renderGen) return;
  if (!ready) {
    showBanner('The restreamer is not running yet. Video will appear when it starts.');
    return;
  }
  showBanner('');
  for (const stage of main.querySelectorAll('.stage[data-camera]')) {
    attach(stage, stage._playback, {
      onStatus: (value) => {
        stage._status.dataset.status = value;
        stage._status.textContent = statusLabel(value);
      },
    });
  }
}

function field(label, child, wide = false) {
  const wrap = el('label', { class: wide ? 'wide' : '' }, [label, child]);
  return wrap;
}

function input(attrs) {
  return el('input', { ...attrs, autocomplete: attrs.autocomplete || 'off' });
}

function formValues(form) {
  const data = Object.fromEntries(new FormData(form).entries());
  if (state.editing && state.editing !== 'new') data.id = state.editing.id;
  return data;
}

function schedulePreview(form, line, hint) {
  clearTimeout(previewTimer);
  previewTimer = setTimeout(async () => {
    try {
      const result = await api('/api/v1/cameras/preview', { method: 'POST', body: formValues(form) });
      line.textContent = result.maskedUrl || 'The URL appears here as you fill in the camera.';
      const started = ['name', 'host', 'url', 'username'].some((key) => form.elements[key]?.value);
      hint.textContent = started ? (result.error || '') : '';
    } catch (error) {
      hint.textContent = error.message;
    }
  }, 150);
}

function syncForm(form) {
  const type = form.elements.type.value;
  const style = form.elements.pathStyle?.value;
  const preset = type !== 'generic';
  form.querySelectorAll('[data-for]').forEach((node) => {
    const want = node.dataset.for.split(' ');
    const show = want.includes(type) || (want.includes('preset') && preset);
    if (want.includes('ezviz-custom')) {
      node.hidden = !(type === 'ezviz' && style === 'custom');
      return;
    }
    if (want.includes('channel')) {
      node.hidden = !(preset && !(type === 'ezviz' && style === 'custom') && type !== 'tapo');
      return;
    }
    node.hidden = !show;
  });
}

function cameraForm(camera) {
  const current = camera && camera !== 'new' ? camera : null;
  const form = el('form', { class: 'form' });
  const line = el('div', { class: 'url-line wide' }, ['The URL appears here as you fill in the camera.']);
  const hint = text('p', '', { class: 'muted wide', role: 'status' });
  const shot = el('img', { class: 'test-shot wide', alt: 'Camera test picture', hidden: true });
  const name = input({ name: 'name', required: true, value: current?.name || '', maxlength: '80' });
  const type = el('select', { name: 'type' }, [
    ['hikvision', 'Hikvision'],
    ['ezviz', 'Ezviz'],
    ['tapo', 'Tapo'],
    ['dahua', 'Dahua'],
    ['reolink', 'Reolink'],
    ['generic', 'Raw RTSP URL'],
  ].map(([value, label]) => el('option', { value, selected: (current?.type || 'hikvision') === value }, [label])));
  const pathStyle = el('select', { name: 'pathStyle' }, [
    ['hikvision', 'Hikvision-style path'],
    ['h264', 'H264 path'],
    ['custom', 'Custom path'],
  ].map(([value, label]) => el('option', { value, selected: (current?.pathStyle || 'hikvision') === value }, [label])));
  const host = input({ name: 'host', value: current?.host || '', placeholder: '192.168.1.10', spellcheck: 'false' });
  const port = input({ name: 'port', type: 'number', min: '1', value: String(current?.port || 554) });
  const username = input({ name: 'username', value: current?.username || '', spellcheck: 'false' });
  const password = input({
    name: 'password',
    type: 'password',
    placeholder: current?.hasPassword ? 'Leave blank to keep the current password' : '',
    autocomplete: 'new-password',
  });
  const channel = input({ name: 'channel', type: 'number', min: '1', value: String(current?.channel || 1) });
  const path = input({ name: 'path', value: current?.path || '', placeholder: '/Streaming/Channels/101', spellcheck: 'false' });
  const subPath = input({ name: 'subPath', value: current?.subPath || '', placeholder: 'Optional sub path', spellcheck: 'false' });
  const url = input({ name: 'url', value: current?.url || '', placeholder: 'rtsp://user:pass@192.168.1.20:554/stream1', spellcheck: 'false' });
  const subUrl = input({ name: 'subUrl', value: current?.subUrl || '', placeholder: 'Optional sub stream URL', spellcheck: 'false' });

  const rows = [
    field('Name', name, true),
    field('Type', type),
    el('div', { 'data-for': 'ezviz' }, [field('Ezviz path', pathStyle)]),
    el('div', { 'data-for': 'preset' }, [field('Host', host)]),
    el('div', { 'data-for': 'preset' }, [field('Port', port)]),
    el('div', { 'data-for': 'preset' }, [field('Username', username)]),
    el('div', { 'data-for': 'preset' }, [field('Password', password)]),
    el('div', { 'data-for': 'channel' }, [field('Channel', channel)]),
    el('div', { 'data-for': 'ezviz-custom', class: 'wide' }, [field('Main path', path)]),
    el('div', { 'data-for': 'ezviz-custom', class: 'wide' }, [field('Sub path', subPath)]),
    el('div', { 'data-for': 'generic', class: 'wide' }, [field('Main RTSP URL', url)]),
    el('div', { 'data-for': 'generic', class: 'wide' }, [field('Sub RTSP URL', subUrl)]),
    line,
    hint,
    shot,
  ];
  rows.forEach((row) => form.append(row));

  const test = el('button', { type: 'button' }, ['Test']);
  const save = el('button', { class: 'primary', type: 'submit' }, ['Save']);
  const remove = el('button', { class: 'danger ghost', type: 'button' }, ['Delete']);
  form.append(el('div', { class: 'actions wide' }, current ? [test, save, remove] : [test, save]));

  const refreshPreview = () => schedulePreview(form, line, hint);
  form.addEventListener('input', () => { syncForm(form); refreshPreview(); });
  form.addEventListener('change', () => { syncForm(form); refreshPreview(); });
  syncForm(form);
  refreshPreview();

  test.addEventListener('click', async () => {
    test.disabled = true;
    hint.textContent = 'Asking the camera for a picture…';
    shot.hidden = true;
    try {
      const result = await api('/api/v1/cameras/test', { method: 'POST', body: formValues(form) });
      if (result.ok && result.snapshot) {
        shot.src = result.snapshot;
        shot.hidden = false;
        hint.textContent = 'The camera answered.';
      } else {
        hint.textContent = result.error || 'Camera did not answer';
      }
    } catch (error) {
      hint.textContent = error.message;
    } finally {
      test.disabled = false;
    }
  });

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    save.disabled = true;
    try {
      const body = formValues(form);
      const saved = current
        ? await api(`/api/v1/cameras/${current.id}`, { method: 'PUT', body })
        : await api('/api/v1/cameras', { method: 'POST', body });
      state.editing = saved;
      await refresh();
      render();
      showBanner(`${saved.name} is saved. The wall will use the new feed.`);
    } catch (error) {
      hint.textContent = error.message;
      save.disabled = false;
    }
  });

  remove.addEventListener('click', async () => {
    if (!current) return;
    const yes = confirm(`Delete ${current.name}?`);
    if (!yes) return;
    try {
      await api(`/api/v1/cameras/${current.id}`, { method: 'DELETE' });
      state.editing = null;
      await refresh();
      render();
    } catch (error) {
      hint.textContent = error.message;
    }
  });

  return form;
}

function adminView() {
  const info = state.go2rtc || {};
  const cards = state.cameras.map((camera) => el('button', {
    class: 'cam',
    type: 'button',
    'aria-current': state.editing?.id === camera.id ? 'true' : 'false',
    onclick: () => { state.editing = camera; render(); },
  }, [
    el('strong', {}, [camera.name]),
    text('span', `${camera.type} · ${camera.host || 'no host'}`),
    text('span', camera.maskedUrl || camera.error || ''),
  ]));
  const editing = state.editing;
  const editorKids = [
    el('div', { class: 'editor-head' }, [
      el('button', { class: 'ghost back', type: 'button', onclick: () => { state.editing = null; render(); } }, ['Back']),
        text('h2', editing === 'new' ? 'Add camera' : editing ? 'Edit camera' : 'Camera'),
    ]),
  ];
  if (editing) editorKids.push(cameraForm(editing));
  else editorKids.push(text('p', 'Choose a camera or add one. Changing the host, channel, or RTSP URL updates the feed the wall plays.', { class: 'muted' }));

  const update = el('button', {
    class: 'primary',
    type: 'button',
    hidden: info.updateAvailable ? null : true,
    onclick: async () => {
      update.disabled = true;
      update.textContent = 'Updating…';
      try {
        state.go2rtc = await api('/api/v1/go2rtc/update', { method: 'POST' });
        render();
      } catch (error) {
        showBanner(error.message);
        update.disabled = false;
        update.textContent = `Update to ${info.latest}`;
      }
    },
  }, [`Update to ${info.latest || 'latest'}`]);

  return el('section', { class: state.editing ? 'admin editing' : 'admin' }, [
    el('div', { class: 'list' }, [
      el('div', { class: 'list-head' }, [
        text('h2', 'Cameras'),
        el('button', { class: 'primary', type: 'button', onclick: () => { state.editing = 'new'; render(); } }, ['Add']),
      ]),
      el('div', { class: 'cameras' }, cards.length ? cards : [text('p', 'No cameras yet.', { class: 'muted' })]),
    ]),
    el('div', { class: 'editor' }, editorKids),
    el('div', { class: 'restreamer' }, [
      el('div', {}, [
        text('strong', 'Restreamer'),
        text('div', info.version ? `go2rtc ${info.version}${info.running === false ? ' · not running' : ''}` : 'go2rtc', { class: 'muted' }),
        text('div', info.updateAvailable ? `Version ${info.latest} is available.` : 'This build is current.', { class: 'muted' }),
      ]),
      el('div', { class: 'inline' }, [
        text('div', 'The API token stays in data/config.yaml on this computer.', { class: 'muted' }),
        update,
      ]),
    ]),
  ]);
}

function highlightNav() {
  document.querySelectorAll('[data-view]').forEach((button) => {
    button.setAttribute('aria-current', button.dataset.view === state.view ? 'true' : 'false');
  });
}

function render() {
  const gen = ++renderGen;
  closeFullscreen();
  main.replaceChildren(state.view === 'live' ? liveView() : adminView());
  highlightNav();
  if (state.view === 'live') mountTiles(gen);
}

function productName() {
  return el('div', { class: 'brand' }, [
    el('img', { class: 'mark', src: '/prismcam.svg', alt: '' }),
    text('span', 'PrismCam'),
  ]);
}

function app5Logo(extra = '') {
  return el('div', { class: extra ? `house ${extra}` : 'house' }, [
    el('img', { src: '/app5-logo.jpeg', alt: 'App5 Global' }),
  ]);
}

function navButton(view, label) {
  return el('button', {
    type: 'button',
    'data-view': view,
    onclick: () => { state.view = view; render(); },
  }, [label]);
}

function shell() {
  const nav = el('nav', { class: 'nav' }, [navButton('live', 'Live'), navButton('cameras', 'Cameras')]);
  document.body.replaceChildren(
    el('header', { class: 'topbar' }, [
      productName(),
      nav,
      app5Logo(),
    ]),
    main,
    el('nav', { class: 'bottomnav' }, [
      el('div', { class: 'nav' }, [navButton('live', 'Live'), navButton('cameras', 'Cameras')]),
    ]),
  );
}

function renderSetup() {
  const token = input({ type: 'password', placeholder: 'Paste the token from data/config.yaml', autocomplete: 'current-password' });
  const note = text('p', 'Open this page on the server PC and it can sign in by itself. On another device, paste the API token.', { class: 'muted' });
  const button = el('button', { class: 'primary', type: 'button' }, ['Continue']);
  button.addEventListener('click', async () => {
    state.token = token.value.trim();
    if (!state.token) return;
    try {
      await refresh({ quiet: true });
      state.token = '';
      shell();
      render();
    } catch (error) {
      state.token = '';
      note.textContent = error.message;
    }
  });
  document.body.replaceChildren(el('section', { class: 'setup' }, [
    el('div', { class: 'card' }, [
      app5Logo('house-card'),
      productName(),
      text('h1', 'Sign in'),
      note,
      token,
      button,
    ]),
  ]));
}

async function refresh(options = {}) {
  const [list, runtime] = await Promise.all([
    api('/api/v1/cameras', options),
    api('/api/v1/go2rtc', options).catch(() => null),
  ]);
  state.cameras = list.cameras || [];
  state.go2rtc = runtime;
  if (state.editing && state.editing !== 'new') {
    state.editing = state.cameras.find((camera) => camera.id === state.editing.id) || null;
  }
}

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') closeFullscreen();
});

async function boot() {
  shell();
  try {
    await fetch('/api/v1/session');
    await refresh({ quiet: true });
    render();
  } catch {
    renderSetup();
  }
}

boot();

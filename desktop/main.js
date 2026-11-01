// Montage desktop app: the same editor in its own window (Electron).
// The web app's files are served from the app:// scheme, a secure origin, so ES modules, IndexedDB,
// WebCodecs and AudioWorklet work as they do on the website. With no application menu, keys that a
// browser keeps for itself (Ctrl+N, Ctrl+T, Ctrl+W, Ctrl+R) reach the editor, as in Photoshop / Premiere.
const { app, BrowserWindow, Menu, protocol, shell } = require('electron');
const path = require('node:path');
const fs = require('node:fs/promises');

const ROOT = path.join(__dirname, 'app');
const START = 'app://montage/app.html';
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.wasm': 'application/wasm',
  '.txt': 'text/plain; charset=utf-8',
};

protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true, codeCache: true } },
]);

const smoke = process.argv.includes('--smoke-test');
if (!smoke && !app.requestSingleInstanceLock()) app.quit();

/** app://montage/<path> → the file under app/ (never outside it). */
async function serve(request) {
  let rel = decodeURIComponent(new URL(request.url).pathname);
  if (rel === '/' || rel === '') rel = '/index.html';
  const file = path.normalize(path.join(ROOT, rel));
  if (!file.startsWith(ROOT + path.sep)) return new Response('Not found', { status: 404 });
  try {
    const body = await fs.readFile(file);
    return new Response(body, { headers: { 'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream' } });
  } catch {
    return new Response('Not found', { status: 404 });
  }
}

function createWindow(url = START) {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    show: false,
    title: 'Montage',
    backgroundColor: '#1f2125',
    icon: path.join(__dirname, 'icon.png'),
    autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, sandbox: true, spellcheck: false },
  });
  win.once('ready-to-show', () => {
    if (smoke) return;
    win.maximize();
    win.show();
  });
  // links: pages of this app open in a new app window, web addresses in the default browser
  win.webContents.setWindowOpenHandler(({ url: target }) => {
    if (target.startsWith('app://')) createWindow(target);
    else if (/^https?:/i.test(target)) shell.openExternal(target);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, target) => {
    if (target.startsWith('app://')) return;
    e.preventDefault();
    if (/^https?:/i.test(target)) shell.openExternal(target);
  });
  win.loadURL(url);
  return win;
}

/** CI check: start the app, open both editors, fail on script errors. */
async function smokeTest() {
  const win = createWindow(`${START}?blank`);
  const errors = [];
  win.webContents.on('console-message', (event, level, message) => {
    const lv = typeof level === 'number' ? level : event.level;
    const msg = typeof message === 'string' ? message : event.message;
    if ((lv === 3 || lv === 'error') && /Uncaught|SyntaxError|TypeError|ReferenceError|does not provide an export/.test(msg)) errors.push(msg);
  });
  await new Promise((resolve) => win.webContents.once('did-finish-load', resolve));
  const result = await win.webContents.executeJavaScript(`(async () => {
    const wait = async (ok) => { for (let i = 0; i < 150 && !ok(); i++) await new Promise((r) => setTimeout(r, 100)); return ok(); };
    if (!(await wait(() => window.montage && window.montage.store))) return 'the video editor did not start';
    await window.montage.setMode('photo');
    if (!(await wait(() => window.montage.appMode.P))) return 'the photo editor did not start';
    window.montage.appMode.P.newDoc({ width: 200, height: 100 });
    return 'ok';
  })()`).catch((err) => String(err));
  const ok = result === 'ok' && !errors.length;
  console.log(ok ? 'SMOKE OK' : `SMOKE FAIL: ${result} ${errors.join(' | ')}`);
  app.exit(ok ? 0 : 1);
}

app.whenReady().then(() => {
  protocol.handle('app', serve);
  Menu.setApplicationMenu(null);
  if (smoke) smokeTest();
  else createWindow();
  app.on('activate', () => {
    if (!BrowserWindow.getAllWindows().length) createWindow();
  });
});

app.on('second-instance', () => {
  const win = BrowserWindow.getAllWindows()[0];
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.focus();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

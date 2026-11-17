// Inside the Android app (Capacitor, see mobile/): files the editors save go to the phone's
// Documents/Montage folder, the share sheet works through the app's Share plugin, the back button
// closes what is open, and links to the website open in the phone's browser. Does nothing on the web.

const SITE = 'https://doongndon.github.io/video/';
const cap = window.Capacitor;

if (cap?.isNativePlatform?.() && cap.Plugins) {
  const { Filesystem, Share, App } = cap.Plugins;
  const toast = (msg) => window.dispatchEvent(new CustomEvent('montage:toast', { detail: msg }));

  const base64 = (blob) => new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1] || '');
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });

  /** Write a blob in pieces (a multiple of 3 bytes each, so the base64 parts join cleanly) and return its file:// address. */
  async function writeBlob(blob, path, directory) {
    const piece = 3 * 1024 * 1024;
    for (let i = 0; i === 0 || i < blob.size; i += piece) {
      const data = await base64(blob.slice(i, i + piece));
      if (i === 0) await Filesystem.writeFile({ path, data, directory, recursive: true });
      else await Filesystem.appendFile({ path, data, directory });
    }
    return (await Filesystem.getUri({ path, directory })).uri;
  }

  const safeName = (name) => String(name || 'Montage').replace(/[\\/:*?"<>|]+/g, '_');

  // util.js downloadBlob hands its files here instead of a download link (WebView has no downloads)
  window.montageNative = {
    async save(blob, filename) {
      const name = safeName(filename);
      try {
        let path = `Montage/${name}`;
        try {
          await writeBlob(blob, path, 'DOCUMENTS');
        } catch {
          // a file of that name made by another app can't be replaced: keep both
          const dot = name.lastIndexOf('.');
          path = `Montage/${dot > 0 ? name.slice(0, dot) : name}-${Date.now()}${dot > 0 ? name.slice(dot) : ''}`;
          await writeBlob(blob, path, 'DOCUMENTS');
        }
        toast(`휴대폰의 Documents/Montage 폴더에 ${path.slice(8)} 파일을 저장했습니다`);
        return true;
      } catch (err) {
        console.error(err);
        toast(`${name} 파일을 저장하지 못했습니다`);
        return false;
      }
    },
  };

  // the share sheet ('공유 · 사진 앱에 저장' buttons): files go through the app's cache folder
  navigator.canShare = (d) => !!(d && (d.files?.length || d.url || d.text));
  navigator.share = async (d = {}) => {
    const files = [];
    for (const f of d.files || []) files.push(await writeBlob(f, `share/${safeName(f.name)}`, 'CACHE'));
    try {
      await Share.share({ title: d.title, text: d.text, url: d.url, files: files.length ? files : undefined, dialogTitle: '공유 · 저장' });
    } catch (err) {
      if (/cancel/i.test(err?.message || '')) throw new DOMException('공유를 취소했습니다', 'AbortError');
      throw err;
    }
  };

  // links to the website (index.html, docs pages opened in a new window) open in the phone's browser
  const open = window.open.bind(window);
  window.open = (url, target, features) => {
    if (typeof url === 'string' && url && !url.startsWith('blob:') && !url.startsWith('data:')) {
      const abs = new URL(url, /^https?:/.test(url) ? undefined : SITE).href;
      location.assign(abs); // an address outside the app goes to the browser (Capacitor)
      return null;
    }
    return open(url, target, features);
  };

  // back button: close the dialog, menu or sheet that is open, otherwise leave the app running
  // in the background (work is saved as it is made)
  App.addListener('backButton', () => {
    if (document.querySelector('.modal-backdrop, .menu, .qe-pop')) {
      (document.activeElement || document.body).dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true }));
      return;
    }
    if (document.body.classList.contains('m-sheet-open')) {
      import('./ui/mobile.js').then((m) => m.mobileApi.closeSheet?.());
      return;
    }
    const photoSheet = document.querySelector('.ph-sheet.open .ph-sheet-head button[aria-label="닫기"]');
    if (photoSheet) photoSheet.click();
    else App.minimizeApp();
  });
  document.documentElement.classList.add('native-app');
}

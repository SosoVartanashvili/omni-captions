/*
 * OMNI Captions — self-update.
 *
 * The panel reads <updateBase>/update.json:
 *   { "version": "1.3.0", "notes": "...", "restart": false,
 *     "files": [ { "path": "js/main.js", "sha256": "..." }, ... ] }
 * When that version is newer than its own, it shows an Update button. Pressing it downloads
 * every file from <updateBase>/<path>, checks each SHA-256, and only when ALL of them are good
 * writes them over its own folder, reloads the Premiere script and the panel.
 */
(function (root) {
  'use strict';
  var req = (typeof require === 'function') ? require : (root.cep_node && root.cep_node.require);
  var fs = req('fs'), pathMod = req('path'), https = req('https'), http = req('http'), crypto = req('crypto');
  var Buffer = req('buffer').Buffer;

  function get(url, redirects) {
    redirects = redirects || 0;
    return new Promise(function (resolve, reject) {
      var u = new URL(url);
      if (u.protocol !== 'https:' && !/^(localhost|127\.0\.0\.1)$/.test(u.hostname)) return reject(new Error('Updates only over https'));
      var mod = u.protocol === 'http:' ? http : https;
      // plain options object: inside the panel `URL` is the browser's class, which Node's http does not accept
      var r = mod.get({
        protocol: u.protocol, hostname: u.hostname, port: u.port || undefined, path: u.pathname + u.search,
        headers: { 'User-Agent': 'omni-captions', 'Cache-Control': 'no-cache' }
      }, function (res) {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects < 5) {
          res.resume();
          return resolve(get(new URL(res.headers.location, url).toString(), redirects + 1));
        }
        var chunks = [];
        res.on('data', function (c) { chunks.push(c); });
        res.on('end', function () {
          if (res.statusCode !== 200) return reject(new Error('HTTP ' + res.statusCode + ' for ' + url));
          resolve(Buffer.concat(chunks));
        });
      });
      r.on('error', reject);
      r.setTimeout(15000, function () { r.destroy(new Error('Update server timed out')); });
    });
  }

  function cmp(a, b) {
    var x = String(a).split('.').map(Number), y = String(b).split('.').map(Number);
    for (var i = 0; i < Math.max(x.length, y.length); i++) {
      var d = (x[i] || 0) - (y[i] || 0);
      if (d) return d > 0 ? 1 : -1;
    }
    return 0;
  }

  function extensionDir() {
    var href = (root.location && root.location.href) || '';
    var p = decodeURIComponent(new URL('.', href).pathname);
    if (/^\/[A-Za-z]:\//.test(p)) p = p.slice(1);           // Windows: /C:/Users/... -> C:/Users/...
    return p.replace(/[\/\\]$/, '');
  }

  function localVersion(dir) {
    try { return JSON.parse(fs.readFileSync(pathMod.join(dir || extensionDir(), 'version.json'), 'utf8')).version; }
    catch (e) { return '0.0.0'; }
  }

  function join(base, p) { return base.replace(/\/+$/, '') + '/' + p.split('/').map(encodeURIComponent).join('/'); }

  function safePath(p) {
    return typeof p === 'string' && p && !/(^|[\/\\])\.\.([\/\\]|$)/.test(p) && !/^[\/\\]/.test(p) && !/^[A-Za-z]:/.test(p);
  }

  // -> null when up to date, else the remote manifest
  function check(base, dir) {
    return get(join(base, 'update.json') + '?t=' + Date.now()).then(function (buf) {
      var m = JSON.parse(buf.toString('utf8'));
      if (!m.version || !Array.isArray(m.files)) throw new Error('Bad update.json');
      return cmp(m.version, localVersion(dir)) > 0 ? m : null;
    });
  }

  function apply(base, manifest, dir, onProgress) {
    dir = dir || extensionDir();
    var got = [];
    var bad = manifest.files.filter(function (f) { return !safePath(f.path) || !/^[a-f0-9]{64}$/.test(f.sha256 || ''); });
    if (bad.length) return Promise.reject(new Error('update.json has an unsafe entry: ' + bad[0].path));
    // 1. download everything into memory and verify it — nothing is written until all are good
    return manifest.files.reduce(function (p, f, i) {
      return p.then(function () {
        if (onProgress) onProgress(i + 1, manifest.files.length, f.path);
        return get(join(base, f.path) + '?v=' + encodeURIComponent(manifest.version)).then(function (buf) {
          var h = crypto.createHash('sha256').update(buf).digest('hex');
          if (h !== f.sha256) throw new Error('Checksum mismatch on ' + f.path + ' — update not applied.');
          got.push({ path: f.path, buf: buf });
        });
      });
    }, Promise.resolve()).then(function () {
      // 2. write: each file to a temp name, then rename over the old one
      got.forEach(function (g) {
        var dest = pathMod.join(dir, g.path);
        fs.mkdirSync(pathMod.dirname(dest), { recursive: true });
        var tmp = dest + '.updating';
        fs.writeFileSync(tmp, g.buf);
        fs.renameSync(tmp, dest);
      });
      fs.writeFileSync(pathMod.join(dir, 'version.json'), JSON.stringify({ version: manifest.version }), 'utf8');
      return { dir: dir, count: got.length, restart: !!manifest.restart };
    });
  }

  var api = { check: check, apply: apply, localVersion: localVersion, extensionDir: extensionDir, _cmp: cmp, _get: get };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.OmniUpdater = api;
})(typeof window !== 'undefined' ? window : this);

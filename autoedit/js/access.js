/*
 * Soso panels — device check-in and access control (shared by Soso Captions, Soso Music, Soso Auto Edit).
 *
 * Check-in: every panel writes <shared folder>/devices/<device id>.json
 *   (who: editor name, computer, Windows/Mac user, panel + version, last seen).
 *   The shared folder is the "Shared learning folder" set in Soso Captions (Google Drive / Dropbox).
 * Access:   every panel reads access.json from the GitHub repo (only the admin can change it):
 *   { "blocked": [ { "id": "...", "computer": "...", "label": "who", "note": "..." } ], "message": "..." }
 *   An entry blocks a device when its id or its computer name matches ("name" may be added by hand to block an editor name).
 *   No internet -> the last answer is used.
 * Admin:    a soso-admin.json file next to the panel folders turns on the Devices list in Soso Captions.
 */
(function (root) {
  'use strict';
  var req = (typeof require === 'function') ? require : (root.cep_node && root.cep_node.require);
  var fs = req('fs'), pathMod = req('path'), os = req('os'), crypto = req('crypto');
  var ACCESS_URL = 'https://raw.githubusercontent.com/SosoVartanashvili/omni-captions/main/access.json';

  function homeDir() { var d = pathMod.join(os.homedir(), '.soso-panels'); try { fs.mkdirSync(d, { recursive: true }); } catch (e) {} return d; }
  function readJson(p, dflt) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return dflt; } }
  function writeJson(p, obj) {
    var tmp = p + '.' + Date.now() + Math.random().toString(16).slice(2) + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 1), 'utf8');
    fs.renameSync(tmp, p);
  }

  /* ---------- this computer ---------- */
  function config() { return readJson(pathMod.join(homeDir(), 'config.json'), {}); }
  function setConfig(patch) {
    var p = pathMod.join(homeDir(), 'config.json'), c = readJson(p, {});
    Object.keys(patch).forEach(function (k) { c[k] = patch[k]; });
    try { writeJson(p, c); } catch (e) {}
    return c;
  }
  function deviceId() {
    var c = config();
    if (c.deviceId) return c.deviceId;
    var id = crypto.randomBytes(6).toString('hex');
    setConfig({ deviceId: id });
    return id;
  }
  function device(panel, version) {
    var c = config(), user = '';
    try { user = os.userInfo().username; } catch (e) {}
    return {
      id: deviceId(), name: c.editorName || '', computer: os.hostname(), user: user,
      os: os.platform() === 'win32' ? 'Windows' : os.platform() === 'darwin' ? 'Mac' : os.platform(),
      panels: {}, lastSeen: new Date().toISOString(), lastPanel: panel, lastVersion: version
    };
  }

  /* ---------- check-in ---------- */
  function sharedDir() { return (config().sharedDir || '').trim(); }
  function checkIn(panel, version, blocked) {
    var dir = sharedDir();
    if (!dir) return { ok: false, reason: 'no shared folder' };
    try {
      var dd = pathMod.join(dir, 'devices');
      fs.mkdirSync(dd, { recursive: true });
      var me = device(panel, version), p = pathMod.join(dd, me.id + '.json'), old = readJson(p, {});
      me.panels = old.panels || {};
      me.panels[panel] = { version: version, lastSeen: me.lastSeen };
      me.firstSeen = old.firstSeen || me.lastSeen;
      if (blocked) me.blockedSeen = me.lastSeen;
      writeJson(p, me);
      return { ok: true, path: p };
    } catch (e) { return { ok: false, reason: e.message }; }
  }
  function listDevices() {
    var dir = sharedDir(); if (!dir) return [];
    var dd = pathMod.join(dir, 'devices'), out = [];
    try {
      fs.readdirSync(dd).forEach(function (f) {
        if (!/^[a-f0-9]{6,32}\.json$/i.test(f)) return;
        var d = readJson(pathMod.join(dd, f), null);
        if (d && d.id) out.push(d);
      });
    } catch (e) {}
    out.sort(function (a, b) { return String(b.lastSeen).localeCompare(String(a.lastSeen)); });
    return out;
  }

  /* ---------- access ---------- */
  function same(a, b) { return a && b && String(a).trim().toLowerCase() === String(b).trim().toLowerCase(); }
  function isBlocked(access, me) {
    var list = (access && access.blocked) || [];
    for (var i = 0; i < list.length; i++) {
      var e = list[i];
      if (same(e.id, me.id) || same(e.computer, me.computer) || same(e.name, me.name)) return e;
    }
    return null;
  }
  function fetchAccess(get) {
    var cacheP = pathMod.join(homeDir(), 'access-cache.json');
    return get(ACCESS_URL + '?t=' + Date.now()).then(function (buf) {
      var a = JSON.parse(buf.toString('utf8'));
      try { writeJson(cacheP, a); } catch (e) {}
      return a;
    }, function (e) {
      if (/HTTP 404/.test(e.message)) return { blocked: [] };     // no access list published yet
      return readJson(cacheP, { blocked: [] });                    // offline: last known answer
    });
  }
  // -> Promise<{blocked: entry|null, message, me}>
  function check(panel, version, get) {
    var me = device(panel, version);
    return fetchAccess(get).then(function (a) {
      var hit = isBlocked(a, me);
      checkIn(panel, version, !!hit);
      return { blocked: hit, message: (hit && hit.note) || a.message || '', me: me };
    });
  }

  // cover the whole panel; nothing underneath can be clicked
  function lockPanel(doc, info) {
    var d = doc.createElement('div');
    d.style.cssText = 'position:fixed;inset:0;z-index:9999;background:#1d1d1d;color:#eee;display:flex;flex-direction:column;' +
      'align-items:center;justify-content:center;text-align:center;padding:24px;font:13px/1.5 sans-serif';
    var h = doc.createElement('div'); h.style.cssText = 'font-size:15px;font-weight:600;margin-bottom:8px';
    h.textContent = 'Access to this panel is turned off for this computer.';
    var p = doc.createElement('div'); p.style.color = '#aaa';
    p.textContent = (info.message ? info.message + ' — ' : '') + 'Ask Soso to turn it back on. Device: ' + info.me.id + ' · ' + info.me.computer;
    d.appendChild(h); d.appendChild(p); doc.body.appendChild(d);
    Array.prototype.forEach.call(doc.querySelectorAll('button,input,select,textarea'), function (el) { el.disabled = true; });
  }

  /* ---------- admin ---------- */
  // soso-admin.json sits in the CEP extensions folder, next to the panel folders (only on the admin's computer)
  function adminFile(extDir) { return pathMod.join(pathMod.dirname(extDir), 'soso-admin.json'); }
  function adminConfig(extDir) { return readJson(adminFile(extDir), null); }
  function readAccessFile(p) { return readJson(p, { blocked: [], message: '' }); }
  function setBlocked(accessPath, dev, on, note) {
    var a = readAccessFile(accessPath);
    a.blocked = (a.blocked || []).filter(function (e) { return !same(e.id, dev.id); });
    if (on) a.blocked.push({ id: dev.id, computer: dev.computer || '', label: dev.name || '', note: note || '', since: new Date().toISOString() });
    a.updated = new Date().toISOString();
    fs.mkdirSync(pathMod.dirname(accessPath), { recursive: true });
    writeJson(accessPath, a);
    return a;
  }

  var api = { check: check, checkIn: checkIn, listDevices: listDevices, lockPanel: lockPanel, isBlocked: isBlocked,
              config: config, setConfig: setConfig, deviceId: deviceId, adminConfig: adminConfig, adminFile: adminFile,
              readAccessFile: readAccessFile, setBlocked: setBlocked, ACCESS_URL: ACCESS_URL };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.SosoAccess = api;
})(typeof window !== 'undefined' ? window : this);

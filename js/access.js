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
 *   An entry may also hold "machine" (Windows/Mac hardware id — survives a reinstall of the panel) or "ip" (public IP).
 *   "admins": [ { "id", "machine", "computer" } ] — the admin's computer(s); never blocked.
 * Admin:    the Devices list in Soso Captions shows only when soso-admin.json sits next to the panel folders
 *           AND this computer is in "admins" (the first time, the computer with soso-admin.json registers itself).
 */
(function (root) {
  'use strict';
  var req = (typeof require === 'function') ? require : (root.cep_node && root.cep_node.require);
  var fs = req('fs'), pathMod = req('path'), os = req('os'), crypto = req('crypto');
  var cp = null; try { cp = req('child_process'); } catch (e) {}
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
  // hardware id of the computer (Windows MachineGuid / Mac IOPlatformUUID), hashed — stays the same
  // when the panel or its settings are deleted and reinstalled
  var machineCache = null;
  function machineId() {
    if (machineCache !== null) return machineCache;
    var raw = '';
    try {
      if (cp && os.platform() === 'win32') {
        var o = cp.execSync('reg query "HKLM\\SOFTWARE\\Microsoft\\Cryptography" /v MachineGuid', { encoding: 'utf8', windowsHide: true, timeout: 4000 });
        var m = /MachineGuid\s+REG_\w+\s+([0-9a-f-]{20,})/i.exec(o); if (m) raw = m[1];
      } else if (cp && os.platform() === 'darwin') {
        var o2 = cp.execSync('ioreg -rd1 -c IOPlatformExpertDevice', { encoding: 'utf8', timeout: 4000 });
        var m2 = /"IOPlatformUUID" = "([^"]+)"/.exec(o2); if (m2) raw = m2[1];
      }
    } catch (e) {}
    if (!raw) { try { raw = os.hostname() + '|' + (os.cpus()[0] || {}).model + '|' + Math.round(os.totalmem() / 1e9); } catch (e2) { raw = os.hostname(); } }
    machineCache = crypto.createHash('sha256').update('soso|' + raw).digest('hex').slice(0, 16);
    return machineCache;
  }
  // local network addresses (192.168.x.x …) and their network cards
  function localIps() {
    var out = [];
    try {
      var ni = os.networkInterfaces();
      Object.keys(ni).forEach(function (n) {
        (ni[n] || []).forEach(function (a) {
          if (a.internal || (a.family !== 'IPv4' && a.family !== 4)) return;
          out.push(a.address + ' (' + n + ')');
        });
      });
    } catch (e) {}
    return out;
  }
  function device(panel, version) {
    var c = config(), user = '';
    try { user = os.userInfo().username; } catch (e) {}
    return {
      id: deviceId(), machine: machineId(), name: c.editorName || '', computer: os.hostname(), user: user,
      os: os.platform() === 'win32' ? 'Windows' : os.platform() === 'darwin' ? 'Mac' : os.platform(),
      localIps: localIps(), ip: c.lastIp || '', place: c.lastPlace || '',
      panels: {}, lastSeen: new Date().toISOString(), lastPanel: panel, lastVersion: version
    };
  }

  // public IP (+ city / country) — one small https request, at most every 10 minutes
  function publicIp(get) {
    var c = config();
    if (c.lastIp && c.lastIpAt && Date.now() - c.lastIpAt < 10 * 60 * 1000) return Promise.resolve({ ip: c.lastIp, place: c.lastPlace || '' });
    if (!get) return Promise.resolve({ ip: c.lastIp || '', place: c.lastPlace || '' });
    return get('https://ipwho.is/?fields=ip,city,country,connection').then(function (buf) {
      var j = JSON.parse(buf.toString('utf8'));
      if (!j.ip) throw new Error('no ip');
      var place = [j.city, j.country].filter(Boolean).join(', ') + (j.connection && j.connection.isp ? ' · ' + j.connection.isp : '');
      return { ip: j.ip, place: place };
    }).catch(function () {
      return get('https://api.ipify.org?format=json').then(function (buf) { return { ip: JSON.parse(buf.toString('utf8')).ip || '', place: '' }; });
    }).then(function (r) {
      if (r.ip) setConfig({ lastIp: r.ip, lastPlace: r.place, lastIpAt: Date.now() });
      return r;
    }, function () { return { ip: c.lastIp || '', place: c.lastPlace || '' }; });
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
      // every public IP this computer has used (newest first, up to 15)
      var ips = (old.ipHistory || []).filter(function (h) { return h && h.ip && h.ip !== me.ip; });
      if (me.ip) ips.unshift({ ip: me.ip, place: me.place, lastSeen: me.lastSeen });
      me.ipHistory = ips.slice(0, 15);
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
  function isAdminIn(access, me) {
    var list = (access && access.admins) || [];
    for (var i = 0; i < list.length; i++) {
      var a = list[i];
      if (same(a.machine, me.machine) || same(a.id, me.id)) return true;
    }
    return false;
  }
  function isBlocked(access, me) {
    if (isAdminIn(access, me)) return null;            // the admin's computer is never locked out
    var list = (access && access.blocked) || [];
    for (var i = 0; i < list.length; i++) {
      var e = list[i];
      if (same(e.id, me.id) || same(e.machine, me.machine) || same(e.computer, me.computer) ||
          same(e.name, me.name) || same(e.ip, me.ip)) return e;
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
    var me;
    return publicIp(get).then(function () {
      me = device(panel, version);
      return fetchAccess(get);
    }).then(function (a) {
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
    p.textContent = (info.message ? info.message + ' — ' : '') + 'Ask Soso to turn it back on. Device: ' + info.me.id + ' · ' + info.me.computer + (info.me.ip ? ' · ' + info.me.ip : '');
    d.appendChild(h); d.appendChild(p); doc.body.appendChild(d);
    Array.prototype.forEach.call(doc.querySelectorAll('button,input,select,textarea'), function (el) { el.disabled = true; });
  }

  /* ---------- admin ---------- */
  // soso-admin.json sits in the CEP extensions folder, next to the panel folders (only on the admin's computer)
  function adminFile(extDir) { return pathMod.join(pathMod.dirname(extDir), 'soso-admin.json'); }
  function readAccessFile(p) { return readJson(p, { blocked: [], message: '' }); }
  function cachedAccess() { return readJson(pathMod.join(homeDir(), 'access-cache.json'), null); }
  // admin = soso-admin.json on this computer AND this computer listed in "admins".
  // The published list (GitHub) decides; before any admin is published, the computer that has
  // soso-admin.json registers itself in the local access.json (upload that file once to GitHub).
  function adminConfig(extDir) {
    var cfg = readJson(adminFile(extDir), null);
    if (!cfg || !cfg.accessJson) return null;
    var me = device('', ''), remote = cachedAccess(), local = readAccessFile(cfg.accessJson);
    var published = remote && remote.admins && remote.admins.length;
    if (published) {
      if (!isAdminIn(remote, me)) return null;
    } else if (!isAdminIn(local, me)) {
      if (local.admins && local.admins.length) return null;       // someone else is already the admin
      local.admins = [{ id: me.id, machine: me.machine, computer: me.computer, label: me.name || 'admin', since: new Date().toISOString() }];
      try { fs.mkdirSync(pathMod.dirname(cfg.accessJson), { recursive: true }); writeJson(cfg.accessJson, local); } catch (e) { return null; }
      cfg.justRegistered = true;
    }
    if (local.admins && local.admins.length && !published) cfg.needsUpload = true;
    cfg.me = me;
    return cfg;
  }
  function setBlocked(accessPath, dev, on, note, how) {
    var a = readAccessFile(accessPath);
    if (on && isAdminIn(a, dev)) throw new Error('This is the admin computer — it cannot be blocked.');
    a.blocked = (a.blocked || []).filter(function (e) { return how === 'ip' ? !same(e.ip, dev.ip) : !(same(e.id, dev.id) || (dev.machine && same(e.machine, dev.machine))); });
    if (on && how === 'ip') a.blocked.push({ ip: dev.ip, label: (dev.name || dev.computer || '') + ' (IP)', note: note || '', since: new Date().toISOString() });
    else if (on) a.blocked.push({ id: dev.id, machine: dev.machine || '', computer: dev.computer || '', label: dev.name || '', note: note || '', since: new Date().toISOString() });
    a.updated = new Date().toISOString();
    fs.mkdirSync(pathMod.dirname(accessPath), { recursive: true });
    writeJson(accessPath, a);
    return a;
  }

  var api = { check: check, checkIn: checkIn, listDevices: listDevices, lockPanel: lockPanel, isBlocked: isBlocked,
              config: config, setConfig: setConfig, deviceId: deviceId, machineId: machineId, localIps: localIps, publicIp: publicIp,
              isAdminIn: isAdminIn, adminConfig: adminConfig, adminFile: adminFile,
              readAccessFile: readAccessFile, setBlocked: setBlocked, ACCESS_URL: ACCESS_URL };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.SosoAccess = api;
})(typeof window !== 'undefined' ? window : this);

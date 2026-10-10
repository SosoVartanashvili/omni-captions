/* Soso Auto Edit — panel controller. */
(function () {
  'use strict';
  var req = (typeof require === 'function') ? require : window.cep_node.require;
  var fs = req('fs'), pathMod = req('path');

  var $ = function (id) { return document.getElementById(id); };
  var UPDATE_BASE = 'https://raw.githubusercontent.com/SosoVartanashvili/omni-captions/main/autoedit';
  var KEYS = ['folder', 'hookSeqs', 'precise', 'snap', 'trimFrozen', 'size1080', 'muteClips', 'offset', 'snapTol', 'apiKey', 'updateUrl'];
  var AUDIO = /\.(mp3|wav|m4a|aac|aif|aiff)$/i, VIDEO = /\.(mp4|mov|m4v)$/i;
  var SKIP_DIRS = /^(exp|export|exports|_tmp|tmp|images|\.done|soso auto edit|omni captions|soso music)$/i;
  var scan = null;   // last folder scan

  /* ---------- settings ---------- */
  function load() {
    var s = {};
    try { s = JSON.parse(localStorage.getItem('sosoAutoEdit') || '{}'); } catch (e) {}
    KEYS.forEach(function (k) {
      var el = $(k); if (!el || s[k] === undefined) return;
      if (el.type === 'checkbox') el.checked = !!s[k]; else el.value = s[k];
    });
    if (!$('apiKey').value) {                       // reuse the key already saved by Soso Music, if this panel can see it
      try { var m = JSON.parse(localStorage.getItem('sosoMusic') || '{}'); if (m.apiKey) $('apiKey').value = m.apiKey; } catch (e) {}
    }
  }
  function save() {
    var s = {};
    KEYS.forEach(function (k) { var el = $(k); if (el) s[k] = el.type === 'checkbox' ? el.checked : el.value; });
    try { localStorage.setItem('sosoAutoEdit', JSON.stringify(s)); } catch (e) {}
    return s;
  }

  /* ---------- UI ---------- */
  function status(msg, kind) { var el = $('status'); el.textContent = msg; el.className = 'status ' + (kind || ''); }
  function busy(on) { $('run').disabled = on; $('pickFolder').disabled = on; }
  function fmt(t) { var m = Math.floor(t / 60), s = t - m * 60; return m + ':' + (s < 10 ? '0' : '') + s.toFixed(2); }
  function preview(rows) {
    var list = $('preview'); list.innerHTML = '';
    rows.forEach(function (r) {
      var row = document.createElement('div'); row.className = 'cap';
      var t = document.createElement('span'); t.className = 't'; t.textContent = r.t;
      var x = document.createElement('span'); x.className = 'x'; x.textContent = r.x;
      if (r.bad) x.style.color = '#f2a09d';
      row.appendChild(t); row.appendChild(x); list.appendChild(row);
    });
  }

  /* ---------- Premiere bridge ---------- */
  function jsx(fn, args) {
    var call = fn + '(' + (args || []).map(function (a) { return JSON.stringify(String(a)); }).join(',') + ')';
    return new Promise(function (resolve, reject) {
      window.__adobe_cep__.evalScript(call, function (r) {
        if (!r || r === 'EvalScript error.') return reject(new Error('Premiere scripting error in ' + fn));
        var j; try { j = JSON.parse(r); } catch (e) { return reject(new Error('Unexpected reply from Premiere: ' + r)); }
        if (j.error) return reject(new Error(j.error));
        resolve(j);
      });
    });
  }

  /* ---------- folder scan ---------- */
  function walk(dir, depth, out) {
    var names = [];
    try { names = fs.readdirSync(dir); } catch (e) { return out; }
    names.forEach(function (n) {
      if (/^\./.test(n)) return;
      var p = pathMod.join(dir, n), st;
      try { st = fs.statSync(p); } catch (e) { return; }
      if (st.isDirectory()) { if (depth > 0 && !SKIP_DIRS.test(n)) walk(p, depth - 1, out); }
      else out.push({ path: p, name: n, rel: pathMod.relative(out.root, p), size: st.size, mtime: st.mtimeMs });
    });
    return out;
  }
  function scanFolder(dir) {
    var files = walk(dir, 2, Object.assign([], { root: dir }));
    var videos = files.filter(function (f) { return VIDEO.test(f.name); });
    // prefer the "Videos" sub-folder when it exists
    var inVideos = videos.filter(function (f) { return /^videos[\\/]/i.test(f.rel); });
    if (inVideos.length) videos = inVideos;
    var byName = {};
    videos.forEach(function (f) { byName[f.name] = f; });
    var clips = window.SosoPlan.scanClips(Object.keys(byName));
    var audios = files.filter(function (f) { return AUDIO.test(f.name); });
    var mds = files.filter(function (f) { return /\.md$/i.test(f.name); }).map(function (f) {
      var parsed = { lines: [] };
      try { parsed = window.SosoPlan.parseProjectMd(fs.readFileSync(f.path, 'utf8')); } catch (e) {}
      return { file: f, parsed: parsed };
    }).filter(function (m) { return m.parsed.lines.length; });
    return { dir: dir, byName: byName, clips: clips, audios: audios, mds: mds };
  }

  function fillSelect(el, items, pick) {
    el.innerHTML = '';
    items.forEach(function (it, i) {
      var o = document.createElement('option'); o.value = String(i); o.textContent = it.label;
      el.appendChild(o);
    });
    if (pick >= 0) el.value = String(pick);
  }

  function refreshFolder() {
    var dir = ($('folder').value || '').trim();
    scan = null; $('found').textContent = ''; fillSelect($('song'), [], -1); fillSelect($('timing'), [], -1);
    if (!dir) return Promise.resolve();
    if (!fs.existsSync(dir)) { status('Folder not found: ' + dir, 'err'); return Promise.resolve(); }
    scan = scanFolder(dir);
    var nScenes = Object.keys(scan.clips.scenes).length, hooks = scan.clips.hooks.map(function (h) { return 'hook ' + h.name; });
    $('found').textContent = nScenes + ' scene clips' + (hooks.length ? ', ' + hooks.join(', ') : '') + ', ' +
      scan.audios.length + ' audio file(s), ' + scan.mds.length + ' timing table(s)' +
      (scan.clips.skipped.length ? ' — not used: ' + scan.clips.skipped.join(', ') : '');
    fillSelect($('timing'), scan.mds.map(function (m) { return { label: m.file.rel + ' — ' + m.parsed.lines.length + ' lines' }; }), 0);
    if (!scan.mds.length) status('No timing table found (PROJECT_NNN.md with a | # | start | end | dur | line | table).', 'err');
    else status('Ready. ' + scan.mds[0].parsed.lines.length + ' lines, ' + nScenes + ' scenes.');
    // song: the one whose length matches the last line's end best
    return Promise.all(scan.audios.map(function (a) {
      return window.SosoAnalyze.mediaDuration(a.path).then(function (d) { a.dur = d; }, function () { a.dur = 0; });
    })).then(function () {
      var target = 0;
      if (scan.mds.length) { var L = scan.mds[0].parsed.lines; target = L[L.length - 1].end || 0; }
      var best = 0, bestD = Infinity;
      var named = scan.mds.length ? scan.mds[0].parsed.songName.toLowerCase() : '';
      if (scan.mds.length && scan.mds[0].parsed.duration) target = scan.mds[0].parsed.duration;
      scan.audios.forEach(function (a, i) {
        if (named && a.name.toLowerCase() === named) { bestD = -Infinity; best = i; }
        if (bestD === -Infinity) return;
        var d = target ? Math.abs(a.dur - target) : -a.mtime;
        if (d < bestD) { bestD = d; best = i; }
      });
      fillSelect($('song'), scan.audios.map(function (a) { return { label: a.rel + (a.dur ? ' (' + fmt(a.dur) + ')' : '') }; }), best);
    });
  }

  /* ---------- clip analysis (cached per folder) ---------- */
  function cachePath(dir) { return pathMod.join(dir, 'Soso Auto Edit', 'analysis.json'); }
  function loadCache(dir) { try { return JSON.parse(fs.readFileSync(cachePath(dir), 'utf8')); } catch (e) { return {}; } }
  function saveCache(dir, c) {
    try { fs.mkdirSync(pathMod.dirname(cachePath(dir)), { recursive: true }); fs.writeFileSync(cachePath(dir), JSON.stringify(c)); } catch (e) {}
  }
  function analyzeAll(files, dir) {
    var cache = loadCache(dir), out = {}, failed = 0, k = 0;
    return files.reduce(function (chain, f) {
      return chain.then(function () {
        k++;
        var key = f.name + '|' + f.size + '|' + Math.round(f.mtime);
        if (cache[key]) { out[f.name] = cache[key]; return; }
        status('Looking at the clips… ' + k + '/' + files.length + ' (' + f.name + ')');
        return window.SosoAnalyze.sampleMotion(f.path, 12).then(function (r) {
          var a = window.SosoPlan.analyzeMotion(r.motion, r.fps);
          out[f.name] = cache[key] = { dur: r.dur, width: r.width, height: r.height, analysis: a };
        }, function () { failed++; });
      });
    }, Promise.resolve()).then(function () { saveCache(dir, cache); return { byName: out, failed: failed }; });
  }

  /* ---------- the main action ---------- */
  function run() {
    var s = save();
    if (!scan) { status('Choose the project folder first.', 'err'); return; }
    var md = scan.mds[+$('timing').value], song = scan.audios[+$('song').value];
    if (!md) { status('No timing table to follow.', 'err'); return; }
    if (!song) { status('No song found in the folder.', 'err'); return; }
    busy(true); preview([]);
    var lines = md.parsed.lines, ctx = { notes: [] };
    var wanted = [];
    Object.keys(scan.clips.scenes).forEach(function (n) { scan.clips.scenes[n].forEach(function (c) { wanted.push(scan.byName[c.file]); }); });
    scan.clips.hooks.forEach(function (h) { wanted.push(scan.byName[h.file]); });

    jsx('sae_info').then(function () {
      return analyzeAll(wanted, scan.dir);
    }).then(function (an) {
      ctx.an = an.byName;
      if (an.failed) ctx.notes.push(an.failed + ' clip(s) could not be analysed here — placed from their first frame.');
      // exact line timing
      if (!s.precise) return null;
      if (!s.apiKey) { ctx.notes.push('No ElevenLabs key — used the timing table as is.'); return null; }
      status('Finding exactly where each line is sung (ElevenLabs)…');
      return window.OmniEleven.align(s.apiKey, song.path, lines.map(function (l) { return l.text; }).join('\n'))
        .then(function (r) { return r.words; }, function (e) { ctx.notes.push('Exact timing failed (' + e.message + ') — used the timing table.'); return null; });
    }).then(function (words) {
      ctx.lineStarts = words ? window.SosoPlan.lineStartsFromAlignment(lines, words) : null;
      if (ctx.lineStarts && ctx.lineStarts.every(function (x) { return x === null; })) {
        ctx.notes.push('The sung words did not match the lines — used the timing table.'); ctx.lineStarts = null;
      }
      // beat grid
      if (!s.snap) return null;
      if (md.parsed.bpm > 0 && md.parsed.firstBeat !== null) return { bpm: md.parsed.bpm, firstBeat: md.parsed.firstBeat, from: 'notes' };
      status('Measuring the beat…');
      return window.SosoAnalyze.decodeAudio(fs.readFileSync(song.path)).then(function (a) {
        var b = window.SosoBeat.detect(a.pcm, a.sr); if (b) b.from = 'song'; return b;
      }, function () { ctx.notes.push('Could not read the song for the beat — cuts not snapped.'); return null; });
    }).then(function (beat) {
      ctx.beat = beat;
      var clipsFor = {};
      Object.keys(scan.clips.scenes).forEach(function (n) {
        clipsFor[n] = scan.clips.scenes[n].map(function (c) {
          var a = ctx.an[c.file] || {};
          return { file: c.file, dur: a.dur || 0, analysis: a.analysis || null };
        });
      });
      var variants = [{ label: 'A', hook: null }];
      if (s.hookSeqs) scan.clips.hooks.forEach(function (h) {
        var a = ctx.an[h.file] || {};
        variants.push({ label: 'hook ' + h.name, hook: { file: h.file, dur: a.dur || 0, analysis: a.analysis || null } });
      });
      var first = ctx.an[(clipsFor[lines[0].n] || [{}])[0].file] || {};
      var scale = (s.size1080 && first.width) ? Math.max(1080 / first.width, 1920 / first.height) * 100 : 100;
      var project = pathMod.basename(scan.dir).split(/[-\s]/)[0] || 'Edit';
      var outDir = pathMod.join(scan.dir, 'Soso Auto Edit');
      try { fs.mkdirSync(outDir, { recursive: true }); } catch (e) {}
      var results = [], allRows = [];

      return variants.reduce(function (chain, v) {
        return chain.then(function () {
          var plan = window.SosoPlan.buildPlan(lines, clipsFor, song.dur || 0, {
            lineStarts: ctx.lineStarts, snap: !!beat, bpm: beat && beat.bpm, firstBeat: beat && beat.firstBeat,
            snapTol: parseFloat(s.snapTol) || 0.12, offset: parseFloat(s.offset) || 0, trimFrozen: s.trimFrozen, fps: 24, hookFile: v.hook
          });
          var name = project + ' Auto ' + v.label;
          var hostPlan = {
            name: name, binName: project + ' clips',
            items: plan.items.map(function (it) {
              return { path: scan.byName[it.file].path, start: it.start, srcIn: it.srcIn, srcOut: it.srcOut, scene: it.scene };
            }),
            music: { path: song.path },
            markers: plan.markers,
            width: s.size1080 ? 1080 : 0, height: s.size1080 ? 1920 : 0, scale: scale, muteClips: s.muteClips
          };
          try { fs.writeFileSync(pathMod.join(outDir, name.replace(/[^\w\- ]+/g, '_') + '.json'), JSON.stringify({ plan: plan, host: hostPlan, beat: beat, notes: ctx.notes }, null, 1)); } catch (e) {}
          status('Building "' + name + '" in Premiere…');
          return jsx('sae_build', [JSON.stringify(hostPlan)]).then(function (r) {
            results.push(r);
            allRows.push({ t: '', x: '— ' + r.name + ' —' });
            plan.items.forEach(function (it) {
              allRows.push({ t: fmt(it.start), x: 'sc' + it.scene + '  ' + it.file + (it.srcIn > 0.01 ? '  (from ' + it.srcIn.toFixed(2) + ' s)' : '') });
            });
            plan.markers.forEach(function (m) { allRows.push({ t: fmt(m.t), x: '⚠ ' + m.text, bad: true }); });
            (r.errors || []).forEach(function (e) { allRows.push({ t: '', x: '⚠ ' + e, bad: true }); });
          });
        });
      }, Promise.resolve()).then(function () {
        preview(allRows);
        var marks = results.reduce(function (a, r) { return a + (r.markers || 0); }, 0);
        status('Done: ' + results.length + ' sequence(s) — ' + results.map(function (r) { return r.name; }).join(', ') + '. ' +
          (ctx.lineStarts ? 'Cuts on the sung lines' : 'Cuts from the timing table') +
          (beat ? ', snapped to the beat (' + beat.bpm + ' BPM)' : '') + '. ' +
          (marks ? marks + ' red marker(s) to check. ' : 'No problems found. ') +
          (ctx.notes.length ? ctx.notes.join(' ') + ' ' : '') + 'Next: Soso Captions on each sequence.', marks ? '' : 'ok');
      });
    }).catch(function (e) { status(e.message || String(e), 'err'); })
      .then(function () { busy(false); });
  }

  /* ---------- self-update ---------- */
  function updateBase() { return ($('updateUrl').value || '').trim() || UPDATE_BASE; }
  function checkUpdate(manual) {
    var U = window.OmniUpdater;
    $('ver').textContent = 'v' + U.localVersion();
    U.check(updateBase()).then(function (m) {
      if (!m) { if (manual) status('Up to date (v' + U.localVersion() + ').', 'ok'); return; }
      $('updText').textContent = 'Update ' + m.version + ' available' + (m.notes ? ' — ' + m.notes : '');
      $('updBar').style.display = 'block';
      $('updBtn').onclick = function () { doUpdate(m); };
    }).catch(function (e) { if (manual) status('Could not check for updates: ' + e.message, 'err'); });
  }
  function doUpdate(m) {
    var U = window.OmniUpdater;
    $('updBtn').disabled = true;
    U.apply(updateBase(), m, null, function (i, n) { $('updText').textContent = 'Downloading ' + i + '/' + n + '…'; })
      .then(function (res) {
        if (res.restart) { $('updText').textContent = 'Updated to ' + m.version + '. Restart Premiere Pro to finish.'; return; }
        var jsxPath = (res.dir + '/jsx/host.jsx').replace(/\\/g, '/');
        window.__adobe_cep__.evalScript('$.evalFile(new File(' + JSON.stringify(jsxPath) + '))', function () { location.reload(); });
      })
      .catch(function (e) { $('updText').textContent = 'Update failed — nothing was changed. ' + e.message; $('updBtn').disabled = false; });
  }

  document.addEventListener('DOMContentLoaded', function () {
    load();
    $('run').onclick = run;
    $('pickFolder').onclick = function () {
      var r = window.cep.fs.showOpenDialog(false, true, 'Pick the project folder (with the clips and the song)', $('folder').value || '', []);
      if (r && r.data && r.data[0]) { $('folder').value = r.data[0]; save(); refreshFolder(); }
    };
    $('folder').addEventListener('change', function () { save(); refreshFolder(); });
    KEYS.forEach(function (k) { var el = $(k); if (el) el.addEventListener('change', save); });
    $('toggleKey').onclick = function () { var el = $('apiKey'); el.type = el.type === 'password' ? 'text' : 'password'; };
    $('checkUpd').onclick = function () { checkUpdate(true); };
    refreshFolder();
    setTimeout(function () { checkUpdate(false); }, 1200);
    if (window.SosoAccess) window.SosoAccess.check('Soso Auto Edit', window.OmniUpdater.localVersion(), window.OmniUpdater._get)
      .then(function (r) { if (r.blocked) window.SosoAccess.lockPanel(document, r); }).catch(function () {});
  });
})();

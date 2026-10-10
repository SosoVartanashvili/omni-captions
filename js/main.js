/* OMNI Captions — panel controller. */
(function () {
  'use strict';
  var req = (typeof require === 'function') ? require : window.cep_node.require;
  var fs = req('fs'), pathMod = req('path'), os = req('os');

  var $ = function (id) { return document.getElementById(id); };
  var UPDATE_BASE = 'https://raw.githubusercontent.com/SosoVartanashvili/omni-captions/main';
  var PRESETS = {
    'basic-ugc': {
      name: 'Basic (UGC) non background',
      text: 'Proxima Nova Semibold · 60 · centred · bottom-centre zone · fill white · stroke black 6.5 px centre · no background · no shadow',
      rules: { maxChars: 24, maxLines: 2 }
    }
  };
  function applyPreset(setRules) {
    var p = PRESETS[$('stylePreset').value] || PRESETS['basic-ugc'];
    $('styleInfo').textContent = p.text;
    if (setRules) { $('maxChars').value = p.rules.maxChars; $('maxLines').value = p.rules.maxLines; }
  }
  var KEYS = ['stylePreset', 'fillGap', 'updateUrl', 'apiKey', 'mode', 'language', 'maxChars', 'maxLines', 'minDur', 'maxDur', 'tracks', 'upper', 'stripEndPunct', 'noDotsCommas', 'preset', 'rulesDir'];

  /* ---------- settings ---------- */
  function load() {
    var s = {};
    try { s = JSON.parse(localStorage.getItem('omniCaptions') || '{}'); } catch (e) {}
    if (s._v !== 2) { if (String(s.maxChars) === '32') s.maxChars = '24'; s._v = 2; }   // v1 default made 3-line captions
    if (!s._v3) { if (!s.mode || s.mode === 'transcribe') s.mode = 'sync'; s._v3 = 1; }   // script matching is the new default
    try { var sc = localStorage.getItem('omniCaptionsScript'); if (sc) $('script').value = sc; } catch (e) {}
    KEYS.forEach(function (k) {
      var el = $(k); if (!el || s[k] === undefined) return;
      if (el.type === 'checkbox') el.checked = !!s[k]; else el.value = s[k];
    });
    toggleScript();
  }
  function save() {
    var s = {};
    KEYS.forEach(function (k) { var el = $(k); if (el) s[k] = el.type === 'checkbox' ? el.checked : el.value; });
    s._v = 2; s._v3 = 1;
    try { localStorage.setItem('omniCaptionsScript', $('script').value || ''); } catch (e) {}
    try { localStorage.setItem('omniCaptions', JSON.stringify(s)); } catch (e) {}
    return s;
  }
  function opts(s) {
    return {
      maxChars: parseInt(s.maxChars, 10) || 24, maxLines: parseInt(s.maxLines, 10) || 2,
      minDur: parseFloat(s.minDur) || 0.7, maxDur: parseFloat(s.maxDur) || 6,
      upper: !!s.upper, stripEndPunct: !!s.stripEndPunct, noDotsCommas: !!s.noDotsCommas,
      fillGap: s.fillGap === '' || s.fillGap === undefined ? 1.5 : (parseFloat(s.fillGap) || 0)
    };
  }
  function toggleScript() { $('scriptBox').style.display = $('mode').value === 'transcribe' ? 'none' : 'block'; }

  /* ---------- UI ---------- */
  function status(msg, kind) { var el = $('status'); el.textContent = msg; el.className = 'status ' + (kind || ''); }
  function busy(on) { ['run', 'rebuild', 'learn'].forEach(function (id) { $(id).disabled = on; }); }

  function preview(caps) {
    var list = $('preview'); list.innerHTML = '';
    caps.slice(0, 400).forEach(function (c) {
      var row = document.createElement('div'); row.className = 'cap';
      var t = document.createElement('span'); t.className = 't';
      t.textContent = c.start.toFixed(2) + '–' + c.end.toFixed(2);
      var x = document.createElement('span'); x.className = 'x'; x.textContent = c.text.replace(/\n/g, ' / ');
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

  function pickPreset() {
    var r = window.cep.fs.showOpenDialog(false, false, 'Pick an audio export preset (.epr) — WAV or MP3', '', ['epr']);
    if (r && r.data && r.data[0]) { $('preset').value = r.data[0]; save(); }
  }

  /* ---------- files ---------- */
  function safe(n) { return String(n).replace(/[^\w\- ]+/g, '_').trim() || 'sequence'; }
  function workDir(info) {
    var dir = info.projectPath ? pathMod.join(pathMod.dirname(info.projectPath), 'OMNI Captions')
                               : pathMod.join(os.tmpdir(), 'OMNI Captions');
    try { fs.mkdirSync(dir, { recursive: true }); } catch (e) {}
    return dir;
  }
  function autoSrtFile(info) { return pathMod.join(workDir(info), safe(info.name) + '_' + safe(info.id).slice(0, 8) + '_auto.srt'); }
  function wordsFile(info) { return pathMod.join(workDir(info), safe(info.name) + '_' + safe(info.id).slice(0, 8) + '_words.json'); }
  function stamp() { var d = new Date(); return [d.getHours(), d.getMinutes(), d.getSeconds()].map(function (n) { return (n < 10 ? '0' : '') + n; }).join(''); }

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
        if (res.restart) {
          $('updText').textContent = 'Updated to ' + m.version + '. Restart Premiere Pro to finish.';
          return;
        }
        var jsxPath = (res.dir + '/jsx/host.jsx').replace(/\\/g, '/');
        window.__adobe_cep__.evalScript('$.evalFile(new File(' + JSON.stringify(jsxPath) + '))', function () {
          location.reload();
        });
      })
      .catch(function (e) {
        $('updText').textContent = 'Update failed — nothing was changed. ' + e.message;
        $('updBtn').disabled = false;
      });
  }

  /* ---------- the shared rules file (learned fixes) ---------- */
  function rulesPath() {
    var dir = ($('rulesDir').value || '').trim() || pathMod.join(os.homedir(), 'OMNI Captions');
    try { fs.mkdirSync(dir, { recursive: true }); } catch (e) {}
    return pathMod.join(dir, 'omni-captions-rules.json');
  }
  function readRules() {
    try { var r = JSON.parse(fs.readFileSync(rulesPath(), 'utf8')); r.fixes = r.fixes || {}; return r; }
    catch (e) { return { fixes: {} }; }
  }
  // always re-read right before writing, so two editors on a shared folder do not wipe each other
  function updateRules(mutate) {
    var r = readRules();
    mutate(r);
    r.updated = new Date().toISOString();
    var p = rulesPath(), tmp = p + '.' + Date.now() + Math.random().toString(16).slice(2) + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(r, null, 1), 'utf8');
    fs.renameSync(tmp, p);
    showFixes(r);
    return r;
  }
  function showFixes(r) {
    r = r || readRules();
    $('fixes').value = window.OmniLearn.fixText(r.fixes);
    $('fixCount').textContent = Object.keys(r.fixes).length + ' learned fixes · ' + rulesPath();
  }
  function saveFixes() {
    var parsed = window.OmniLearn.parseFixText($('fixes').value);
    updateRules(function (r) { r.fixes = parsed; });
    status('Saved ' + Object.keys(parsed).length + ' fixes. They apply from the next Transcribe / Rebuild.', 'ok');
  }

  // compare the panel's last captions for this sequence with the editor's corrected export
  function learnFromSrt() {
    var s = save();
    jsx('omni_seqInfo', [s.tracks || 'all']).then(function (info) {
      var auto = autoSrtFile(info);
      if (!fs.existsSync(auto)) throw new Error('No captions made by the panel for this sequence yet.');
      var r = window.cep.fs.showOpenDialog(false, false, 'Pick the corrected captions (.srt) you exported from Premiere', workDir(info), ['srt']);
      if (!r || !r.data || !r.data[0]) return;
      var learned = window.OmniLearn.learn(fs.readFileSync(auto, 'utf8'), fs.readFileSync(r.data[0], 'utf8'));
      var keys = Object.keys(learned);
      if (!keys.length) return status('No word fixes found between the two files (punctuation and line breaks are not learned).', 'ok');
      updateRules(function (rules) {
        keys.forEach(function (k) { rules.fixes[k] = learned[k]; });
      });
      status('Learned ' + keys.length + ': ' + keys.map(function (k) { return k + ' → ' + learned[k]; }).join(', '), 'ok');
    }).catch(function (e) { status(e.message || String(e), 'err'); });
  }

  /* ---------- the two buttons ---------- */
  function finish(info, words, s) {
    var rules = readRules(), syncNote = '';
    var script = ($('script').value || '').trim();
    if (s.mode === 'sync' && script) {
      var cl = window.OmniSync.cleanScript(script);
      var m = window.OmniSync.merge(words, cl.text);
      words = m.words;
      syncNote = ' Script: ' + cl.removed.length + ' heading/note lines removed, ' + m.stats.matched + ' words matched, ' + m.stats.fixed + ' corrected from the script, ' +
        m.stats.keptHeard + ' said but not in the script (kept), ' + m.stats.droppedScript + ' script words not in the audio (skipped).';
    }
    var fixed = window.OmniLearn.applyFixes(words, rules.fixes);
    var caps = window.OmniCaptions.build(fixed, info.cuts, info, opts(s));
    if (!caps.length) throw new Error('No words found in the audio.');
    var cuts = window.OmniCaptions._normCuts(info.cuts, info.frame, info.end || 1e9);
    preview(caps);
    var text = window.OmniCaptions.toSRT(caps);
    var srt = pathMod.join(workDir(info), safe(info.name) + '_captions_' + stamp() + '.srt');
    fs.writeFileSync(srt, text, 'utf8');
    fs.writeFileSync(autoSrtFile(info), text, 'utf8');
    fs.writeFileSync(pathMod.join(workDir(info), safe(info.name) + '_debug.json'), JSON.stringify({
      when: new Date().toISOString(), sequence: info.name, frame: info.frame, end: info.end,
      tracks: info.tracks, clips: info.clips, cutsUsed: cuts, settings: opts(s),
      captions: caps.map(function (c) { return [+c.start.toFixed(3), +c.end.toFixed(3), c.shot, c.text]; })
    }, null, 1), 'utf8');
    status('Placing ' + caps.length + ' captions on the sequence…');
    return jsx('omni_importCaptions', [srt]).then(function () {
      if (!cuts.length) {
        status('Captions placed, but NO cuts were found on the video tracks (' + (info.tracks || 'none') +
          '), so they could not be fitted to cuts. Check "Cut tracks" in Caption rules.', 'err');
        return;
      }
      status('Done — ' + caps.length + ' captions, fitted to ' + cuts.length + ' cuts (' + info.tracks + '). ' +
        Object.keys(rules.fixes).length + ' learned fixes applied.' + syncNote + ' Apply your caption style to the track.', 'ok');
    });
  }

  function run() {
    var s = save(), info, tmpWav = null;
    if (!s.apiKey) return status('Paste your ElevenLabs API key in Settings first.', 'err');
    busy(true);
    status('Reading the sequence…');
    jsx('omni_seqInfo', [s.tracks || 'all']).then(function (i) {
      info = i;
      if (s.mode === 'align' && !$('script').value.trim()) {
        throw new Error('"Align my script" needs a script — or switch Source to Transcribe.');
      }
      // sync mode with an empty script box = a plain transcription (the editors' normal case)
      if (s.preset && fs.existsSync(s.preset)) return { path: s.preset };
      return jsx('omni_findPreset');
    }).then(function (p) {
      if (!p.path) throw new Error('No WAV export preset found. Click "Choose…" next to Export preset and pick any audio .epr.');
      $('preset').value = p.path; save();
      status('Exporting the sequence audio (' + Math.round(info.end) + ' s)…');
      tmpWav = pathMod.join(os.tmpdir(), 'omni_captions_' + Date.now() + '.wav');
      return jsx('omni_exportAudio', [tmpWav, p.path]);
    }).then(function (a) {
      status((s.mode === 'align' ? 'Aligning the script' : 'Transcribing') + ' with ElevenLabs (' + Math.round(a.bytes / 1048576) + ' MB)…');
      // sync mode = a normal transcription; the script is matched to it afterwards (and again on every Rebuild)
      var call = s.mode === 'align'
        ? window.OmniEleven.align(s.apiKey, a.path, window.OmniSync.cleanScript($('script').value).text)
        : window.OmniEleven.transcribe(s.apiKey, a.path, { language: s.language });
      return call;
    }).then(function (res) {
      fs.writeFileSync(wordsFile(info), JSON.stringify({ seq: info.name, mode: s.mode, words: res.words }, null, 1), 'utf8');
      return finish(info, res.words, s);
    }).catch(function (e) { status(e.message || String(e), 'err'); })
      .then(function () {
        if (tmpWav) { try { fs.unlinkSync(tmpWav); } catch (e) {} }
        busy(false);
      });
  }

  // Rebuild from the saved transcript: new cuts, new settings, no ElevenLabs credits
  function rebuild() {
    var s = save();
    busy(true);
    jsx('omni_seqInfo', [s.tracks || 'all']).then(function (info) {
      var f = wordsFile(info);
      if (!fs.existsSync(f)) throw new Error('No saved transcript for this sequence yet — run "Transcribe & caption" once.');
      var words = JSON.parse(fs.readFileSync(f, 'utf8')).words;
      status('Rebuilding from the saved transcript (no credits)…');
      return finish(info, words, s);
    }).catch(function (e) { status(e.message || String(e), 'err'); })
      .then(function () { busy(false); });
  }

  document.addEventListener('DOMContentLoaded', function () {
    load();
    $('run').onclick = run;
    $('rebuild').onclick = rebuild;
    $('pickPreset').onclick = pickPreset;
    $('learn').onclick = learnFromSrt;
    applyPreset(false);
    $('stylePreset').addEventListener('change', function () { applyPreset(true); save(); });

    $('script').addEventListener('change', save);
    $('saveFixes').onclick = saveFixes;
    $('pickRules').onclick = function () {
      var r = window.cep.fs.showOpenDialog(false, true, 'Pick the shared folder (e.g. a Google Drive / Dropbox folder)', '', []);
      if (r && r.data && r.data[0]) { $('rulesDir').value = r.data[0]; save(); showFixes(); }
    };
    $('rulesDir').addEventListener('change', function () { showFixes(); });
    showFixes();
    $('checkUpd').onclick = function () { checkUpdate(true); };
    setTimeout(function () { checkUpdate(false); }, 1200);
    $('mode').onchange = function () { toggleScript(); save(); };
    KEYS.forEach(function (k) { var el = $(k); if (el) el.addEventListener('change', save); });
    $('toggleKey').onclick = function () { var el = $('apiKey'); el.type = el.type === 'password' ? 'text' : 'password'; };
  });
})();

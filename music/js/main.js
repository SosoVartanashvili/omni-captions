/* Soso Music — panel controller. */
(function () {
  'use strict';
  var req = (typeof require === 'function') ? require : window.cep_node.require;
  var fs = req('fs'), pathMod = req('path'), os = req('os');

  var $ = function (id) { return document.getElementById(id); };
  var UPDATE_BASE = 'https://raw.githubusercontent.com/SosoVartanashvili/omni-captions/main/music';
  var BASE_PROMPT = 'Background music bed for a short vertical social-media video ad. It sits under a voice-over, so keep it ' +
    'steady and supportive, no lead melody fighting the voice.';
  var STYLES = {
    'ugc-pop': 'Upbeat, bright modern pop groove, light drums, plucky synths, positive and energetic, around 110-120 BPM.',
    'emotional': 'Emotional, warm piano with soft strings, heartfelt and sincere, slow to medium tempo.',
    'lofi': 'Lo-fi chill hip-hop, mellow keys, dusty drums, relaxed and cozy, around 80-90 BPM.',
    'hiphop': 'Modern hip-hop beat, punchy kick and snare, deep 808 bass, confident, around 90-100 BPM.',
    'cinematic': 'Cinematic drama, tense pulsing strings and low percussion, suspense that builds.',
    'quirky': 'Funny, quirky and playful, pizzicato strings, bouncy percussion, light comedic feel.',
    'spooky': 'Spooky Halloween, playful-creepy, celesta and low strings, eerie but fun, not horror.',
    'inspiring': 'Inspiring motivational, uplifting piano and claps, builds to a confident positive lift.',
    'custom': '',
    'auto': ''
  };
  var TAGS = {
    'ugc-pop': ['upbeat', 'pop', 'energetic'], 'emotional': ['emotional', 'piano', 'strings'],
    'lofi': ['lo-fi', 'chill'], 'hiphop': ['hip-hop', 'beat'], 'cinematic': ['cinematic', 'tension'],
    'quirky': ['quirky', 'playful', 'funny'], 'spooky': ['spooky', 'halloween', 'playful'],
    'inspiring': ['inspiring', 'uplifting'], 'custom': [], 'auto': []
  };
  var KEYS = ['source', 'vpreset', 'apiKey', 'updateUrl', 'range', 'style', 'prompt', 'instrumental', 'cleanEnd', 'db', 'model'];

  /* ---------- settings ---------- */
  function load() {
    var s = {};
    try { s = JSON.parse(localStorage.getItem('sosoMusic') || '{}'); } catch (e) {}
    KEYS.forEach(function (k) {
      var el = $(k); if (!el || s[k] === undefined) return;
      if (el.type === 'checkbox') el.checked = !!s[k]; else el.value = s[k];
    });
  }
  function save() {
    var s = {};
    KEYS.forEach(function (k) { var el = $(k); if (el) s[k] = el.type === 'checkbox' ? el.checked : el.value; });
    try { localStorage.setItem('sosoMusic', JSON.stringify(s)); } catch (e) {}
    return s;
  }

  /* ---------- UI ---------- */
  function status(msg, kind) { var el = $('status'); el.textContent = msg; el.className = 'status ' + (kind || ''); }
  function busy(on) { $('run').disabled = on; $('refresh').disabled = on; }
  function fmt(sec) {
    var m = Math.floor(sec / 60), s = sec - m * 60;
    return m + ':' + (s < 10 ? '0' : '') + s.toFixed(1);
  }
  function addHistory(t, text) {
    var row = document.createElement('div'); row.className = 'cap';
    var a = document.createElement('span'); a.className = 't'; a.textContent = t;
    var b = document.createElement('span'); b.className = 'x'; b.textContent = text;
    row.appendChild(a); row.appendChild(b);
    $('history').insertBefore(row, $('history').firstChild);
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

  // which part of the timeline the music must cover
  function rangeOf(info, mode) {
    if (mode === 'inout' && !info.hasInOut) throw new Error('No In/Out set on the sequence. Mark In (I) and Out (O), or choose "Whole sequence".');
    if ((mode === 'inout' || mode === 'auto') && info.hasInOut) return { start: info.inPoint, end: info.outPoint, label: 'In → Out' };
    return { start: 0, end: info.end, label: 'whole sequence' };
  }

  function showLength() {
    return jsx('sm_seqInfo').then(function (info) {
      var r = rangeOf(info, $('range').value);
      var d = r.end - r.start;
      $('len').textContent = fmt(d) + '  (' + r.label + ', ' + info.name + ')' +
        (d > 600 ? '  — longer than 10:00, music will be 10:00' : d < 3 ? '  — shorter than 3 s' : '');
      return { info: info, range: r };
    }).catch(function (e) { $('len').textContent = '—'; throw e; });
  }

  /* ---------- prompt ---------- */
  function buildPrompt(s, seconds) {
    var parts = [BASE_PROMPT];
    if (STYLES[s.style]) parts.push(STYLES[s.style]);
    if ((s.prompt || '').trim()) parts.push('Direction: ' + s.prompt.trim());
    if (s.instrumental) parts.push('Instrumental only, no vocals.');
    if (s.cleanEnd) parts.push('It must end with a clear, natural final hit or resolved chord exactly at ' + seconds.toFixed(1) + ' seconds' +
      ' — no long fade-out and no abrupt cut.');
    if ((s.style === 'custom' || s.style === 'auto') && !(s.prompt || '').trim())
      throw new Error('Text mode needs a style or a short description of the music.');
    return parts.join(' ');
  }

  // Video to Music: ElevenLabs reads the vibe from the picture; we only steer it
  function buildVideoAsk(s, seconds) {
    var parts = ['Background music for a short vertical social-media video ad with a voice-over. Follow the mood, pace and cuts of the video.'];
    if (STYLES[s.style]) parts.push(STYLES[s.style]);
    if ((s.prompt || '').trim()) parts.push('Direction: ' + s.prompt.trim());
    if (s.instrumental) parts.push('Instrumental only, no vocals.');
    if (s.cleanEnd) parts.push('End with a clear, natural final hit exactly at the end of the video (' + seconds.toFixed(1) + ' seconds), no long fade-out.');
    var tags = (TAGS[s.style] || []).slice();
    if (s.instrumental) tags.push('instrumental');
    return { description: parts.join(' '), tags: tags };
  }
  function sourceHint() {
    var v = $('source').value === 'video';
    $('srcHint').textContent = v
      ? 'The timeline is exported as a small MP4 and ElevenLabs watches it — mood, pace and cuts — then scores it. Style and description are optional steering.'
      : 'Text to music: the style and description decide everything; the video is not looked at.';
    if (!v && $('style').value === 'auto') $('style').value = 'ugc-pop';
  }
  function findVideoPreset(s) {
    if (s.vpreset && fs.existsSync(s.vpreset)) return Promise.resolve(s.vpreset);
    return jsx('sm_findVideoPreset').then(function (r) {
      if (!r.path) throw new Error('Could not find a video export preset. Settings › Video export preset › Choose… and pick an H.264 .epr (e.g. one saved from File › Export › Media).');
      $('vpreset').value = r.path; save();
      return r.path;
    });
  }

  /* ---------- files ---------- */
  function safe(n) { return String(n).replace(/[^\w\- ]+/g, '_').trim() || 'sequence'; }
  function workDir(info) {
    var dir = info.projectPath ? pathMod.join(pathMod.dirname(info.projectPath), 'Soso Music')
                               : pathMod.join(os.tmpdir(), 'Soso Music');
    try { fs.mkdirSync(dir, { recursive: true }); } catch (e) {}
    return dir;
  }
  function stamp() { var d = new Date(); return [d.getHours(), d.getMinutes(), d.getSeconds()].map(function (n) { return (n < 10 ? '0' : '') + n; }).join(''); }

  /* ---------- main action ---------- */
  function run() {
    var s = save();
    if (!s.apiKey) { status('Paste your ElevenLabs API key in Settings first.', 'err'); return; }
    busy(true);
    var started = Date.now(), ctx = {};
    status('Reading the timeline…');
    showLength().then(function (r) {
      ctx = r;
      var secs = r.range.end - r.range.start;
      if (secs < 1) throw new Error('The range is empty.');
      ctx.secs = Math.min(secs, 600);
      ctx.file = pathMod.join(workDir(r.info), safe(r.info.name) + '_music_' + stamp() + '.mp3');
      if (s.source !== 'video') {
        ctx.prompt = buildPrompt(s, Math.max(3, ctx.secs));
        status('Composing ' + fmt(ctx.secs) + ' of music with ElevenLabs… (usually 30–90 s)');
        return window.SosoMusicApi.compose(s.apiKey, ctx.file, {
          prompt: ctx.prompt, seconds: ctx.secs, model: s.model, instrumental: s.instrumental
        });
      }
      if (secs > 600) throw new Error('Video to Music takes up to 10:00. Set In/Out on a shorter part.');
      var ask = buildVideoAsk(s, ctx.secs);
      ctx.prompt = ask.description + (ask.tags.length ? '  [tags: ' + ask.tags.join(', ') + ']' : '');
      status('Exporting a small MP4 of the ' + r.range.label + ' for the AI to watch…');
      return findVideoPreset(s).then(function (preset) {
        var mp4 = ctx.file.replace(/\.mp3$/, '_preview.mp4');
        return jsx('sm_exportVideo', [mp4, preset, r.range.label === 'In → Out' ? '1' : '0']);
      }).then(function (v) {
        ctx.video = v.path;
        status('ElevenLabs is watching the video and composing ' + fmt(ctx.secs) + ' of music… (1–3 min)');
        return window.SosoMusicApi.videoToMusic(s.apiKey, ctx.file, {
          videoPath: v.path, description: ask.description, tags: ask.tags, model: s.model, seconds: ctx.secs
        });
      });
    }).then(function (res) {
      ctx.res = res;
      if (ctx.video) { try { fs.unlinkSync(ctx.video); } catch (e) {} }
      fs.writeFileSync(ctx.file.replace(/\.mp3$/, '.json'), JSON.stringify({
        source: s.source, sequence: ctx.info.name, start: ctx.range.start, end: ctx.range.end, ms: res.ms, model: s.model,
        songId: res.songId, prompt: ctx.prompt, created: new Date().toISOString()
      }, null, 1));
      status('Placing it on the timeline…');
      var placeEnd = ctx.range.start + ctx.secs;
      return jsx('sm_placeMusic', [ctx.file, ctx.range.start, placeEnd, s.db === '' ? 'x' : s.db]);
    }).then(function (p) {
      var took = Math.round((Date.now() - started) / 1000);
      var name = pathMod.basename(ctx.file);
      if (!p.placed) {
        status('Music made (' + fmt(ctx.secs) + ') and imported into the "Soso Music" bin, but every audio track is busy — drag ' +
          name + ' onto the timeline.', 'ok');
      } else {
        status('Done in ' + took + ' s — ' + fmt(ctx.secs) + ' of music on ' + p.track +
          (p.volume ? ' at ' + s.db + ' dB' : '') + '. Not right? Change the description and press again — a new version goes on its own track.', 'ok');
      }
      addHistory(p.track || 'bin', name + ' — ' + ($('style').selectedOptions[0] || {}).textContent + (s.prompt ? ': ' + s.prompt.slice(0, 60) : ''));
    }).catch(function (e) {
      status(e.message || String(e), 'err');
    }).then(function () { busy(false); });
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
      .catch(function (e) {
        $('updText').textContent = 'Update failed — nothing was changed. ' + e.message;
        $('updBtn').disabled = false;
      });
  }

  document.addEventListener('DOMContentLoaded', function () {
    load();
    $('run').onclick = run;
    sourceHint();
    $('source').addEventListener('change', function () { sourceHint(); save(); });
    $('pickVPreset').onclick = function () {
      var r = window.cep.fs.showOpenDialog(false, false, 'Pick a video export preset (.epr) — H.264 / MP4', '', ['epr']);
      if (r && r.data && r.data[0]) { $('vpreset').value = r.data[0]; save(); }
    };
    $('refresh').onclick = function () { showLength().catch(function (e) { status(e.message, 'err'); }); };
    $('range').addEventListener('change', function () { save(); showLength().catch(function (e) { status(e.message, 'err'); }); });
    KEYS.forEach(function (k) { var el = $(k); if (el) el.addEventListener('change', save); });
    $('toggleKey').onclick = function () { var el = $('apiKey'); el.type = el.type === 'password' ? 'text' : 'password'; };
    $('checkUpd').onclick = function () { checkUpdate(true); };
    showLength().catch(function () {});
    setTimeout(function () { checkUpdate(false); }, 1200);
    if (window.SosoAccess) window.SosoAccess.check('Soso Music', window.OmniUpdater.localVersion(), window.OmniUpdater._get)
      .then(function (r) { if (r.blocked) window.SosoAccess.lockPanel(document, r); }).catch(function () {});
  });

  window.SosoMusic = { buildPrompt: buildPrompt, buildVideoAsk: buildVideoAsk, rangeOf: rangeOf };
})();

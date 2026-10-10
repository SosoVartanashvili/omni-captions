/*
 * OMNI Captions — Premiere Pro side (ExtendScript, ES3).
 * Everything returns a JSON string; errors come back as {"error": "..."}.
 */

var OMNI_TPS = 254016000000; // Premiere ticks per second

function omni_q(s) {
  s = String(s);
  var out = '"';
  for (var i = 0; i < s.length; i++) {
    var c = s.charAt(i), code = s.charCodeAt(i);
    if (c === '"') out += '\\"';
    else if (c === '\\') out += '\\\\';
    else if (c === '\n') out += '\\n';
    else if (c === '\r') out += '\\r';
    else if (c === '\t') out += '\\t';
    else if (code < 32) out += ' ';
    else out += c;
  }
  return out + '"';
}

function omni_json(v) {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'number') return isFinite(v) ? String(v) : 'null';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'string') return omni_q(v);
  if (v instanceof Array) {
    var a = [];
    for (var i = 0; i < v.length; i++) a.push(omni_json(v[i]));
    return '[' + a.join(',') + ']';
  }
  var parts = [];
  for (var k in v) if (v.hasOwnProperty(k)) parts.push(omni_q(k) + ':' + omni_json(v[k]));
  return '{' + parts.join(',') + '}';
}

function omni_err(msg) { return omni_json({ error: String(msg) }); }

/* tracksSpec: "all" or "1,2,3" (V1 = 1). Returns sequence facts + every edit point. */
function omni_seqInfo(tracksSpec) {
  try {
    if (!app.project) return omni_err('No project open.');
    var seq = app.project.activeSequence;
    if (!seq) return omni_err('No active sequence. Click into the timeline first.');

    var wanted = null;
    if (tracksSpec && String(tracksSpec).toLowerCase() !== 'all') {
      wanted = {};
      var bits = String(tracksSpec).split(/[ ,;]+/);
      for (var b = 0; b < bits.length; b++) if (bits[b]) wanted[parseInt(bits[b], 10)] = true;
    }

    var cuts = [], clipCount = 0, perTrack = [];
    for (var t = 0; t < seq.videoTracks.numTracks; t++) {
      if (wanted && !wanted[t + 1]) continue;
      var tr = seq.videoTracks[t], n = 0;
      for (var c = 0; c < tr.clips.numItems; c++) {
        var clip = tr.clips[c];
        try { if (clip.disabled) continue; } catch (e2) {}
        cuts.push(clip.start.seconds);
        cuts.push(clip.end.seconds);
        clipCount++; n++;
      }
      perTrack.push('V' + (t + 1) + ':' + n);
    }

    var frame = Number(seq.timebase) / OMNI_TPS;
    var end = Number(seq.end) / OMNI_TPS;
    var projPath = '';
    try { projPath = app.project.path || ''; } catch (e3) {}

    return omni_json({
      name: seq.name, id: seq.sequenceID, frame: frame, end: end,
      cuts: cuts, clips: clipCount, tracks: perTrack.join(' '), projectPath: projPath
    });
  } catch (e) { return omni_err(e.toString()); }
}

/* Find a WAV export preset that ships with Premiere. Returns {path:""} when none is found. */
function omni_findPreset() {
  try {
    var base = String(app.path).replace(/[\\\/]+$/, '');
    var roots = [
      base + '/MediaIO/systempresets',
      base + '/Contents/MediaIO/systempresets',
      base + '/../MediaIO/systempresets',
      base + '/../../MediaIO/systempresets'
    ];
    for (var r = 0; r < roots.length; r++) {
      var root = new Folder(roots[r]);
      if (!root.exists) continue;
      var dirs = root.getFiles(function (f) { return f instanceof Folder; });
      var fallback = null;
      for (var d = 0; d < dirs.length; d++) {
        var isWave = /57415645/i.test(dirs[d].name); // "WAVE" in hex
        var eprs = dirs[d].getFiles('*.epr');
        for (var e = 0; e < eprs.length; e++) {
          var nm = decodeURI(eprs[e].name);
          if (isWave && /48/.test(nm)) return omni_json({ path: eprs[e].fsName });
          if (isWave && !fallback) fallback = eprs[e].fsName;
          if (!fallback && /wav|waveform/i.test(nm)) fallback = eprs[e].fsName;
        }
      }
      if (fallback) return omni_json({ path: fallback });
    }
    return omni_json({ path: '' });
  } catch (e) { return omni_err(e.toString()); }
}

/* Render the whole active sequence's mix to outPath with the given audio preset. */
function omni_exportAudio(outPath, presetPath) {
  try {
    var seq = app.project.activeSequence;
    if (!seq) return omni_err('No active sequence.');
    if (!new File(presetPath).exists) return omni_err('Export preset not found: ' + presetPath);
    var old = new File(outPath);
    if (old.exists) old.remove();
    seq.exportAsMediaDirect(outPath, presetPath, 0);
    var f = new File(outPath);
    if (!f.exists) return omni_err('Audio export did not produce a file. Check the preset is an audio (WAV/MP3) preset.');
    return omni_json({ path: f.fsName, bytes: f.length });
  } catch (e) { return omni_err(e.toString()); }
}

function omni_findItemByPath(item, fsPath) {
  var want = String(fsPath).replace(/\\/g, '/').toLowerCase();
  for (var i = 0; i < item.children.numItems; i++) {
    var ch = item.children[i];
    if (ch.type === ProjectItemType.BIN) {
      var hit = omni_findItemByPath(ch, fsPath);
      if (hit) return hit;
    } else {
      var p = '';
      try { p = ch.getMediaPath(); } catch (e) {}
      if (p && String(p).replace(/\\/g, '/').toLowerCase() === want) return ch;
    }
  }
  return null;
}

/* Import the .srt and lay it on the active sequence as a new caption track from 0. */
function omni_importCaptions(srtPath) {
  try {
    var seq = app.project.activeSequence;
    if (!seq) return omni_err('No active sequence.');
    var f = new File(srtPath);
    if (!f.exists) return omni_err('SRT not found: ' + srtPath);

    var item = omni_findItemByPath(app.project.rootItem, f.fsName);
    if (!item) {
      app.project.importFiles([f.fsName], true, app.project.getInsertionBin(), false);
      item = omni_findItemByPath(app.project.rootItem, f.fsName);
    }
    if (!item) return omni_err('Premiere did not import the SRT.');

    var ok = seq.createCaptionTrack(item, 0, Sequence.CAPTION_FORMAT_SUBTITLE);
    if (ok === false) return omni_err('createCaptionTrack failed.');
    return omni_json({ ok: true, item: item.name });
  } catch (e) { return omni_err(e.toString()); }
}

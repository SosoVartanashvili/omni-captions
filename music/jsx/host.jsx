/*
 * Soso Music — Premiere Pro side (ExtendScript, ES3).
 * Everything returns a JSON string; errors come back as {"error": "..."}.
 */

var SM_TPS = 254016000000; // Premiere ticks per second

function sm_q(s) {
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

function sm_json(v) {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'number') return isFinite(v) ? String(v) : 'null';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'string') return sm_q(v);
  if (v instanceof Array) {
    var a = [];
    for (var i = 0; i < v.length; i++) a.push(sm_json(v[i]));
    return '[' + a.join(',') + ']';
  }
  var parts = [];
  for (var k in v) if (v.hasOwnProperty(k)) parts.push(sm_q(k) + ':' + sm_json(v[k]));
  return '{' + parts.join(',') + '}';
}

function sm_err(msg) { return sm_json({ error: String(msg) }); }

function sm_num(x) { var n = parseFloat(x); return isFinite(n) ? n : 0; }

/* Facts about the active sequence: full length, In/Out (if set), playhead, frame. */
function sm_seqInfo() {
  try {
    if (!app.project) return sm_err('No project open.');
    var seq = app.project.activeSequence;
    if (!seq) return sm_err('No active sequence. Click into the timeline first.');
    var end = Number(seq.end) / SM_TPS;
    var inP = 0, outP = 0;
    try { inP = sm_num(seq.getInPoint()); } catch (e1) {}
    try { outP = sm_num(seq.getOutPoint()); } catch (e2) {}
    var hasInOut = outP > inP + 0.05 && (inP > 0.001 || outP < end - 0.05);
    var projPath = '';
    try { projPath = app.project.path || ''; } catch (e3) {}
    return sm_json({
      name: seq.name, id: seq.sequenceID, end: end, frame: Number(seq.timebase) / SM_TPS,
      inPoint: inP, outPoint: outP, hasInOut: hasInOut,
      audioTracks: seq.audioTracks.numTracks, projectPath: projPath
    });
  } catch (e) { return sm_err(e.toString()); }
}

function sm_findItemByPath(item, fsPath) {
  var want = String(fsPath).replace(/\\/g, '/').toLowerCase();
  for (var i = 0; i < item.children.numItems; i++) {
    var ch = item.children[i];
    if (ch.type === ProjectItemType.BIN) {
      var hit = sm_findItemByPath(ch, fsPath);
      if (hit) return hit;
    } else {
      var p = '';
      try { p = ch.getMediaPath(); } catch (e) {}
      if (p && String(p).replace(/\\/g, '/').toLowerCase() === want) return ch;
    }
  }
  return null;
}

function sm_getBin(name) {
  var root = app.project.rootItem;
  for (var i = 0; i < root.children.numItems; i++) {
    var ch = root.children[i];
    if (ch.type === ProjectItemType.BIN && ch.name === name) return ch;
  }
  try { return root.createBin(name); } catch (e) { return root; }
}

function sm_trackFree(track, a, b) {
  if (track.isLocked && track.isLocked()) return false;
  for (var c = 0; c < track.clips.numItems; c++) {
    var cl = track.clips[c];
    if (cl.start.seconds < b - 0.01 && cl.end.seconds > a + 0.01) return false;
  }
  return true;
}

/* Premiere's Volume "Level" stores a linear gain where 0 dB = 10^(-15/20). */
function sm_setVolume(trackItem, dB) {
  try {
    for (var i = 0; i < trackItem.components.numItems; i++) {
      var comp = trackItem.components[i];
      if (!/^(Volume|Lautst|Volumen)/i.test(String(comp.displayName))) continue;
      for (var p = 0; p < comp.properties.numItems; p++) {
        var prop = comp.properties[p];
        if (/level|pegel|nivel|niveau|livello/i.test(String(prop.displayName))) {
          prop.setValue(Math.pow(10, (dB - 15) / 20), true);
          return true;
        }
      }
    }
  } catch (e) {}
  return false;
}

/*
 * Import the music file and lay it on the first audio track that is empty between start and end.
 * If every track is busy, one new audio track is added. Returns the track it landed on.
 */
function sm_placeMusic(filePath, startStr, endStr, dbStr) {
  try {
    var seq = app.project.activeSequence;
    if (!seq) return sm_err('No active sequence.');
    var f = new File(filePath);
    if (!f.exists) return sm_err('Music file not found: ' + filePath);
    var start = sm_num(startStr), end = sm_num(endStr), dB = parseFloat(dbStr);

    var item = sm_findItemByPath(app.project.rootItem, f.fsName);
    if (!item) {
      app.project.importFiles([f.fsName], true, sm_getBin('Soso Music'), false);
      item = sm_findItemByPath(app.project.rootItem, f.fsName);
    }
    if (!item) return sm_err('Premiere did not import the music file.');

    var idx = -1, t;
    for (t = 0; t < seq.audioTracks.numTracks; t++) if (sm_trackFree(seq.audioTracks[t], start, end)) { idx = t; break; }
    if (idx < 0) {
      var before = seq.audioTracks.numTracks;
      try { app.enableQE(); qe.project.getActiveSequence().addTracks(0, 0, 1, 1, before, 0, 0); } catch (eq) {}
      seq = app.project.activeSequence;
      if (seq.audioTracks.numTracks > before) idx = seq.audioTracks.numTracks - 1;
    }
    if (idx < 0) return sm_json({ placed: false, item: item.name });

    var track = seq.audioTracks[idx];
    track.overwriteClip(item, start);

    // find what we just placed: trim it to the range and set its level
    var placed = null;
    for (var c = 0; c < track.clips.numItems; c++) {
      var cl = track.clips[c];
      if (Math.abs(cl.start.seconds - start) < 0.05) { placed = cl; break; }
    }
    var trimmed = false, vol = false;
    if (placed) {
      if (placed.end.seconds > end + 0.02) {
        try { var tm = new Time(); tm.seconds = end; placed.end = tm; trimmed = true; } catch (et) {}
      }
      if (isFinite(dB)) vol = sm_setVolume(placed, dB);
    }
    return sm_json({ placed: true, track: 'A' + (idx + 1), item: item.name, trimmed: trimmed, volume: vol });
  } catch (e) { return sm_err(e.toString()); }
}

/* Find a small H.264 video export preset that ships with Premiere (for Video to Music). */
function sm_findVideoPreset() {
  try {
    var base = String(app.path).replace(/[\\\/]+$/, '');
    var roots = [base + '/MediaIO/systempresets', base + '/Contents/MediaIO/systempresets',
                 base + '/../MediaIO/systempresets', base + '/../../MediaIO/systempresets'];
    var best = null, bestScore = -1;
    for (var r = 0; r < roots.length; r++) {
      var root = new Folder(roots[r]);
      if (!root.exists) continue;
      var dirs = root.getFiles(function (f) { return f instanceof Folder; });
      for (var d = 0; d < dirs.length; d++) {
        var isH264 = /48323634/i.test(dirs[d].name);          // "H264" in hex
        var eprs = dirs[d].getFiles('*.epr');
        for (var e = 0; e < eprs.length; e++) {
          var nm = decodeURI(eprs[e].name);
          if (/wav|aiff|mp3|aac only|prores|dnx|cineform|dpx|tiff|png|jpeg|gif|openexr|quicktime|animated|audio only/i.test(nm)) continue;
          var sc = 0;
          if (/adaptive low/i.test(nm)) sc += 10;
          else if (/low/i.test(nm)) sc += 6;
          else if (/480|540/i.test(nm)) sc += 7;
          else if (/medium/i.test(nm)) sc += 4;
          else if (/match source/i.test(nm)) sc += 2;
          else if (/720/i.test(nm)) sc += 3;
          if (isH264) sc += 5;
          if (/h\.?264|mp4/i.test(nm)) sc += 3;
          if (sc > bestScore) { bestScore = sc; best = eprs[e].fsName; }
        }
      }
      if (best && bestScore >= 7) break;
    }
    return sm_json({ path: bestScore >= 5 ? best : '' });
  } catch (e) { return sm_err(e.toString()); }
}

/* Render the active sequence's video (whole, or In→Out) to outPath. */
function sm_exportVideo(outPath, presetPath, inOutStr) {
  try {
    var seq = app.project.activeSequence;
    if (!seq) return sm_err('No active sequence.');
    if (!new File(presetPath).exists) return sm_err('Video export preset not found: ' + presetPath);
    var old = new File(outPath);
    if (old.exists) old.remove();
    seq.exportAsMediaDirect(outPath, presetPath, inOutStr === '1' ? 1 : 0);
    var f = new File(outPath);
    if (!f.exists) return sm_err('Video export did not produce a file. Pick a video (H.264 / MP4) preset in Settings.');
    return sm_json({ path: f.fsName, bytes: f.length });
  } catch (e) { return sm_err(e.toString()); }
}

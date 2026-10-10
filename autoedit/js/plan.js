/*
 * Soso Auto Edit — the planner (pure logic, no Premiere, no files).
 *
 *   project notes (PROJECT_NNN.md timing table)  ─┐
 *   clip file names (Videos/NNN_scXX.mp4, hooks)  ─┼─> plan: which clip goes where, which part of it
 *   lyric timing (ElevenLabs alignment, optional) ─┤
 *   beat grid + clip motion analysis              ─┘
 *
 * Rules (from his own edits):
 *   - scene N starts where its lyric line starts, cut snapped to the nearest half-beat;
 *   - a frozen first moment of a clip is trimmed (only if the clip is long enough);
 *   - a clip never shows a few frames of a shot right before/after its own internal cut (flash);
 *   - anything that cannot be solved gets a red marker, never a silent guess.
 */
(function (root) {
  'use strict';

  /* ---------- project notes ---------- */
  // "12.5", "0:12.50", "1:02.3" -> seconds
  function parseTime(v) {
    var t = String(v || '').replace(/s$/i, '').trim(), m = /^(\d+):(\d{1,2}(?:\.\d+)?)$/.exec(t);
    return m ? parseInt(m[1], 10) * 60 + parseFloat(m[2]) : parseFloat(t);
  }
  function parseProjectMd(text) {
    var out = { lines: [], bpm: 0, firstBeat: null, songName: '', duration: 0 };
    var rows = String(text || '').replace(/\r/g, '').split('\n');
    var inTable = false, cols = null, done = false;
    for (var i = 0; i < rows.length && !done; i++) {
      var r = rows[i].trim();
      if (/^\|/.test(r)) {
        var cells = r.replace(/^\||\|$/g, '').split('|').map(function (c) { return c.trim(); });
        var low = cells.map(function (c) { return c.toLowerCase(); });
        if (!inTable && low.indexOf('start') >= 0 && low.some(function (c) { return /^(line|lyric|lyrics|text)$/.test(c); })) {
          cols = { n: 0, start: low.indexOf('start'), end: low.indexOf('end'),
                   text: low.findIndex(function (c) { return /^(line|lyric|lyrics|text)$/.test(c); }) };
          inTable = true; continue;
        }
        if (inTable && cols) {
          if (/^-+$/.test(cells[0].replace(/[:\s]/g, ''))) continue;
          var n = parseInt(cells[cols.n], 10), st = parseTime(cells[cols.start]);
          if (isFinite(n) && isFinite(st)) {
            out.lines.push({ n: n, start: st, end: cols.end >= 0 ? parseTime(cells[cols.end]) : NaN,
                             text: (cells[cols.text] || '').replace(/^["“]|["”]$/g, '') });
            continue;
          }
        }
      } else if (inTable && out.lines.length) { inTable = false; done = true; }   // first edit table only
    }
    var m = /BPM\s*[:=]\s*([\d.]+)/i.exec(text) || /([\d.]+)\s*BPM/i.exec(text); if (m) out.bpm = parseFloat(m[1]);
    m = /first beat\s*(?:at\s*)?[:=]?\s*([\d:.]+)\s*s?/i.exec(text); if (m) out.firstBeat = parseTime(m[1]);
    m = /Track:\s*`?([^\n`·|—]+?\.(?:mp3|wav|m4a|aac|aif|aiff))/i.exec(text); if (m) out.songName = m[1].trim();
    m = /DURATION\s*[:=]\s*([\d:.]+)/i.exec(text); if (m) out.duration = parseTime(m[1]);
    return out;
  }

  /* ---------- clip files ---------- */
  var VIDEO = /\.(mp4|mov|m4v)$/i;
  function sceneOf(name) {
    var base = name.replace(/\.[^.]+$/, '');
    var alt = /^(.*?\d)[\-_ ]([A-Z])$/.exec(base);            // "#1-A" / "#1-B" = alternates while he chooses
    if (alt) { var a = sceneOf(alt[1] + '.x'); return a ? { n: a.n, sub: a.sub, alt: alt[2] } : null; }
    var m = /(?:^|[_\-\s])(?:sc|scene)[_\-\s]?0*(\d{1,3})([a-z])?(?![0-9])/i.exec(base) ||
            /#0*(\d{1,3})([a-z])?(?![0-9])/.exec(base) ||
            /^0*(\d{1,3})([a-z])?$/i.exec(base);
    return m ? { n: parseInt(m[1], 10), sub: (m[2] || '').toLowerCase() } : null;
  }
  function scanClips(names) {
    var scenes = {}, hooks = [], skipped = [], alternates = {};
    names.forEach(function (f) {
      if (!VIDEO.test(f)) return;
      var h = /hook[_\-\s]?([A-Za-z0-9]+)/i.exec(f.replace(/\.[^.]+$/, ''));
      if (h) { hooks.push({ name: h[1].toUpperCase(), file: f }); return; }
      var s = sceneOf(f);
      if (!s) { skipped.push(f); return; }
      if (s.alt) { (alternates[s.n] = alternates[s.n] || []).push(f); return; }
      (scenes[s.n] = scenes[s.n] || []).push({ file: f, sub: s.sub });
    });
    Object.keys(scenes).forEach(function (k) { scenes[k].sort(function (a, b) { return a.sub < b.sub ? -1 : a.sub > b.sub ? 1 : 0; }); });
    hooks.sort(function (a, b) { return a.name < b.name ? -1 : 1; });
    // a scene that only exists as alternates uses the first one (and the edit gets a marker)
    Object.keys(alternates).forEach(function (n) {
      alternates[n].sort();
      if (!scenes[n]) scenes[n] = [{ file: alternates[n][0], sub: '', alternates: alternates[n] }];
    });
    return { scenes: scenes, hooks: hooks, skipped: skipped, alternates: alternates };
  }

  /* ---------- lyric timing from an ElevenLabs forced alignment ---------- */
  function norm(w) { return String(w).toLowerCase().replace(/[’']/g, '').replace(/[^a-z0-9%$]/g, ''); }
  // words: [{text,start,end}] for the lines joined with "\n". Returns starts[] (or null where unsure)
  function lineStartsFromAlignment(lines, words) {
    var aw = (words || []).filter(function (w) { return norm(w.text); });
    var tokens = lines.map(function (l) { return String(l.text).split(/\s+/).map(norm).filter(Boolean); });
    var total = tokens.reduce(function (a, t) { return a + t.length; }, 0);
    if (!aw.length || Math.abs(aw.length - total) > Math.max(3, total * 0.1)) return lines.map(function () { return null; });
    var starts = [], j = 0;
    tokens.forEach(function (t) {
      // find this line's first token at or near j
      var hit = null;
      for (var k = j; k < Math.min(aw.length, j + 4); k++) if (norm(aw[k].text) === t[0]) { hit = k; break; }
      if (hit === null) hit = Math.min(j, aw.length - 1);
      starts.push(aw[hit] ? +aw[hit].start : null);
      j = hit + t.length;
    });
    return starts;
  }

  /* ---------- beat grid ---------- */
  function snapper(bpm, firstBeat, tol) {
    if (!(bpm > 0) || firstBeat === null || !isFinite(firstBeat)) return function (t) { return t; };
    var hb = 30 / bpm;
    return function (t) {
      var k = Math.round((t - firstBeat) / hb), g = firstBeat + k * hb;
      return Math.abs(g - t) <= tol ? g : t;
    };
  }

  /* ---------- clip motion analysis (motion[i] = mean |frame i+1 - frame i|, sampled at fps) ---------- */
  function median(a) { var b = Array.prototype.slice.call(a).sort(function (x, y) { return x - y; }); return b.length ? b[b.length >> 1] : 0; }
  function analyzeMotion(motion, fps) {
    var med = median(motion), cuts = [], frozen = [];
    var cutTh = Math.max(14, 5 * med);
    for (var i = 0; i < motion.length; i++) {
      if (motion[i] > cutTh && (i === 0 || motion[i] > 2.5 * motion[i - 1])) cuts.push((i + 1) / fps);
    }
    // merge bursts (glitchy transitions) into their first cut
    cuts = cuts.filter(function (c, k) { return k === 0 || c - cuts[k - 1] > 0.2; });
    var still = Math.max(0.25 * med, 0.6), dead = 0;
    for (var s = 0; s < motion.length - 2; s++) {
      if (Math.min(motion[s], motion[s + 1], motion[s + 2]) >= still) { dead = s / fps; break; }
      dead = (s + 1) / fps;
    }
    dead = Math.min(dead, 1.0);
    var run = 0, from = 0, frz = Math.max(0.12 * med, 0.35);
    for (var f = 0; f <= motion.length; f++) {
      if (f < motion.length && motion[f] < frz) { if (!run) from = f; run++; }
      else { if (run / fps >= 0.6) frozen.push([from / fps, (from + run) / fps]); run = 0; }
    }
    return { median: med, deadStart: dead, cuts: cuts, frozen: frozen };
  }

  /* ---------- choose the part of a clip for a slot ---------- */
  var FLASH = 0.3;
  function fitClip(slotLen, clip, opts) {
    var dur = clip.dur, a = clip.analysis || { deadStart: 0, cuts: [], frozen: [] };
    var warn = [], spare = dur - slotLen;
    var inT = opts.trimFrozen ? Math.min(a.deadStart, Math.max(0, spare)) : 0;
    // a cut a few frames after the in point -> start on the cut instead
    a.cuts.forEach(function (c) { if (c - inT > 0 && c - inT < FLASH && c <= spare + 1e-6) inT = c; });
    // a cut a few frames before the out point -> pull the whole window earlier so we end on the cut
    a.cuts.forEach(function (c) {
      var out = inT + slotLen;
      if (out - c > 0 && out - c < FLASH) {
        if (inT - (out - c) >= 0) inT = inT - (out - c);                       // end exactly on the cut
        else if (c + FLASH - slotLen <= spare + 1e-6) inT = c + FLASH - slotLen;  // or show enough of the new shot
        else warn.push('ends ' + Math.round((out - c) * 24) + ' frames after an internal cut');
      }
    });
    if (inT + slotLen > dur) {
      inT = Math.max(0, dur - slotLen);
      if (dur < slotLen - 0.02) warn.push('clip is ' + (slotLen - dur).toFixed(2) + ' s too short for its line');
    }
    var outT = Math.min(dur, inT + slotLen);
    a.frozen.forEach(function (z) {
      var o0 = Math.max(z[0], inT), o1 = Math.min(z[1], outT);
      if (o1 - o0 >= 0.6) warn.push('frozen for ' + (o1 - o0).toFixed(1) + ' s');
    });
    return { srcIn: inT, srcOut: outT, warnings: warn };
  }

  /*
   * Build the edit plan.
   *  lines: [{n,start,end,text}], clips: {sceneN: [{file,dur,analysis}]}, songDur
   *  opts: { lineStarts (aligned, may hold nulls), bpm, firstBeat, snap (bool), snapTol, offset, trimFrozen, fps, hookFile }
   */
  function buildPlan(lines, clips, songDur, opts) {
    opts = opts || {};
    var fps = opts.fps || 24, frame = function (t) { return Math.round(t * fps) / fps; };
    var snap = opts.snap ? snapper(opts.bpm, opts.firstBeat, opts.snapTol || 0.2) : function (t) { return t; };
    var aligned = opts.lineStarts || [];
    var sorted = lines.slice().sort(function (a, b) { return a.n - b.n; });
    var starts = sorted.map(function (l, i) {
      var a = aligned[i];
      var t = (a !== null && a !== undefined && Math.abs(a - l.start) <= 1.0) ? a : l.start;
      return i === 0 ? 0 : frame(snap(t + (opts.offset || 0)));
    });
    var items = [], markers = [];
    sorted.forEach(function (l, i) {
      var s = starts[i], e = i + 1 < sorted.length ? starts[i + 1] : frame(songDur || (l.end || s + 3));
      var list = clips[l.n] ? clips[l.n].slice() : [];
      if (i === 0 && opts.hookFile) list = [opts.hookFile];
      if (!list.length) { markers.push({ t: s, color: 'red', text: 'Scene ' + l.n + ': no clip in the folder' }); return; }
      if (list[0].alternates && i > 0) markers.push({ t: s, color: 'yellow', text: 'Scene ' + l.n + ': alternates ' + list[0].alternates.join(' / ') + ' — used ' + list[0].file + ', pick one' });
      var parts = list.length, t0 = s;
      list.forEach(function (c, k) {
        var t1 = k === parts - 1 ? e : frame(snap(s + (e - s) * (k + 1) / parts));
        var fit = fitClip(t1 - t0, c, opts);
        items.push({ scene: l.n, file: c.file, start: t0, end: t1, srcIn: frame(fit.srcIn), srcOut: frame(fit.srcIn) + (t1 - t0), line: l.text });
        fit.warnings.forEach(function (w) { markers.push({ t: t0, color: 'red', text: 'Scene ' + l.n + ' (' + c.file + '): ' + w }); });
        t0 = t1;
      });
    });
    return { items: items, markers: markers, starts: starts };
  }

  var api = { parseProjectMd: parseProjectMd, parseTime: parseTime, scanClips: scanClips, sceneOf: sceneOf, lineStartsFromAlignment: lineStartsFromAlignment,
              snapper: snapper, analyzeMotion: analyzeMotion, fitClip: fitClip, buildPlan: buildPlan };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.SosoPlan = api;
})(typeof window !== 'undefined' ? window : this);

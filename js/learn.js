/*
 * OMNI Captions — brand rules + learned fixes.
 *
 *  - Brand rules are always applied:  omni -> OMNI,  omni creatine gummies -> OMNI Creatine Gummies, ...
 *  - Learned fixes come from the editor's corrections (an exported, corrected .srt compared with the
 *    .srt the panel made) or are typed in by hand. They live in one rules file; put it in a synced
 *    folder (Google Drive / Dropbox) and every editor's panel learns from everyone's corrections.
 */
(function (root) {
  'use strict';

  // longest first; matched case-insensitively on whole words, punctuation kept
  var BRAND = [
    ['omni creatine gummies', 'OMNI Creatine Gummies'],
    ['omni creatine gummy', 'OMNI Creatine Gummy'],
    ['omni electrolytes', 'OMNI Electrolytes'],
    ['omni', 'OMNI']
  ];

  var MAXN = 4; // longest phrase (in words) a fix can cover

  function core(t) { return String(t).toLowerCase().replace(/^[^a-z0-9']+|[^a-z0-9']+$/gi, ''); }
  function splitPunct(t) {
    var m = String(t).match(/^([^A-Za-z0-9']*)(.*?)([^A-Za-z0-9']*)$/);
    return m ? { pre: m[1], body: m[2], post: m[3] } : { pre: '', body: t, post: '' };
  }

  // fixes: { "wrong phrase": "Right Phrase" }  (keys lower-case, no punctuation)
  // learned fixes first, then the brand rules on top (so "omni creating gummies" -> fix -> brand casing)
  function applyFixes(words, fixes) {
    var learned = {}, brand = {};
    Object.keys(fixes || {}).forEach(function (k) { var to = fixes[k]; learned[k] = (to && to.to !== undefined) ? to.to : to; });
    BRAND.forEach(function (b) { brand[b[0]] = b[1]; });
    return applyTable(applyTable(words, learned), brand);
  }

  function applyTable(words, table) {
    var keysByLen = {};
    Object.keys(table).forEach(function (k) {
      var n = k.split(' ').length; if (n > MAXN) return;
      (keysByLen[n] = keysByLen[n] || {})[k] = table[k];
    });

    var out = [], i = 0;
    while (i < words.length) {
      var hit = null;
      for (var n = Math.min(MAXN, words.length - i); n >= 1 && !hit; n--) {
        if (!keysByLen[n]) continue;
        var seg = words.slice(i, i + n);
        // a phrase may not run across a sentence end inside it
        var bad = false;
        for (var q = 0; q < n - 1; q++) if (/[.!?]$/.test(seg[q].text)) bad = true;
        if (bad) continue;
        var key = seg.map(function (w) { return core(w.text); }).join(' ');
        if (keysByLen[n][key] !== undefined) hit = { n: n, to: keysByLen[n][key], seg: seg };
      }
      if (!hit) { out.push(words[i]); i++; continue; }
      var first = splitPunct(hit.seg[0].text), last = splitPunct(hit.seg[hit.n - 1].text);
      var toks = String(hit.to).split(/\s+/).filter(Boolean);
      if (!toks.length) { i += hit.n; continue; }              // a fix to "" deletes the phrase
      var s0 = hit.seg[0].start, e0 = hit.seg[hit.n - 1].end, step = (e0 - s0) / toks.length;
      toks.forEach(function (t, k) {
        var txt = t;
        if (k === 0) txt = first.pre + txt;
        if (k === toks.length - 1 && !/[.,!?;:]$/.test(txt)) txt = txt + last.post;
        out.push({ text: txt, start: s0 + k * step, end: s0 + (k + 1) * step, type: 'word' });
      });
      i += hit.n;
    }
    return out;
  }

  /* ---- learning: compare what the panel wrote with what the editor corrected ---- */

  function srtWords(srt) {
    return String(srt).replace(/\r/g, '').split(/\n\s*\n/).map(function (block) {
      var lines = block.split('\n').filter(function (l) { return l.trim(); });
      var i = lines.findIndex(function (l) { return /-->/.test(l); });
      return i < 0 ? '' : lines.slice(i + 1).join(' ');
    }).join(' ').replace(/<[^>]+>/g, ' ').split(/\s+/).filter(Boolean);
  }

  // word-level LCS diff -> list of {a:[...], b:[...]} replaced blocks
  function diffBlocks(a, b) {
    var A = a.map(core), B = b.map(core), n = A.length, m = B.length;
    var L = []; for (var i = 0; i <= n; i++) { L.push(new Int32Array(m + 1)); }
    for (i = n - 1; i >= 0; i--) for (var j = m - 1; j >= 0; j--)
      L[i][j] = (A[i] === B[j] && a[i] === b[j]) ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
    var blocks = [], ca = [], cb = []; i = 0; j = 0;
    function flush() { if (ca.length || cb.length) blocks.push({ a: ca, b: cb }); ca = []; cb = []; }
    while (i < n && j < m) {
      if (A[i] === B[j] && a[i] === b[j]) { flush(); i++; j++; }
      else if (L[i + 1][j] >= L[i][j + 1]) ca.push(a[i++]);
      else cb.push(b[j++]);
    }
    while (i < n) ca.push(a[i++]);
    while (j < m) cb.push(b[j++]);
    flush();
    return blocks;
  }

  // returns { "wrong": "Right" } learned from the two .srt texts
  function learn(autoSrt, fixedSrt) {
    var blocks = diffBlocks(srtWords(autoSrt), srtWords(fixedSrt)), found = {};
    blocks.forEach(function (bl) {
      if (!bl.a.length || !bl.b.length) return;                     // pure insert / delete: not a word fix
      if (bl.a.length > MAXN || bl.b.length > MAXN) return;          // a rewrite, not a fix
      var from = bl.a.map(core).join(' ');
      var to = bl.b.map(function (t) { return splitPunct(t).body; }).join(' ');
      if (!from || !to) return;
      if (from === to.toLowerCase() && bl.a.map(function (t) { return splitPunct(t).body; }).join(' ') === to) return; // punctuation only
      found[from] = to;
    });
    return found;
  }

  /* ---- the rules file ---- */
  function parseFixText(text) {
    var out = {};
    String(text).split(/\r?\n/).forEach(function (line) {
      var m = line.split(/\s*(?:=>|->|→)\s*/);
      if (m.length !== 2) return;
      var k = m[0].trim().split(/\s+/).map(core).join(' ');
      if (k) out[k] = m[1].trim();
    });
    return out;
  }
  function fixText(fixes) {
    return Object.keys(fixes).sort().map(function (k) {
      var v = fixes[k]; return k + ' => ' + ((v && v.to !== undefined) ? v.to : v);
    }).join('\n');
  }

  var api = { applyFixes: applyFixes, learn: learn, parseFixText: parseFixText, fixText: fixText, BRAND: BRAND, _diff: diffBlocks, _srtWords: srtWords };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.OmniLearn = api;
})(typeof window !== 'undefined' ? window : this);

/*
 * OMNI Captions — script sync.
 *
 * ElevenLabs hears the audio and gives every word a time. The script has the right words.
 * This lines the two up word by word and keeps the best of both:
 *
 *   heard == script                     -> script spelling + punctuation, ElevenLabs timing
 *   heard ≈ script (a mis-hearing)      -> script words, spread over the heard words' time
 *   said in the video, not in script    -> kept as heard (an ad-lib, a changed line)
 *   in the script, never said           -> dropped (a cut line, a hook variant, a note)
 *
 * So a whole Notion page can be pasted — labels, notes and unused hooks simply never match.
 */
(function (root) {
  'use strict';

  var NUM = {
    zero: '0', one: '1', two: '2', three: '3', four: '4', five: '5', six: '6', seven: '7', eight: '8',
    nine: '9', ten: '10', eleven: '11', twelve: '12', thirteen: '13', fourteen: '14', fifteen: '15',
    sixteen: '16', seventeen: '17', eighteen: '18', nineteen: '19', twenty: '20', thirty: '30',
    forty: '40', fifty: '50', sixty: '60', seventy: '70', eighty: '80', ninety: '90', hundred: '100'
  };

  function core(t) {
    var c = String(t).toLowerCase().replace(/[’‘`]/g, "'").replace(/[^a-z0-9'%$]/g, '').replace(/^'+|'+$/g, '');
    return NUM[c] || c;
  }

  function scriptTokens(text) {
    return String(text).replace(/\r/g, '').split(/\s+/)
      .filter(function (t) { return /[A-Za-z0-9]/.test(t); })
      .map(function (t) { return { text: t, c: core(t) }; });
  }

  // character-level similarity 0..1 (Dice on bigrams; cheap and good for mis-hearings)
  function sim(a, b) {
    if (a === b) return 1;
    if (a.length < 2 || b.length < 2) return 0;
    var bg = {}, i, n = 0;
    for (i = 0; i < a.length - 1; i++) { var x = a.substr(i, 2); bg[x] = (bg[x] || 0) + 1; }
    for (i = 0; i < b.length - 1; i++) { var y = b.substr(i, 2); if (bg[y] > 0) { bg[y]--; n++; } }
    return 2 * n / (a.length + b.length - 2);
  }

  // global alignment (Needleman–Wunsch). returns pairs [i|-1, j|-1]
  function align(S, H) {
    var n = S.length, m = H.length, GAP = -1;
    var D = new Array(n + 1), P = new Array(n + 1), i, j;
    for (i = 0; i <= n; i++) { D[i] = new Float32Array(m + 1); P[i] = new Uint8Array(m + 1); }
    for (i = 1; i <= n; i++) { D[i][0] = i * GAP; P[i][0] = 1; }
    for (j = 1; j <= m; j++) { D[0][j] = j * GAP; P[0][j] = 2; }
    for (i = 1; i <= n; i++) {
      for (j = 1; j <= m; j++) {
        var a = S[i - 1].c, b = H[j - 1].c;
        var sc = a === b ? 2 : (sim(a, b) >= 0.6 ? 0.5 : -1);
        var d = D[i - 1][j - 1] + sc, u = D[i - 1][j] + GAP, l = D[i][j - 1] + GAP;
        if (d >= u && d >= l) { D[i][j] = d; P[i][j] = 0; }
        else if (u >= l) { D[i][j] = u; P[i][j] = 1; }
        else { D[i][j] = l; P[i][j] = 2; }
      }
    }
    var out = []; i = n; j = m;
    while (i > 0 || j > 0) {
      var p = P[i][j];
      if (i > 0 && j > 0 && p === 0) { out.push([i - 1, j - 1]); i--; j--; }
      else if (i > 0 && (j === 0 || p === 1)) { out.push([i - 1, -1]); i--; }
      else { out.push([-1, j - 1]); j--; }
    }
    return out.reverse();
  }

  function spread(scriptToks, start, end) {
    var total = 0;
    scriptToks.forEach(function (t) { total += t.text.length + 1; });
    var t0 = start, out = [];
    scriptToks.forEach(function (t) {
      var d = (end - start) * (t.text.length + 1) / Math.max(1, total);
      out.push({ text: t.text, start: t0, end: t0 + d, type: 'word', from: 'script' });
      t0 += d;
    });
    return out;
  }

  /*
   * heardWords: ElevenLabs words [{text,start,end,type}]   scriptText: the script as pasted
   * returns { words, stats: { matched, fixed, keptHeard, droppedScript } }
   */
  function merge(heardWords, scriptText) {
    var H = (heardWords || []).filter(function (w) { return (!w.type || w.type === 'word') && String(w.text || '').trim(); })
      .map(function (w) { return { text: String(w.text).trim(), start: +w.start, end: +w.end, c: core(w.text) }; });
    var S = scriptTokens(scriptText);
    var stats = { matched: 0, fixed: 0, keptHeard: 0, droppedScript: 0 };
    if (!S.length) return { words: H.map(strip), stats: stats };
    if (!H.length) return { words: [], stats: stats };

    var pairs = align(S, H), out = [], bs = [], bh = [];

    function flush() {
      if (!bs.length && !bh.length) return;
      if (!bh.length) { stats.droppedScript += bs.length; }
      else if (!bs.length) { bh.forEach(function (h) { out.push(strip(h)); }); stats.keptHeard += bh.length; }
      else {
        var js = bs.map(function (t) { return t.c; }).join(' '), jh = bh.map(function (t) { return t.c; }).join(' ');
        var ratio = Math.max(bs.length, bh.length) / Math.min(bs.length, bh.length);
        if (sim(js, jh) >= 0.45 || (ratio <= 1.5 && bs.length <= 3)) {
          spread(bs, bh[0].start, bh[bh.length - 1].end).forEach(function (w) { out.push(w); });
          stats.fixed += bh.length;
        } else {
          bh.forEach(function (h) { out.push(strip(h)); });
          stats.keptHeard += bh.length; stats.droppedScript += bs.length;
        }
      }
      bs = []; bh = [];
    }

    pairs.forEach(function (p) {
      var s = p[0] >= 0 ? S[p[0]] : null, h = p[1] >= 0 ? H[p[1]] : null;
      if (s && h && s.c === h.c) {
        flush();
        out.push({ text: s.text, start: h.start, end: h.end, type: 'word', from: 'script' });
        stats.matched++;
      } else {
        if (s) bs.push(s);
        if (h) bh.push(h);
      }
    });
    flush();
    return { words: out, stats: stats };
  }

  function strip(h) { return { text: h.text, start: h.start, end: h.end, type: 'word', from: 'heard' }; }

  var api = { merge: merge, _core: core, _sim: sim };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.OmniSync = api;
})(typeof window !== 'undefined' ? window : this);

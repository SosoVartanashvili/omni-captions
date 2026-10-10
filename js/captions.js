/*
 * OMNI Captions — the caption engine.
 * Pure logic, no Premiere and no network: words + cut times in, captions out.
 *
 * Rules, in priority order:
 *   1. A caption NEVER spans a cut. Its start and end stay inside one shot.
 *   2. A sentence end (. ! ? …) always ends a caption. A pause longer than gapBreak does too.
 *   3. A caption is never wider than maxChars per line / maxLines lines, never longer than maxDur.
 *      When a phrase has to be split, it is split at the most natural point:
 *      after a comma, before a conjunction, at a pause, balanced — never after "the", "a", "to"...
 *   4. A short word left alone at the very end of a shot (the sentence carries on after the cut)
 *      moves into the next shot's caption, so nothing flashes for 5 frames.
 *   5. Timing is snapped: captions start ON the cut / end ON the cut when they are close to it,
 *      tiny gaps between captions are closed, every caption is on screen at least minDur,
 *      and every time is on the sequence's frame grid.
 */
(function (root) {
  'use strict';

  var DEFAULTS = {
    maxChars: 24,      // per line — must fit the caption box of the style, or Premiere wraps to a 3rd line
    maxLines: 2,       // 1 or 2
    maxDur: 6.0,       // seconds
    minDur: 0.7,       // seconds
    gapBreak: 0.7,     // a pause longer than this always starts a new caption
    linger: 0.15,      // caption stays this long after the last word
    snapIn: 0.25,      // first word within this of the cut -> caption starts on the cut
    snapOut: 0.3,      // caption end within this of the next cut -> it ends on the cut
    closeGap: 0.25,    // gaps shorter than this between captions are closed
    orphanMax: 0.45,   // a lone word shorter than this at a shot's end moves to the next shot
    fillGap: 1.5,      // pauses up to this long are filled: no empty frames between captions (0 = off)
    upper: false,
    stripEndPunct: false,
    noDotsCommas: false  // remove every . , … from the captions (not inside numbers: 4.8, 2,000)
  };

  var SENT_END = /[.!?…]["'”’)\]]*$/;
  var SOFT_END = /[,;:—–]["'”’)\]]*$/;
  var CONJ = toSet('and but so or because cause cuz that when which who whose then if while until after before since like without though although unless where why how');
  var WEAK_AFTER = toSet('a an the to of my your his her our their its this these those i im i\'m in on at for from with by and but or is was are were be been very so as into onto than');

  var ARTICLE = toSet('a an the my your his her our their its this these those every each no');
  // a new caption / line may start well before these (they open a new chunk of meaning)
  var CHUNK_START = toSet('and but so or nor because cause cuz that which who whom whose when where while if then than unless until though although since after before as like ' +
    'to of in on at for from with without by about into onto over under through between during against among across behind beyond near ' +
    'is are was were be been being am can could will would shall should may might must do does did have has had ' +
    'i you he she we they it there here this these those what how why out now today every ' +
    'a an the my your his her our their its some any no');
  // words that belong to the word after them (never end a line / caption on them)
  var GLUE_NEXT = toSet('a an the my your his her our their its this these those some any no every either neither ' +
    'very so too such what which whose more most less fewer like ' +
    'to of in on at for from with by about into onto over under through between as than not just only even also really');

  function toSet(s) { var o = {}; s.split(' ').forEach(function (w) { o[w] = 1; }); return o; }
  function bare(t) { return String(t).toLowerCase().replace(/[^a-z0-9']/g, ''); }

  function merge(opts) {
    var o = {}, k;
    for (k in DEFAULTS) o[k] = DEFAULTS[k];
    for (k in (opts || {})) if (opts[k] !== undefined && opts[k] !== null && opts[k] !== '') o[k] = opts[k];
    o.maxLines = Math.max(1, Math.min(2, parseInt(o.maxLines, 10) || 2));
    return o;
  }

  /* ---------- input normalisation ---------- */

  function normWords(raw) {
    var out = [];
    (raw || []).forEach(function (w) {
      if (w.type && w.type !== 'word') return;           // Scribe: skip "spacing", "audio_event"
      var t = String(w.text || '').replace(/\s+/g, ' ').trim();
      if (!t) return;
      var s = +w.start, e = +w.end;
      if (!(e >= s)) e = s;
      out.push({ text: t, start: s, end: e, eol: !!w.eol });
    });
    out.sort(function (a, b) { return a.start - b.start; });
    return out;
  }

  function normCuts(cuts, frame, seqEnd) {
    var tol = frame * 1.5;
    var c = (cuts || []).map(Number).filter(function (t) { return isFinite(t) && t > tol && t < seqEnd - tol; });
    c.sort(function (a, b) { return a - b; });
    var out = [];
    c.forEach(function (t) {
      t = Math.round(t / frame) * frame;
      if (!out.length || t - out[out.length - 1] > tol) out.push(t);
    });
    return out;
  }

  function shotOf(t, cuts) { var k = 0; while (k < cuts.length && cuts[k] <= t) k++; return k; }

  /* ---------- text helpers ---------- */

  function joinText(ws) { return ws.map(function (w) { return w.text; }).join(' '); }

  // how good the best 2-line layout of these words is (0 = fits on one line)
  function layoutCost(ws, o) {
    if (ws.length === 1 || joinText(ws).length <= o.maxChars) return 0;
    var best = Infinity;
    for (var k = 1; k < ws.length - 1; k++) {                 // the 2nd line is never a single word
      if (joinText(ws.slice(0, k)).length > o.maxChars || joinText(ws.slice(k)).length > o.maxChars) continue;
      best = Math.min(best, breakScore(ws, k, false));
    }
    return best === Infinity ? 3 : Math.max(0, best + 0.6);
  }

  function layout(ws, o) {
    var text = joinText(ws);
    if (ws.length === 1 || text.length <= o.maxChars) return [text];
    if (o.maxLines < 2) return null;
    var best = null, bestScore = Infinity;
    for (var k = 1; k < ws.length - 1; k++) {                 // the 2nd line is never a single word
      var a = joinText(ws.slice(0, k)), b = joinText(ws.slice(k));
      if (a.length > o.maxChars || b.length > o.maxChars) continue;
      var s = breakScore(ws, k, false);
      if (s < bestScore) { bestScore = s; best = [a, b]; }
    }
    return best;
  }

  // used only when a merge made a caption wider than the limits: best balanced break, no limit
  function forceLines(ws, o) {
    if (o.maxLines < 2 || ws.length < 3) return [joinText(ws)];
    var best = 1, bs = Infinity;
    for (var k = 1; k < ws.length - 1; k++) { var sc = breakScore(ws, k, false); if (sc < bs) { bs = sc; best = k; } }
    return [joinText(ws.slice(0, best)), joinText(ws.slice(best))];
  }

  function dur(ws) { return ws[ws.length - 1].end - ws[0].start; }
  function fits(ws, o) { return ws.length === 1 || (!!layout(ws, o) && dur(ws) <= o.maxDur); }

  // lower = better place to split between ws[k-1] and ws[k]
  function isBrandPair(prev, next) {
    var p = bare(prev), n = bare(next);
    return (p === 'omni' && /^(creatine|electrolytes|electrolyte|gummies|gummy)$/.test(n)) ||
           (p === 'creatine' && /^(gumm(y|ies)|electrolytes?)$/.test(n));
  }

  // lower = better place to split between ws[k-1] and ws[k]
  function breakScore(ws, k, useGap) {
    var la = joinText(ws.slice(0, k)).length, lb = joinText(ws.slice(k)).length;
    var s = Math.abs(la - lb) / Math.max(1, la + lb) * 0.6;
    var prev = ws[k - 1].text, next = ws[k].text, p = bare(prev), n = bare(next);
    if (SOFT_END.test(prev)) s -= 0.9;                       // after a comma / colon: best
    else if (CHUNK_START[n] && !GLUE_NEXT[p]) s -= 0.4;      // before "of / that / are / because …"
    else if (!GLUE_NEXT[p]) s += 1.2;                        // between two content words: "creatine | brands", "lean | muscle"
    var soft = SOFT_END.test(prev);
    if (GLUE_NEXT[p] && !soft) s += 1.0;                              // never end on "the", "of", "so", "many" …
    if (ARTICLE[p] && !soft) s += 1.5;
    if (/^(and|but|or|nor|so|because|that|if|when|while)$/.test(p) && !SOFT_END.test(prev)) s += 1.2;
    if (/^(must|can|could|will|would|should|might|may|do|does|did|am|is|are|was|were|be|been|has|have|had|i'm|you're|they're|we're|it's|he's|she's|that's|i've|you've|we've|they've|i'll|you'll|won't|can't|don't|doesn't|didn't)$/.test(p) && !CHUNK_START[n] && !SOFT_END.test(prev)) s += 0.9;   // "must | be safe", "they are | likely"    // never end on "and / but / because"                                 // and really never on "the / a / my / their" …
    if (/^\d/.test(next) && GLUE_NEXT[p]) s += 0.5;           // "the | 3 grams"
    if (/^[\d$]/.test(prev) && !SOFT_END.test(prev)) s += 0.8; // "3 | grams", "$67 | off"
    if (k === 1 || ws.length - k === 1) s += 0.8;            // no single word left alone
    if (isBrandPair(prev, next)) s += 10;                    // OMNI Creatine Gummies is never split
    if (useGap) s -= Math.min(Math.max(0, ws[k].start - ws[k - 1].end), 0.5) * 0.8;
    return s;
  }

  function splitToFit(ws, o) {
    if (fits(ws, o)) return [ws];
    var best = 1, bestScore = Infinity;
    for (var k = 1; k < ws.length; k++) {
      var s = breakScore(ws, k, true);
      if (!fits(ws.slice(0, k), o)) s += 0.3;
      if (!fits(ws.slice(k), o)) s += 0.3;
      s += 0.7 * (layoutCost(ws.slice(0, k), o) + layoutCost(ws.slice(k), o));   // both halves must also break into good lines
      if (s < bestScore) { bestScore = s; best = k; }
    }
    return splitToFit(ws.slice(0, best), o).concat(splitToFit(ws.slice(best), o));
  }

  /* ---------- main ---------- */

  function build(rawWords, rawCuts, info, opts) {
    var o = merge(opts);
    var frame = (info && info.frame) || 1 / 25;
    var words = normWords(rawWords);
    if (!words.length) return [];
    var seqEnd = Math.max((info && info.end) || 0, words[words.length - 1].end + 1);
    var cuts = normCuts(rawCuts, frame, seqEnd);

    words.forEach(function (w) { w.shot = shotOf((w.start + w.end) / 2, cuts); });

    // 1. phrases: break on sentence end, long pause, or cut
    var phrases = [], cur = [words[0]];
    for (var i = 1; i < words.length; i++) {
      var p = words[i - 1], w = words[i], why = null;
      if (w.shot !== p.shot) why = 'cut';
      else if (SENT_END.test(p.text) || p.eol) why = 'sentence';
      else if (w.start - p.end > o.gapBreak) why = 'gap';
      if (why) { phrases.push({ ws: cur, endWhy: why }); cur = [w]; }
      else cur.push(w);
    }
    phrases.push({ ws: cur, endWhy: 'end' });

    // 1b. a cut that falls inside a phrase ("look for a brand that has | real people behind it"):
    //     the caption still changes exactly on the cut, but the words may shift by up to 3 so the
    //     split lands between phrases, not inside one ("look for a brand | that has real people…").
    for (var pi = 0; pi < phrases.length - 1; pi++) {
      var L0 = phrases[pi], R0 = phrases[pi + 1];
      if (L0.endWhy !== 'cut') continue;
      if (SENT_END.test(L0.ws[L0.ws.length - 1].text) || L0.ws[L0.ws.length - 1].eol) continue;   // cut on a sentence end: nothing to fix
      var all = L0.ws.concat(R0.ws), base = L0.ws.length, cutT = cuts[R0.ws[0].shot - 1];
      var bestK = base, bestS = breakScore(all, base, false);
      for (var k2 = Math.max(1, base - 3); k2 <= Math.min(all.length - 1, base + 3); k2++) {
        if (k2 === base) continue;
        if (k2 < base && all[k2].end < cutT - 0.6) continue;          // words moving right must touch the cut
        if (k2 > base && all[k2 - 1].start > cutT + 0.6) continue;    // words moving left must touch the cut
        // never move words across a sentence end
        var sentInside = false, qa = k2 < base ? k2 : base - 1, qb = k2 < base ? base - 1 : k2 - 2;
        for (var q2 = qa; q2 <= qb; q2++) if (SENT_END.test(all[q2].text) || all[q2].eol) sentInside = true;
        if (sentInside) continue;
        var sc2 = breakScore(all, k2, false) + 0.35 * Math.abs(k2 - base);
        if (sc2 < bestS - 0.2) { bestS = sc2; bestK = k2; }
      }
      if (bestK !== base) {
        var ls = L0.ws[0].shot, rs = R0.ws[0].shot;
        L0.ws = all.slice(0, bestK); R0.ws = all.slice(bestK);
        L0.ws.forEach(function (w) { w.shot = ls; });
        R0.ws.forEach(function (w) { w.shot = rs; });
      }
    }

    // 2. split every phrase to size
    var caps = [];
    phrases.forEach(function (ph) {
      splitToFit(ph.ws, o).forEach(function (ws) { caps.push({ words: ws, shot: ws[ws.length - 1].shot }); });
    });

    // 3. a lone short word left at the very end of a shot, mid-sentence ("... and | my back"),
    //    moves into the next shot's caption so nothing flashes for a few frames
    for (var j = 0; j < caps.length - 1; j++) {
      var cj = caps[j], nj = caps[j + 1];
      if (cj.words.length !== 1 || nj.shot === cj.shot) continue;
      var lone = cj.words[0];
      if (SENT_END.test(lone.text) || SOFT_END.test(lone.text)) continue;
      if (lone.end - lone.start > o.orphanMax) continue;
      if (nj.words[0].start - lone.end > o.gapBreak) continue;
      lone.shot = nj.shot;
      var redo = splitToFit([lone].concat(nj.words), o).map(function (ws) { return { words: ws, shot: nj.shot }; });
      caps.splice.apply(caps, [j, 2].concat(redo));
    }

    // 4. timing
    function shotStart(s) { return s === 0 ? 0 : cuts[s - 1]; }
    function shotEnd(s) { return s < cuts.length ? cuts[s] : seqEnd; }

    caps.forEach(function (c, idx) {
      var a = shotStart(c.shot), b = shotEnd(c.shot);
      var firstInShot = idx === 0 || caps[idx - 1].shot !== c.shot;
      var lastInShot = idx === caps.length - 1 || caps[idx + 1].shot !== c.shot;
      c.start = c.words[0].start;
      c.end = c.words[c.words.length - 1].end + o.linger;
      if (firstInShot && c.start - a < o.snapIn) c.start = a;
      if (lastInShot && b - c.end < o.snapOut) c.end = b;
      c.start = Math.max(c.start, a);
      c.end = Math.min(c.end, b);
    });
    for (var q = 1; q < caps.length; q++) if (caps[q].start < caps[q - 1].start + frame) caps[q].start = caps[q - 1].start + frame;
    for (var n = 0; n < caps.length; n++) {
      var c = caps[n], nxt = caps[n + 1];
      var limit = nxt ? Math.min(shotEnd(c.shot), nxt.start) : shotEnd(c.shot);
      if (c.end > limit) c.end = limit;
      if (nxt && nxt.shot === c.shot && nxt.start - c.end < o.closeGap) c.end = nxt.start;
    }

    // 5. minimum duration: borrow time from a neighbour in the same shot, never across a cut
    for (var r = 0; r < caps.length; r++) {
      var cr = caps[r], nr = caps[r + 1], pr = caps[r - 1];
      if (cr.end - cr.start >= o.minDur) continue;
      var sameN = nr && nr.shot === cr.shot, sameP = pr && pr.shot === cr.shot;
      var maxEnd = Math.min(shotEnd(cr.shot), sameN ? Math.max(nr.start, nr.end - o.minDur) : (nr ? nr.start : Infinity));
      var newEnd = Math.min(cr.start + o.minDur, maxEnd);
      if (newEnd > cr.end) { cr.end = newEnd; if (sameN && nr.start < cr.end) nr.start = cr.end; }
      if (cr.end - cr.start < o.minDur) {
        var minStart = Math.max(shotStart(cr.shot), pr ? (sameP ? Math.min(pr.end, pr.start + o.minDur) : pr.end) : 0);
        var newStart = Math.max(cr.end - o.minDur, minStart);
        if (newStart < cr.start) { cr.start = newStart; if (sameP && pr.end > cr.start) pr.end = cr.start; }
      }
      var floorDur = Math.min(o.minDur, 0.4);
      if (cr.end - cr.start < floorDur) {
        // 1) the pair has room for two readable captions -> share the time between them
        // 2) it does not, and the merged text still fits -> merge (never gluing two sentences)
        // 3) neither -> share anyway, so neither one flashes for a few frames
        var nb = sameN ? nr : (sameP ? pr : null);
        if (nb) {
          var s0 = Math.min(cr.start, nb.start), e0 = Math.max(cr.end, nb.end), span = e0 - s0;
          var first = nb === nr ? cr : pr, second = nb === nr ? nr : cr;
          var canMerge = !SENT_END.test(first.words[first.words.length - 1].text) &&
                         !!layout(first.words.concat(second.words), o);
          if (span < 2 * floorDur && canMerge) {
            second.words = first.words.concat(second.words); second.start = s0; second.end = e0;
            caps.splice(caps.indexOf(first), 1); r = Math.max(-1, r - 2);
            continue;
          }
          var pad = Math.min(floorDur, span * 0.35);
          var mid = s0 + span * first.words.length / (first.words.length + second.words.length);
          mid = Math.min(Math.max(mid, s0 + pad), e0 - pad);
          first.start = s0; first.end = mid; second.start = mid; second.end = e0;
        }
      }
    }

    // 6. no gaps: a caption stays up until the next one starts (or until the cut, and the next shot's
    //    first caption starts on the cut) — for pauses up to fillGap; never across a cut
    var fill = +o.fillGap || 0;
    if (fill > 0) {
      for (var g = 0; g < caps.length; g++) {
        var cg = caps[g], ng = caps[g + 1];
        var b3 = shotEnd(cg.shot);
        if (ng && ng.shot === cg.shot) {
          if (ng.start > cg.end && ng.start - cg.end <= fill) cg.end = ng.start;
        } else if (b3 > cg.end && b3 - cg.end <= fill) {
          cg.end = b3;
        }
        if (ng && ng.shot !== cg.shot) {
          var a3 = shotStart(ng.shot);
          if (ng.start > a3 && ng.start - a3 <= fill && a3 >= cg.end) ng.start = a3;
        }
      }
      if (caps.length) {
        var c0 = caps[0], a0 = shotStart(c0.shot);
        if (c0.start > a0 && c0.start - a0 <= fill && a0 > 0) c0.start = a0;
      }
    }

    // final safety: every caption inside its own shot
    caps.forEach(function (c) {
      var a4 = shotStart(c.shot), b4 = shotEnd(c.shot);
      c.start = Math.min(Math.max(c.start, a4), b4 - frame);
      c.end = Math.max(Math.min(c.end, b4), c.start + frame);
    });

    caps.forEach(function (c) {
      c.start = Math.round(c.start / frame) * frame;
      c.end = Math.round(c.end / frame) * frame;
      if (c.end <= c.start) c.end = c.start + frame;
      c.lines = layout(c.words, o) || forceLines(c.words, o);
    });
    for (var m = 0; m < caps.length - 1; m++) if (caps[m].end > caps[m + 1].start) caps[m].end = caps[m + 1].start;
    // a caption squeezed to nothing never loses its words: they join the neighbour
    for (var z = 0; z < caps.length; z++) {
      if (caps[z].end > caps[z].start + 1e-9) continue;
      var nbz = caps[z - 1] || caps[z + 1];
      if (!nbz) { caps[z].end = caps[z].start + frame; continue; }
      nbz.words = caps[z - 1] ? nbz.words.concat(caps[z].words) : caps[z].words.concat(nbz.words);
      nbz.lines = layout(nbz.words, o) || forceLines(nbz.words, o);
      caps.splice(z, 1); z--;
    }

    // 7. text style
    caps.forEach(function (c) {
      var lines = c.lines.slice();
      if (o.noDotsCommas) lines = lines.map(function (l) {
        return l.replace(/(?<!\d)[.,]|[.,](?!\d)|\u2026/g, '').replace(/\s{2,}/g, ' ').trim();
      });
      if (o.stripEndPunct) lines[lines.length - 1] = lines[lines.length - 1].replace(/[.,;:]+(["'”’)\]]*)$/, '$1');
      if (o.upper) lines = lines.map(function (l) { return l.toUpperCase(); });
      c.text = lines.join('\n');
    });

    return caps.map(function (c) {
      return { start: c.start, end: c.end, text: c.text, shot: c.shot };
    });
  }

  function ts(t) {
    var ms = Math.max(0, Math.round(t * 1000));
    var h = Math.floor(ms / 3600000); ms -= h * 3600000;
    var m = Math.floor(ms / 60000); ms -= m * 60000;
    var s = Math.floor(ms / 1000); ms -= s * 1000;
    function p(n, l) { n = String(n); while (n.length < l) n = '0' + n; return n; }
    return p(h, 2) + ':' + p(m, 2) + ':' + p(s, 2) + ',' + p(ms, 3);
  }

  // start rounded UP and end rounded DOWN to the millisecond, so Premiere's own frame
  // conversion can never pull a caption a frame across the cut it was snapped to
  function toSRT(caps) {
    return caps.map(function (c, i) {
      var a = Math.ceil(c.start * 1000 - 1e-6) / 1000, b = Math.floor(c.end * 1000 + 1e-6) / 1000;
      var nx = caps[i + 1];   // captions that touch share the exact same timestamp: no 1-frame gap
      if (nx && Math.abs(nx.start - c.end) < 1e-6) b = Math.ceil(nx.start * 1000 - 1e-6) / 1000;
      if (b <= a) b = a + 0.001;
      return (i + 1) + '\n' + ts(a) + ' --> ' + ts(b) + '\n' + c.text + '\n';
    }).join('\n');
  }

  var api = { build: build, toSRT: toSRT, DEFAULTS: DEFAULTS, _normCuts: normCuts, _dbg: { breakScore: breakScore, layoutCost: layoutCost, merge: merge, layout: layout } };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.OmniCaptions = api;
})(typeof window !== 'undefined' ? window : this);

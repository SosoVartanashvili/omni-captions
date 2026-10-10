/*
 * Soso Auto Edit — clip motion sampling inside the panel (no ffmpeg needed).
 * Plays nothing: seeks a hidden <video> 12 times per second, draws each frame tiny (48x85, grey)
 * and measures how much the picture changes from one sample to the next.
 */
(function (root) {
  'use strict';
  var W = 48, H = 85;

  function fileUrl(p) {
    var s = String(p).replace(/\\/g, '/');
    if (!/^\//.test(s)) s = '/' + s;
    return 'file://' + encodeURI(s).replace(/#/g, '%23').replace(/\?/g, '%3F');
  }

  function once(el, ok, bad, ms) {
    return new Promise(function (resolve, reject) {
      var t = setTimeout(function () { done(); reject(new Error('timed out')); }, ms || 8000);
      function done() { clearTimeout(t); el.removeEventListener(ok, onOk); if (bad) el.removeEventListener(bad, onBad); }
      function onOk() { done(); resolve(); }
      function onBad() { done(); reject(new Error('cannot decode this video here')); }
      el.addEventListener(ok, onOk);
      if (bad) el.addEventListener(bad, onBad);
    });
  }

  // -> {dur, width, height, fps, motion: number[]}
  function sampleMotion(path, fps, onTick) {
    fps = fps || 12;
    var doc = root.document, v = doc.createElement('video'), cv = doc.createElement('canvas');
    cv.width = W; cv.height = H;
    var ctx = cv.getContext('2d');
    v.muted = true; v.preload = 'auto'; v.playsInline = true;
    var p = once(v, 'loadeddata', 'error', 15000);
    v.src = fileUrl(path);
    var prev = null, motion = [], dur = 0;
    return p.then(function () {
      dur = v.duration;
      if (!(dur > 0) || !v.videoWidth) throw new Error('cannot decode this video here');
      var times = [];
      for (var t = 0.5 / fps; t < dur - 0.01; t += 1 / fps) times.push(t);
      return times.reduce(function (chain, t, k) {
        return chain.then(function () {
          var s = once(v, 'seeked', 'error', 4000);
          v.currentTime = t;
          return s;
        }).then(function () {
          ctx.drawImage(v, 0, 0, W, H);
          var d = ctx.getImageData(0, 0, W, H).data, g = new Float32Array(W * H);
          for (var i = 0, j = 0; i < d.length; i += 4, j++) g[j] = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
          if (prev) {
            var s = 0;
            for (var q = 0; q < g.length; q++) s += Math.abs(g[q] - prev[q]);
            motion.push(s / g.length);
          }
          prev = g;
          if (onTick) onTick(k + 1, times.length);
        });
      }, Promise.resolve());
    }).then(function () {
      var out = { dur: dur, width: v.videoWidth, height: v.videoHeight, fps: fps, motion: motion };
      v.removeAttribute('src'); try { v.load(); } catch (e) {}
      return out;
    }, function (e) {
      v.removeAttribute('src'); try { v.load(); } catch (e2) {}
      throw e;
    });
  }

  // duration of any media file (audio or video)
  function mediaDuration(path) {
    var a = root.document.createElement('audio');
    a.preload = 'metadata';
    var p = once(a, 'loadedmetadata', 'error', 10000);
    a.src = fileUrl(path);
    return p.then(function () { var d = a.duration; a.removeAttribute('src'); return d; });
  }

  // mono PCM of an audio file, through the panel's Web Audio
  function decodeAudio(buf) {
    var Ctx = root.AudioContext || root.webkitAudioContext;
    if (!Ctx) return Promise.reject(new Error('no Web Audio'));
    var ctx = new Ctx(), ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    return new Promise(function (resolve, reject) { ctx.decodeAudioData(ab, resolve, reject); }).then(function (ad) {
      var n = ad.length, mono = new Float32Array(n), ch = ad.numberOfChannels;
      for (var c = 0; c < ch; c++) { var d = ad.getChannelData(c); for (var i = 0; i < n; i++) mono[i] += d[i] / ch; }
      try { ctx.close(); } catch (e) {}
      return { pcm: mono, sr: ad.sampleRate, dur: ad.duration };
    });
  }

  root.SosoAnalyze = { sampleMotion: sampleMotion, mediaDuration: mediaDuration, decodeAudio: decodeAudio, fileUrl: fileUrl };
})(typeof window !== 'undefined' ? window : this);

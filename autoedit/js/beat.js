/*
 * Soso Auto Edit — tempo + first beat from mono PCM (used when the project notes have no BPM).
 * Onset strength = spectral flux (log magnitude, 1024-pt FFT, ~100 frames/s);
 * tempo = best autocorrelation (with 2x and 4x lags) in 70..190 BPM, mild preference for ~120;
 * phase = the offset whose beat grid lands on the most onset energy.
 */
(function (root) {
  'use strict';
  function fft(re, im) {                       // in-place radix-2
    var n = re.length, i, j = 0, k, m, t;
    for (i = 1; i < n; i++) {
      var bit = n >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) { t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
    }
    for (m = 2; m <= n; m <<= 1) {
      var ang = -2 * Math.PI / m, wr = Math.cos(ang), wi = Math.sin(ang);
      for (i = 0; i < n; i += m) {
        var cr = 1, ci = 0;
        for (k = 0; k < m / 2; k++) {
          var a = i + k, b = a + m / 2;
          var xr = re[b] * cr - im[b] * ci, xi = re[b] * ci + im[b] * cr;
          re[b] = re[a] - xr; im[b] = im[a] - xi; re[a] += xr; im[a] += xi;
          t = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = t;
        }
      }
    }
  }
  // downmix/decimate to ~22 kHz first if needed (sr > 30000 -> keep every 2nd sample after averaging)
  function prep(pcm, sr) {
    if (sr <= 30000) return { x: pcm, sr: sr };
    var n = Math.floor(pcm.length / 2), y = new Float32Array(n);
    for (var i = 0; i < n; i++) y[i] = 0.5 * (pcm[2 * i] + pcm[2 * i + 1]);
    return { x: y, sr: sr / 2 };
  }
  function onsetEnvelope(pcm0, sr0) {
    var p = prep(pcm0, sr0), x = p.x, sr = p.sr, win = 1024, hop = Math.round(sr / 100);
    var n = Math.floor((x.length - win) / hop), half = win / 2;
    var hann = new Float32Array(win), i, k;
    for (i = 0; i < win; i++) hann[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (win - 1));
    var prev = new Float32Array(half + 1), flux = new Float32Array(Math.max(0, n));
    var re = new Float32Array(win), im = new Float32Array(win);
    for (var f = 0; f < n; f++) {
      var o = f * hop;
      for (i = 0; i < win; i++) { re[i] = x[o + i] * hann[i]; im[i] = 0; }
      fft(re, im);
      var s = 0;
      for (k = 0; k <= half; k++) {
        var mag = Math.log(1 + 100 * Math.sqrt(re[k] * re[k] + im[k] * im[k]));
        if (f && mag > prev[k]) s += mag - prev[k];
        prev[k] = mag;
      }
      flux[f] = s;
    }
    // subtract a 20-frame moving average, keep the positive part
    var out = new Float32Array(n), acc = 0, W = 20;
    for (i = 0; i < n; i++) {
      acc += flux[i]; if (i >= W) acc -= flux[i - W];
      var c = Math.min(n - 1, i + W / 2);                     // centred-ish average
      out[i] = flux[i];
    }
    var sum = 0;
    for (i = 0; i < n; i++) {
      sum += flux[i]; if (i >= W) sum -= flux[i - W];
      var j = i - W / 2;
      if (j >= 0) out[j] = Math.max(0, flux[j] - sum / W);
    }
    return { env: out, fps: sr / hop };
  }
  function detect(pcm, sr) {
    var o = onsetEnvelope(pcm, sr), env = o.env, fps = o.fps, n = env.length, i;
    if (n < fps * 4) return null;
    var mean = 0;
    for (i = 0; i < n; i++) mean += env[i];
    mean /= n;
    var e = new Float32Array(n);
    for (i = 0; i < n; i++) e[i] = env[i] - mean;
    function ac(lag) {
      var l0 = Math.floor(lag), f = lag - l0, s = 0, c = 0;
      for (var j = 0; j + l0 + 1 < n; j++) { s += e[j] * (e[j + l0] * (1 - f) + e[j + l0 + 1] * f); c++; }
      return c ? s / c : 0;
    }
    function score(bpm) { var lag = 60 * fps / bpm; return ac(lag) + 0.5 * ac(2 * lag) + 0.25 * ac(4 * lag); }
    var best = null, bpm;
    for (bpm = 70; bpm <= 190; bpm += 0.5) {
      var w = Math.exp(-0.5 * Math.pow(Math.log2(bpm / 120) / 0.9, 2));
      var sc = score(bpm) * w;
      if (!best || sc > best.s) best = { bpm: bpm, s: sc };
    }
    // joint fine search: tempo +-1.5 BPM and phase, maximise onset energy on the grid (no drift)
    function gridSum(period, ph) {
      var t = ph, sum = 0;
      while (t * fps < n - 1) { var idx = Math.round(t * fps); sum += env[idx] + 0.5 * ((env[idx - 1] || 0) + (env[idx + 1] || 0)); t += period; }
      return sum;
    }
    var fine = best.bpm, bestPh = 0, bestS = -Infinity;
    for (bpm = best.bpm - 1.5; bpm <= best.bpm + 1.5; bpm += 0.05) {
      var period = 60 / bpm;
      for (var ph = 0; ph < period; ph += 0.005) {
        var gs = gridSum(period, ph);
        if (gs > bestS) { bestS = gs; bestPh = ph; fine = bpm; }
      }
    }
    return { bpm: Math.round(fine * 10) / 10, firstBeat: Math.round(bestPh * 1000) / 1000 };
  }
  var api = { detect: detect, _onset: onsetEnvelope };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.SosoBeat = api;
})(typeof window !== 'undefined' ? window : this);

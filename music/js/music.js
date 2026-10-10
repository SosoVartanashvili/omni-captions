/*
 * Soso Music — ElevenLabs Music call (Node, inside the CEP panel).
 * POST /v1/music  { prompt, music_length_ms, model_id, force_instrumental } -> audio bytes,
 * streamed straight into a file.
 */
(function (root) {
  'use strict';
  var req = (typeof require === 'function') ? require : (root.cep_node && root.cep_node.require);
  var fs = req('fs'), https = req('https'), http = req('http'), pathMod = req('path');
  var Buffer = req('buffer').Buffer;

  var BASE = 'https://api.elevenlabs.io';
  var MIN_MS = 3000, MAX_MS = 600000;

  function clampMs(sec) { return Math.max(MIN_MS, Math.min(MAX_MS, Math.round(sec * 1000))); }

  function friendly(code, msg) {
    if (code === 401) return 'ElevenLabs refused the API key (401). Check the key — if it is a restricted key, turn on "Music" access for it in ElevenLabs › API keys. ' + msg;
    if (code === 402) return 'Not enough ElevenLabs credits / Music is not on this plan (402). ' + msg;
    if (code === 429) return 'ElevenLabs is busy or the limit was hit (429) — try again in a minute. ' + msg;
    return 'ElevenLabs ' + code + ': ' + msg;
  }

  /*
   * opts: { prompt, seconds, model, instrumental, format }
   * resolves { path, bytes, songId, ms }
   */
  function compose(apiKey, outPath, opts, base) {
    return new Promise(function (resolve, reject) {
      var ms = clampMs(opts.seconds);
      var body = Buffer.from(JSON.stringify({
        prompt: String(opts.prompt).slice(0, 4100),
        music_length_ms: ms,
        model_id: opts.model || 'music_v1',
        force_instrumental: opts.instrumental !== false
      }), 'utf8');
      var u = new URL((base || BASE) + '/v1/music?output_format=' + encodeURIComponent(opts.format || 'mp3_44100_128'));
      var mod = u.protocol === 'http:' ? http : https;
      var r = mod.request({
        method: 'POST', hostname: u.hostname, port: u.port || undefined, path: u.pathname + u.search,
        headers: { 'xi-api-key': apiKey, 'Content-Type': 'application/json', 'Content-Length': body.length, 'Accept': 'audio/mpeg' }
      }, function (res) {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          var chunks = [];
          res.on('data', function (c) { chunks.push(c); });
          res.on('end', function () {
            var txt = Buffer.concat(chunks).toString('utf8'), msg = txt;
            try {
              var j = JSON.parse(txt);
              msg = (j.detail && (j.detail.message || (typeof j.detail === 'string' ? j.detail : JSON.stringify(j.detail)))) || txt;
            } catch (e) {}
            reject(new Error(friendly(res.statusCode, String(msg).slice(0, 400))));
          });
          return;
        }
        var tmp = outPath + '.part', out = fs.createWriteStream(tmp), bytes = 0;
        res.on('data', function (c) { bytes += c.length; });
        res.pipe(out);
        out.on('finish', function () {
          if (bytes < 1000) { try { fs.unlinkSync(tmp); } catch (e) {} return reject(new Error('ElevenLabs returned an empty file.')); }
          fs.renameSync(tmp, outPath);
          resolve({ path: outPath, bytes: bytes, songId: res.headers['song-id'] || '', ms: ms });
        });
        out.on('error', reject);
      });
      r.on('error', function (e) { reject(new Error('Could not reach ElevenLabs: ' + e.message)); });
      r.setTimeout(15 * 60 * 1000, function () { r.destroy(new Error('ElevenLabs took too long (15 min).')); });
      r.end(body);
    });
  }

  // write the audio response to outPath (shared by both calls)
  function saveAudio(res, outPath, ms, resolve, reject) {
    if (res.statusCode < 200 || res.statusCode >= 300) {
      var chunks = [];
      res.on('data', function (c) { chunks.push(c); });
      res.on('end', function () {
        var txt = Buffer.concat(chunks).toString('utf8'), msg = txt;
        try {
          var j = JSON.parse(txt);
          msg = (j.detail && (j.detail.message || (typeof j.detail === 'string' ? j.detail : JSON.stringify(j.detail)))) || txt;
        } catch (e) {}
        var err = new Error(friendly(res.statusCode, String(msg).slice(0, 400)));
        err.status = res.statusCode; err.raw = txt;
        reject(err);
      });
      return;
    }
    var tmp = outPath + '.part', out = fs.createWriteStream(tmp), bytes = 0;
    res.on('data', function (c) { bytes += c.length; });
    res.pipe(out);
    out.on('finish', function () {
      if (bytes < 1000) { try { fs.unlinkSync(tmp); } catch (e) {} return reject(new Error('ElevenLabs returned an empty file.')); }
      fs.renameSync(tmp, outPath);
      resolve({ path: outPath, bytes: bytes, songId: res.headers['song-id'] || '', ms: ms });
    });
    out.on('error', reject);
  }

  /*
   * Video to Music: ElevenLabs watches the video itself (mood, pace, cuts) and scores it.
   * opts: { videoPath, description, tags[], model, format, seconds }
   */
  function videoToMusic(apiKey, outPath, opts, base) {
    // the docs show both "videos" and "videos[]"; a 422 about the field costs nothing, so try the other name once
    return sendVideo(apiKey, outPath, opts, base, 'videos').catch(function (e) {
      if (e.status === 422 && /video/i.test(e.raw || '')) return sendVideo(apiKey, outPath, opts, base, 'videos[]');
      throw e;
    });
  }

  function sendVideo(apiKey, outPath, opts, base, fieldName) {
    return new Promise(function (resolve, reject) {
      var size = fs.statSync(opts.videoPath).size;
      if (size > 200 * 1024 * 1024) return reject(new Error('The exported video is ' + Math.round(size / 1048576) + ' MB — ElevenLabs takes up to 200 MB. Pick a smaller video preset in Settings.'));
      var b = '----sosomusic' + Date.now().toString(16) + Math.random().toString(16).slice(2);
      var head = '';
      function field(k, v) { head += '--' + b + '\r\nContent-Disposition: form-data; name="' + k + '"\r\n\r\n' + v + '\r\n'; }
      if (opts.description) field('description', String(opts.description).slice(0, 4100));
      (opts.tags || []).slice(0, 10).forEach(function (t) { field('tags', t); });
      field('model_id', opts.model || 'music_v1');
      head += '--' + b + '\r\nContent-Disposition: form-data; name="' + fieldName + '"; filename="' +
        pathMod.basename(opts.videoPath).replace(/"/g, '') + '"\r\nContent-Type: video/mp4\r\n\r\n';
      var headBuf = Buffer.from(head, 'utf8'), tailBuf = Buffer.from('\r\n--' + b + '--\r\n', 'utf8');
      var u = new URL((base || BASE) + '/v1/music/video-to-music?output_format=' + encodeURIComponent(opts.format || 'mp3_44100_128'));
      var mod = u.protocol === 'http:' ? http : https;
      var r = mod.request({
        method: 'POST', hostname: u.hostname, port: u.port || undefined, path: u.pathname + u.search,
        headers: { 'xi-api-key': apiKey, 'Content-Type': 'multipart/form-data; boundary=' + b,
                   'Content-Length': headBuf.length + size + tailBuf.length }
      }, function (res) { saveAudio(res, outPath, Math.round((opts.seconds || 0) * 1000), resolve, reject); });
      r.on('error', function (e) { reject(new Error('Could not reach ElevenLabs: ' + e.message)); });
      r.setTimeout(20 * 60 * 1000, function () { r.destroy(new Error('ElevenLabs took too long (20 min).')); });
      r.write(headBuf);
      var s = fs.createReadStream(opts.videoPath);
      s.on('error', function (e) { r.destroy(e); reject(e); });
      s.on('end', function () { r.end(tailBuf); });
      s.pipe(r, { end: false });
    });
  }

  var api = { compose: compose, videoToMusic: videoToMusic, clampMs: clampMs, MIN_MS: MIN_MS, MAX_MS: MAX_MS };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.SosoMusicApi = api;
})(typeof window !== 'undefined' ? window : this);

/*
 * OMNI Captions — ElevenLabs calls (Node, inside the CEP panel).
 * Streams the audio file as multipart/form-data; never loads it into memory.
 */
(function (root) {
  'use strict';
  var req = (typeof require === 'function') ? require : (root.cep_node && root.cep_node.require);
  var fs = req('fs'), pathMod = req('path'), https = req('https'), http = req('http');
  var Buffer = req('buffer').Buffer;

  var BASE = 'https://api.elevenlabs.io';

  function mime(p) {
    var ext = pathMod.extname(p).toLowerCase();
    return { '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.aac': 'audio/aac' }[ext] || 'application/octet-stream';
  }

  function postMultipart(url, apiKey, fields, filePath, timeoutMs) {
    return new Promise(function (resolve, reject) {
      var b = '----omnicaptions' + Date.now().toString(16) + Math.random().toString(16).slice(2);
      var head = '';
      Object.keys(fields).forEach(function (k) {
        if (fields[k] === undefined || fields[k] === null || fields[k] === '') return;
        head += '--' + b + '\r\nContent-Disposition: form-data; name="' + k + '"\r\n\r\n' + fields[k] + '\r\n';
      });
      head += '--' + b + '\r\nContent-Disposition: form-data; name="file"; filename="' +
        pathMod.basename(filePath).replace(/"/g, '') + '"\r\nContent-Type: ' + mime(filePath) + '\r\n\r\n';
      var tail = '\r\n--' + b + '--\r\n';
      var headBuf = Buffer.from(head, 'utf8'), tailBuf = Buffer.from(tail, 'utf8');
      var size = headBuf.length + fs.statSync(filePath).size + tailBuf.length;

      var u = new URL(url);
      var mod = u.protocol === 'http:' ? http : https;
      var r = mod.request({
        method: 'POST', hostname: u.hostname, port: u.port || undefined, path: u.pathname + u.search,
        headers: { 'xi-api-key': apiKey, 'Content-Type': 'multipart/form-data; boundary=' + b, 'Content-Length': size }
      }, function (res) {
        var chunks = [];
        res.on('data', function (c) { chunks.push(c); });
        res.on('end', function () {
          var body = Buffer.concat(chunks).toString('utf8');
          if (res.statusCode >= 200 && res.statusCode < 300) {
            try { resolve(JSON.parse(body)); } catch (e) { reject(new Error('Bad JSON from ElevenLabs: ' + body.slice(0, 300))); }
          } else {
            var msg = body;
            try { var j = JSON.parse(body); msg = (j.detail && (j.detail.message || JSON.stringify(j.detail))) || body; } catch (e2) {}
            reject(new Error('ElevenLabs ' + res.statusCode + ': ' + String(msg).slice(0, 400)));
          }
        });
      });
      r.on('error', function (e) { reject(new Error('Could not reach ElevenLabs: ' + e.message)); });
      r.setTimeout(timeoutMs || 20 * 60 * 1000, function () { r.destroy(new Error('ElevenLabs request timed out')); });
      r.write(headBuf);
      var s = fs.createReadStream(filePath);
      s.on('error', function (e) { r.destroy(e); reject(e); });
      s.on('end', function () { r.end(tailBuf); });
      s.pipe(r, { end: false });
    });
  }

  // Transcribe with Scribe. Returns [{text,start,end,type}]
  function transcribe(apiKey, filePath, opts, base) {
    opts = opts || {};
    return postMultipart((base || BASE) + '/v1/speech-to-text', apiKey, {
      model_id: opts.model || 'scribe_v2',
      timestamps_granularity: 'word',
      tag_audio_events: 'false',
      diarize: 'false',
      language_code: opts.language || ''
    }, filePath).then(function (j) { return { words: j.words || [], text: j.text || '', language: j.language_code || '' }; });
  }

  // Align a known script to the audio (exact text, exact timing). Returns [{text,start,end}]
  function align(apiKey, filePath, text, base) {
    return postMultipart((base || BASE) + '/v1/forced-alignment', apiKey, { text: text }, filePath)
      .then(function (j) { return { words: j.words || [], text: text, loss: j.loss }; });
  }

  var api = { transcribe: transcribe, align: align, _postMultipart: postMultipart };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.OmniEleven = api;
})(typeof window !== 'undefined' ? window : this);

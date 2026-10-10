/*
 * OMNI Captions — read a script from a Notion page (read-only).
 * Uses the Notion API with an internal-integration token the editor pastes in Settings.
 * Only GET requests: it can read a page, never change it.
 */
(function (root) {
  'use strict';
  var req = (typeof require === 'function') ? require : (root.cep_node && root.cep_node.require);
  var https = req('https'), http = req('http'), Buffer = req('buffer').Buffer;

  var API = 'https://api.notion.com';
  var TEXT_BLOCKS = ['paragraph', 'heading_1', 'heading_2', 'heading_3', 'bulleted_list_item', 'numbered_list_item',
    'quote', 'callout', 'toggle', 'to_do'];

  function pageId(link) {
    var s = String(link || '').split(/[?#]/)[0].replace(/\/+$/, '');
    var m = s.match(/([0-9a-f]{32})$/i) || s.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i);
    if (m) m[1] = m[1].replace(/-/g, '');
    if (!m) return null;
    var h = m[1].toLowerCase();
    return h.slice(0, 8) + '-' + h.slice(8, 12) + '-' + h.slice(12, 16) + '-' + h.slice(16, 20) + '-' + h.slice(20);
  }

  function getJson(base, path, token) {
    return new Promise(function (resolve, reject) {
      var u = new URL(base + path);
      var mod = u.protocol === 'http:' ? http : https;
      var r = mod.request({
        method: 'GET', protocol: u.protocol, hostname: u.hostname, port: u.port || undefined, path: u.pathname + u.search,
        headers: { 'Authorization': 'Bearer ' + token, 'Notion-Version': '2022-06-28' }
      }, function (res) {
        var chunks = [];
        res.on('data', function (c) { chunks.push(c); });
        res.on('end', function () {
          var body = Buffer.concat(chunks).toString('utf8');
          var j = null; try { j = JSON.parse(body); } catch (e) {}
          if (res.statusCode === 200 && j) return resolve(j);
          var msg = (j && j.message) || body.slice(0, 200);
          if (res.statusCode === 404) msg = 'Page not found — in Notion, open the page (or its teamspace) › ••• › Connections and add your Soso Captions integration.';
          if (res.statusCode === 401) msg = 'The Notion token is not valid.';
          reject(new Error('Notion ' + res.statusCode + ': ' + msg));
        });
      });
      r.on('error', function (e) { reject(new Error('Could not reach Notion: ' + e.message)); });
      r.setTimeout(20000, function () { r.destroy(new Error('Notion timed out')); });
      r.end();
    });
  }

  function children(base, id, token, depth, lines) {
    function page(cursor) {
      var q = '/v1/blocks/' + id + '/children?page_size=100' + (cursor ? '&start_cursor=' + encodeURIComponent(cursor) : '');
      return getJson(base, q, token).then(function (j) {
        var chain = Promise.resolve();
        (j.results || []).forEach(function (b) {
          chain = chain.then(function () {
            var body = b[b.type];
            if (TEXT_BLOCKS.indexOf(b.type) >= 0 && body && body.rich_text) {
              var t = body.rich_text.map(function (r) { return r.plain_text || ''; }).join('').trim();
              if (t) lines.push(t);
            }
            if (b.has_children && depth < 3 && b.type !== 'child_page' && b.type !== 'child_database') {
              return children(base, b.id, token, depth + 1, lines);
            }
          });
        });
        return chain.then(function () { if (j.has_more && j.next_cursor) return page(j.next_cursor); });
      });
    }
    return page(null);
  }

  // -> Promise<string> : the page's text, one block per line
  function readPage(link, token, base) {
    var id = pageId(link);
    if (!id) return Promise.reject(new Error('That does not look like a Notion page link.'));
    if (!token) return Promise.reject(new Error('Paste the Notion token in Settings first.'));
    var lines = [];
    return children(base || API, id, token, 0, lines).then(function () { return lines.join('\n'); });
  }

  var api = { readPage: readPage, pageId: pageId };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.OmniNotion = api;
})(typeof window !== 'undefined' ? window : this);

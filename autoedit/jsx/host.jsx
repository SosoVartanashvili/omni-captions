/*
 * Soso Auto Edit — Premiere Pro side (ExtendScript, ES3).
 * Everything returns a JSON string; errors come back as {"error": "..."}.
 */

var SAE_TPS = 254016000000;

function sae_q(s) {
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
function sae_json(v) {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'number') return isFinite(v) ? String(v) : 'null';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'string') return sae_q(v);
  if (v instanceof Array) {
    var a = [];
    for (var i = 0; i < v.length; i++) a.push(sae_json(v[i]));
    return '[' + a.join(',') + ']';
  }
  var parts = [];
  for (var k in v) if (v.hasOwnProperty(k)) parts.push(sae_q(k) + ':' + sae_json(v[k]));
  return '{' + parts.join(',') + '}';
}
function sae_err(msg) { return sae_json({ error: String(msg) }); }

function sae_info() {
  try {
    if (!app.project) return sae_err('No project open.');
    var p = '';
    try { p = app.project.path || ''; } catch (e) {}
    return sae_json({ projectPath: p });
  } catch (e) { return sae_err(e.toString()); }
}

function sae_norm(p) { return String(p).replace(/\\/g, '/').toLowerCase(); }

function sae_find(item, fsPath) {
  var want = sae_norm(fsPath);
  for (var i = 0; i < item.children.numItems; i++) {
    var ch = item.children[i];
    if (ch.type === ProjectItemType.BIN) {
      var hit = sae_find(ch, fsPath);
      if (hit) return hit;
    } else {
      var p = '';
      try { p = ch.getMediaPath(); } catch (e) {}
      if (p && sae_norm(p) === want) return ch;
    }
  }
  return null;
}

function sae_bin(parent, name) {
  for (var i = 0; i < parent.children.numItems; i++) {
    var ch = parent.children[i];
    if (ch.type === ProjectItemType.BIN && ch.name === name) return ch;
  }
  try { return parent.createBin(name); } catch (e) { return parent; }
}

function sae_item(path, bin) {
  var f = new File(path);
  if (!f.exists) return null;
  var it = sae_find(app.project.rootItem, f.fsName);
  if (!it) {
    app.project.importFiles([f.fsName], true, bin, false);
    it = sae_find(app.project.rootItem, f.fsName);
  }
  return it;
}

function sae_setRange(item, a, b) {
  item.setInPoint(a, 4);
  item.setOutPoint(b, 4);
}
function sae_clearRange(item) {
  try { item.clearInPoint(); } catch (e1) {}
  try { item.clearOutPoint(); } catch (e2) {}
}

function sae_component(trackItem, re) {
  for (var i = 0; i < trackItem.components.numItems; i++) {
    var c = trackItem.components[i], dn = '', mn = '';
    try { dn = String(c.displayName); } catch (e1) {}
    try { mn = String(c.matchName); } catch (e2) {}
    if (re.test(dn) || re.test(mn)) return c;
  }
  return null;
}
function sae_setScale(trackItem, pct) {
  try {
    var m = sae_component(trackItem, /motion|bewegung|movimiento|trajectoire/i);
    if (!m) return false;
    for (var p = 0; p < m.properties.numItems; p++) {
      var pr = m.properties[p];
      if (/^(scale|skalierung|escala|echelle)$/i.test(String(pr.displayName))) { pr.setValue(pct, true); return true; }
    }
  } catch (e) {}
  return false;
}

/*
 * Build one sequence from a plan (JSON string):
 * { name, binName, items:[{path,start,srcIn,srcOut,scene}], music:{path}, markers:[{t,text,color}],
 *   width, height, scale, muteClips }
 */
function sae_build(planStr) {
  try {
    if (!app.project) return sae_err('No project open.');
    var plan = eval('(' + planStr + ')');
    if (!plan.items || !plan.items.length) return sae_err('Nothing to place.');
    var root = sae_bin(app.project.rootItem, 'Soso Auto Edit');
    var bin = sae_bin(root, plan.binName || 'clips');
    var errors = [], placed = 0, i;

    // import everything first
    var cache = {};
    for (i = 0; i < plan.items.length; i++) {
      var p = plan.items[i].path;
      if (!cache[p]) cache[p] = sae_item(p, bin);
      if (!cache[p]) errors.push('Could not import ' + p);
    }
    var first = plan.items[0], firstItem = cache[first.path];
    if (!firstItem) return sae_err('Could not import the first clip: ' + first.path);

    sae_setRange(firstItem, first.srcIn, first.srcOut);
    var seq = app.project.createNewSequenceFromClips(plan.name, [firstItem], root);
    sae_clearRange(firstItem);
    if (!seq) return sae_err('Premiere did not create the sequence.');
    try { app.project.activeSequence = seq; } catch (eA) {}
    placed++;

    if (plan.width && plan.height) {
      try {
        var st = seq.getSettings();
        st.videoFrameWidth = plan.width; st.videoFrameHeight = plan.height;
        seq.setSettings(st);
      } catch (eS) { errors.push('Could not set the sequence to ' + plan.width + 'x' + plan.height); }
    }

    var vt = seq.videoTracks[0];
    for (i = 1; i < plan.items.length; i++) {
      var it = plan.items[i], item = cache[it.path];
      if (!item) continue;
      try {
        sae_setRange(item, it.srcIn, it.srcOut);
        vt.overwriteClip(item, it.start);
        sae_clearRange(item);
        placed++;
      } catch (eP) { errors.push('Scene ' + it.scene + ': ' + eP.toString()); }
    }

    if (plan.scale && Math.abs(plan.scale - 100) > 0.5) {
      var scaled = 0;
      for (var c = 0; c < vt.clips.numItems; c++) if (sae_setScale(vt.clips[c], plan.scale)) scaled++;
      if (!scaled) errors.push('Could not scale the clips to the frame — use Set to Frame Size.');
    }

    if (plan.music && plan.music.path) {
      var mItem = sae_item(plan.music.path, bin);
      if (!mItem) errors.push('Could not import the song.');
      else {
        if (seq.audioTracks.numTracks < 2) {
          try { app.enableQE(); qe.project.getActiveSequence().addTracks(0, 0, 1, 1, seq.audioTracks.numTracks, 0, 0); } catch (eQ) {}
        }
        var at = seq.audioTracks[seq.audioTracks.numTracks > 1 ? 1 : 0];
        try { at.overwriteClip(mItem, 0); } catch (eM) { errors.push('Could not place the song: ' + eM.toString()); }
      }
    }
    if (plan.muteClips) { try { seq.audioTracks[0].setMute(1); } catch (eU) {} }

    var colors = { green: 0, red: 1, purple: 2, orange: 3, yellow: 4, white: 5, blue: 6, cyan: 7 };
    var marks = 0;
    for (i = 0; i < (plan.markers || []).length; i++) {
      var mk = plan.markers[i];
      try {
        var m = seq.markers.createMarker(mk.t);
        m.name = mk.text.length > 60 ? mk.text.substr(0, 57) + '...' : mk.text;
        m.comments = mk.text;
        try { m.setColorByIndex(colors[mk.color] !== undefined ? colors[mk.color] : 1); } catch (eC) {}
        marks++;
      } catch (eK) {}
    }
    return sae_json({ ok: true, name: seq.name, placed: placed, clips: vt.clips.numItems, markers: marks, errors: errors });
  } catch (e) { return sae_err(e.toString()); }
}

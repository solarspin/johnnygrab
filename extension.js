const vscode = require('vscode');
const cp = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const XCRUN = '/usr/bin/xcrun';
const LENGTHS = {
  header: { def: 10, min: 5, max: 30 },
  search: { def: 6, min: 5, max: 30 },
  preview: { def: 16, min: 15, max: 30 }
};
const STATUS_BAR_FLAGS = [
  '--dataNetwork', 'wifi', '--wifiMode', 'active', '--wifiBars', '3',
  '--cellularMode', 'active', '--cellularBars', '4', '--operatorName', '',
  '--batteryState', 'charged', '--batteryLevel', '100'
];
// The four screenshot sizes App Store Connect needs, matched by kind and native capture size.
const CHECKLIST = [
  { id: 'iphone', label: 'iPhone Pro Max', kind: 'iphone', sizes: ['1320x2868', '2868x1320'] },
  { id: 'ipad', label: 'iPad 13"', kind: 'ipad', sizes: ['2064x2752', '2752x2064'] },
  { id: 'duo-closed', label: 'Duo closed', kind: 'duo-closed', sizes: ['1398x2034', '2034x1398'] },
  { id: 'duo-open', label: 'Duo open', kind: 'duo-open', sizes: ['2853x2007', '2007x2853'] }
];

// ---------- helpers ----------

class CancelledError extends Error {
  constructor() {
    super('Cancelled');
    this.cancelled = true;
  }
}

// Runs a process and collects its output. With a cancellation token, cancelling kills the
// process (SIGTERM) and rejects with CancelledError.
function run(file, args, options = {}, token) {
  return new Promise((resolve, reject) => {
    if (token && token.isCancellationRequested) return reject(new CancelledError());
    let sub = null;
    const child = cp.execFile(file, args, { maxBuffer: 64 * 1024 * 1024, ...options }, (err, stdout, stderr) => {
      if (sub) sub.dispose();
      if (token && token.isCancellationRequested) return reject(new CancelledError());
      if (err) {
        err.stdout = stdout;
        err.stderr = stderr;
        reject(err);
      } else {
        resolve({ stdout, stderr });
      }
    });
    if (token) sub = token.onCancellationRequested(() => child.kill('SIGTERM'));
  });
}

// "~" and "~/x" expand to the home folder; a relative path is taken relative to home too.
function expandHome(p) {
  if (!p) return os.homedir();
  const expanded = p === '~' ? os.homedir() : p.replace(/^~(?=\/)/, os.homedir());
  return path.isAbsolute(expanded) ? expanded : path.join(os.homedir(), expanded);
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

function waitForExit(child, ms) {
  return new Promise(resolve => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve(true);
    const timer = setTimeout(() => resolve(false), ms);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function stamp() {
  const d = new Date();
  return [d.getHours(), d.getMinutes(), d.getSeconds()].map(n => String(n).padStart(2, '0')).join('');
}

function safeName(name) {
  const cleaned = (name || '').trim().replace(/[\/\\:*?"<>|]+/g, '').replace(/\s+/g, '-');
  return cleaned || 'app';
}

// Never overwrite: add -2, -3, ... before the extension when the name is taken.
function uniquePath(dir, base, ext) {
  let candidate = path.join(dir, `${base}.${ext}`);
  for (let n = 2; fs.existsSync(candidate); n++) candidate = path.join(dir, `${base}-${n}.${ext}`);
  return candidate;
}

function moveFile(from, to) {
  try {
    fs.renameSync(from, to);
  } catch (err) {
    if (err.code !== 'EXDEV') throw err;
    fs.copyFileSync(from, to);
    fs.unlinkSync(from);
  }
}

function removeQuietly(p) {
  try { fs.rmSync(p, { force: true }); } catch { /* already gone */ }
}

// simctl wants an ISO date with fractional seconds and a zone ("...T09:41:00.000-06:00").
// A plain local "YYYY-MM-DDTHH:MM[:SS]" gets the local offset for that date so the bar reads 9:41.
// Anything else ("9:41", a full ISO string) is passed through unchanged.
function statusBarTime(setting) {
  const value = (setting || '').trim() || '2007-01-09T09:41:00';
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(value);
  if (!m) return value;
  const local = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0));
  const offset = -local.getTimezoneOffset();
  const sign = offset >= 0 ? '+' : '-';
  const abs = Math.abs(offset);
  const hh = String(Math.floor(abs / 60)).padStart(2, '0');
  const mm = String(abs % 60).padStart(2, '0');
  return `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6] || '00'}.000${sign}${hh}:${mm}`;
}

function classify(device) {
  const name = device.name || '';
  const type = device.deviceTypeIdentifier || '';
  const isDuo = /Duo/i.test(name) || /Duo/i.test(type);
  const isIpad = !isDuo && (/iPad/i.test(name) || /iPad/i.test(type));
  return {
    udid: device.udid,
    name,
    runtime: device.runtime,
    isDuo,
    isIpad,
    isProMax: /Pro[ -]Max/i.test(name) || /Pro-Max/i.test(type),
    isIpad13: isIpad && (/13-inch/i.test(name) || /13-inch/i.test(type))
  };
}

// Known screen sizes (portrait, as recorded) for showing expected output sizes before recording.
function screenSize(sim, duoPanel) {
  if (!sim) return null;
  if (sim.isDuo) return duoPanel === 'closed' ? [1398, 2034] : [2006, 2852];
  if (sim.isProMax) return [1320, 2868];
  if (sim.isIpad13) return [2064, 2752];
  return null;
}

// Same math as the Swift tool's search crop.
function searchSize(w, h) {
  const cropH = Math.floor(Math.min(h, (w * 2) / 3) / 4) * 4;
  const outW = Math.min(Math.max((cropH * 3) / 2, 1920), 3840);
  return `${outW}x${(outW * 2) / 3}`;
}

// ---------- provider ----------

class JohnnyGrabProvider {
  constructor(context) {
    this._context = context;
    this._view = null;
    this._sims = [];
    this._overridden = new Set();
    this._busy = false;
    this._results = [];
    this._toolPromise = null;
    this._toolKey = '';
    this._recorder = null;
    this._viewDisposables = [];
    this._output = vscode.window.createOutputChannel('JohnnyGrab');
    this._storage = context.globalStorageUri.fsPath;
    this._thumbs = path.join(this._storage, 'thumbs');
    this._temp = path.join(os.tmpdir(), 'johnnygrab');
    context.subscriptions.push(this._output);
    context.subscriptions.push(
      vscode.workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration('johnnygrab')) this._pushState();
      })
    );
  }

  // ----- temp files and leftover recorders -----

  // Each capture gets its own folder, named after this extension host's pid, so other
  // VS Code windows can tell which folders are still in use.
  _newRunDir() {
    this._cleanTemp();
    const dir = path.join(this._temp, `run-${process.pid}-${Date.now()}`);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  // Deletes everything in the temp folder from earlier runs: this host's finished runs,
  // runs of hosts that are gone, and stray files. Folders of other live windows are kept
  // unless they are over an hour old.
  _cleanTemp(keep) {
    let entries = [];
    try { entries = fs.readdirSync(this._temp); } catch { return; }
    for (const name of entries) {
      const full = path.join(this._temp, name);
      if (keep && full === keep) continue;
      const m = /^run-(\d+)-(\d+)$/.exec(name);
      if (m && Number(m[1]) !== process.pid && isAlive(Number(m[1])) && Date.now() - Number(m[2]) < 3600000) continue;
      try { fs.rmSync(full, { recursive: true, force: true }); } catch { /* in use */ }
    }
  }

  // On activate: stop any simctl recordVideo still writing into our temp folder for a host
  // that no longer exists (for example after the extension host crashed mid-recording).
  async killOrphanRecorders() {
    let stdout = '';
    try {
      ({ stdout } = await run('/bin/ps', ['-axo', 'pid=,command=']));
    } catch {
      return;
    }
    const orphans = [];
    for (const line of stdout.split('\n')) {
      const m = /^\s*(\d+)\s+(.*)$/.exec(line);
      if (!m || !/recordVideo/.test(m[2]) || !m[2].includes(this._temp + path.sep)) continue;
      const owner = /run-(\d+)-\d+/.exec(m[2]);
      if (owner && Number(owner[1]) !== process.pid && isAlive(Number(owner[1]))) continue;
      orphans.push(Number(m[1]));
    }
    for (const pid of orphans) {
      try { process.kill(pid, 'SIGINT'); } catch { /* already gone */ }
    }
    if (orphans.length) {
      for (let i = 0; i < 20 && orphans.some(isAlive); i++) await sleep(250);
      for (const pid of orphans.filter(isAlive)) {
        try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
      }
      this._log(`Stopped ${orphans.length} leftover recorder process(es): ${orphans.join(', ')}`);
    }
    this._cleanTemp();
  }

  // Called from deactivate(): stop a recording in progress and remove its temp files.
  async dispose() {
    const rec = this._recorder;
    this._recorder = null;
    if (rec) {
      rec.disposed = true;
      try { rec.child.kill('SIGINT'); } catch { /* already gone */ }
      if (!(await waitForExit(rec.child, 3000))) {
        try { rec.child.kill('SIGKILL'); } catch { /* already gone */ }
      }
      try { fs.rmSync(rec.dir, { recursive: true, force: true }); } catch { /* best effort */ }
    }
    for (const d of this._viewDisposables) d.dispose();
    this._viewDisposables = [];
  }

  // ----- persisted UI state -----

  _get(key, def) {
    return this._context.globalState.get(key, def);
  }

  _set(key, value) {
    return this._context.globalState.update(key, value);
  }

  _outputFolder() {
    const configured = vscode.workspace.getConfiguration('johnnygrab').get('outputFolder') || '~/Desktop';
    return expandHome(configured.trim());
  }

  _selectedSim() {
    const udid = this._get('selectedUdid');
    return this._sims.find(s => s.udid === udid) || this._sims[0] || null;
  }

  _lengths() {
    const saved = this._get('lengths', {});
    const out = {};
    for (const [kind, r] of Object.entries(LENGTHS)) {
      const v = Number(saved[kind]);
      out[kind] = Number.isFinite(v) ? Math.min(r.max, Math.max(r.min, Math.round(v))) : r.def;
    }
    return out;
  }

  // ----- webview -----

  resolveWebviewView(webviewView) {
    this._view = webviewView;
    fs.mkdirSync(this._thumbs, { recursive: true });
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.file(this._thumbs)]
    };
    webviewView.webview.html = this._getHtml(webviewView.webview);

    // A view can be resolved again after it is disposed: drop the old view's listeners first.
    for (const d of this._viewDisposables) d.dispose();
    this._viewDisposables = [
      webviewView.webview.onDidReceiveMessage(message => this._onMessage(message)),
      webviewView.onDidChangeVisibility(() => {
        if (webviewView.visible) this._refresh();
      }),
      webviewView.onDidDispose(() => {
        if (this._view === webviewView) this._view = null;
        for (const d of this._viewDisposables) d.dispose();
        this._viewDisposables = [];
      })
    ];
  }

  async _onMessage(message) {
    // While a capture runs, only Open and Reveal (on result cards) are allowed.
    if (this._busy && !['ready', 'open', 'reveal'].includes(message.command)) {
      this._pushState();
      return;
    }
    try {
      switch (message.command) {
        case 'ready':
        case 'refresh':
          await this._refresh();
          break;
        case 'selectSim':
          await this._set('selectedUdid', message.udid);
          this._pushState();
          break;
        case 'duoPanel':
          await this._set('duoPanel', message.value === 'closed' ? 'closed' : 'open');
          this._pushState();
          break;
        case 'appName':
          await this._set('appName', message.value);
          this._pushState();
          break;
        case 'clean':
          await this._set('cleanStatusBar', !!message.value);
          break;
        case 'orientation':
          await this._set('orientation', message.value);
          break;
        case 'length': {
          const lengths = this._lengths();
          lengths[message.kind] = message.value;
          await this._set('lengths', lengths);
          this._pushState();
          break;
        }
        case 'browse':
          await this._browse();
          break;
        case 'showFolder':
          await this._showFolder();
          break;
        case 'resetStatusBar':
          await this._resetStatusBar();
          break;
        case 'record':
          await this._record(message.kind);
          break;
        case 'screenshots':
          await this._screenshots();
          break;
        case 'open':
          await vscode.env.openExternal(vscode.Uri.file(message.path));
          break;
        case 'reveal':
          await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(message.path));
          break;
      }
    } catch (err) {
      this._log(`Error: ${err.stack || err.message}`);
      vscode.window.showErrorMessage(`JohnnyGrab: ${err.message}`);
    }
  }

  async _refresh() {
    try {
      const { stdout } = await run(XCRUN, ['simctl', 'list', 'devices', 'booted', '-j']);
      const parsed = JSON.parse(stdout);
      const sims = [];
      for (const [runtime, devices] of Object.entries(parsed.devices || {})) {
        for (const d of devices) {
          if (d.state === 'Booted') sims.push(classify({ ...d, runtime }));
        }
      }
      sims.sort((a, b) => a.name.localeCompare(b.name));
      this._sims = sims;
    } catch (err) {
      this._sims = [];
      this._log(`simctl list failed: ${err.stderr || err.message}`);
    }
    this._pushState();
  }

  _checklist() {
    const folder = this._outputFolder();
    const app = safeName(this._get('appName', '')).toLowerCase();
    let files = [];
    try { files = fs.readdirSync(folder).map(f => f.toLowerCase()); } catch { /* folder missing */ }
    return CHECKLIST.map(item => ({
      id: item.id,
      label: item.label,
      done: files.some(f => f.startsWith(`${app}-${item.kind}-`) && item.sizes.some(s => f.startsWith(`${app}-${item.kind}-${s}-`)) && /\.(png|jpe?g)$/.test(f))
    }));
  }

  _pushState() {
    if (!this._view) return;
    const sim = this._selectedSim();
    const duoPanel = this._get('duoPanel', 'open');
    const size = screenSize(sim, duoPanel);
    const previewSizes = sim && sim.isIpad ? ['1600x1200', '1200x1600'] : ['1920x886', '886x1920'];
    const sizes = {
      header: '3840x1646',
      search: size ? `${searchSize(size[0], size[1])} portrait, ${searchSize(size[1], size[0])} landscape` : '3:2, 1920x1280 to 3840x2560',
      preview: `${previewSizes[1]} portrait, ${previewSizes[0]} landscape`
    };
    const warnings = [];
    if (!this._sims.some(s => s.isProMax)) warnings.push('No iPhone Pro Max simulator is booted.');
    if (!this._sims.some(s => s.isIpad13)) warnings.push('No iPad 13" simulator is booted.');
    this._view.webview.postMessage({
      command: 'state',
      sims: this._sims.map(s => ({ udid: s.udid, name: s.name, isDuo: s.isDuo })),
      selected: sim ? sim.udid : '',
      duoPanel,
      appName: this._get('appName', ''),
      outputFolder: this._outputFolder(),
      clean: this._get('cleanStatusBar', true),
      orientation: this._get('orientation', 'auto'),
      lengths: this._lengths(),
      ranges: LENGTHS,
      sizes,
      checklist: this._checklist(),
      warnings,
      busy: this._busy,
      results: this._results.map(r => ({
        ...r,
        thumbUri: r.thumb ? this._view.webview.asWebviewUri(vscode.Uri.file(r.thumb)).toString() : ''
      }))
    });
  }

  _log(line) {
    this._output.appendLine(`[${new Date().toLocaleTimeString()}] ${line}`);
  }

  // ----- output folder -----

  async _browse() {
    const picked = await vscode.window.showOpenDialog({
      canSelectFiles: false,
      canSelectFolders: true,
      canSelectMany: false,
      defaultUri: vscode.Uri.file(this._outputFolder()),
      openLabel: 'Use This Folder'
    });
    if (!picked || !picked.length) return;
    await vscode.workspace.getConfiguration('johnnygrab').update('outputFolder', picked[0].fsPath, vscode.ConfigurationTarget.Global);
    this._pushState();
  }

  async _showFolder() {
    const folder = this._outputFolder();
    if (!fs.existsSync(folder)) throw new Error(`Output folder does not exist: ${folder}`);
    await vscode.env.openExternal(vscode.Uri.file(folder));
  }

  // ----- status bar -----

  async _overrideStatusBar(sim) {
    if (!this._get('cleanStatusBar', true)) return;
    const time = statusBarTime(vscode.workspace.getConfiguration('johnnygrab').get('statusBarTime'));
    try {
      await run(XCRUN, ['simctl', 'status_bar', sim.udid, 'override', '--time', time, ...STATUS_BAR_FLAGS]);
      this._overridden.add(sim.udid);
    } catch (err) {
      throw new Error(`Status bar override failed on ${sim.name} (time "${time}"): ${(err.stderr || err.message).trim()}`);
    }
  }

  async _resetStatusBar() {
    const targets = new Set(this._overridden);
    const sim = this._selectedSim();
    if (sim) targets.add(sim.udid);
    for (const udid of targets) {
      if (!this._sims.some(s => s.udid === udid)) continue;
      await run(XCRUN, ['simctl', 'status_bar', udid, 'clear']);
      this._overridden.delete(udid);
    }
    vscode.window.showInformationMessage(`JohnnyGrab: Status bar reset on ${targets.size} simulator${targets.size === 1 ? '' : 's'}.`);
  }

  // ----- Swift tool -----

  // Rebuilds when the Swift source changes (checked by mtime and size on every use, then by hash).
  ensureTool() {
    const source = this._toolSource();
    let key = '';
    try {
      const st = fs.statSync(source);
      key = `${st.mtimeMs}:${st.size}`;
    } catch { /* reported by _buildTool */ }
    if (!this._toolPromise || key !== this._toolKey) {
      this._toolKey = key;
      this._toolPromise = this._buildTool().catch(err => {
        this._toolPromise = null;
        throw err;
      });
    }
    return this._toolPromise;
  }

  _toolSource() {
    return path.join(this._context.extensionPath, 'swift', 'johnnygrab-tool.swift');
  }

  async _buildTool() {
    const source = this._toolSource();
    const bin = path.join(this._storage, 'johnnygrab-tool');
    const hashFile = `${bin}.sha256`;
    const hash = crypto.createHash('sha256').update(fs.readFileSync(source)).digest('hex');
    fs.mkdirSync(this._storage, { recursive: true });
    if (fs.existsSync(bin) && fs.existsSync(hashFile) && fs.readFileSync(hashFile, 'utf8') === hash) return bin;

    const tmpBin = `${bin}.building`;
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'JohnnyGrab: Compiling the Swift helper...' },
      async () => {
        try {
          await run(XCRUN, ['swiftc', '-O', '-o', tmpBin, source], { cwd: this._storage });
        } catch (err) {
          removeQuietly(tmpBin);
          const detail = (err.stderr || err.message || '').trim();
          this._log(`swiftc failed:\n${detail}`);
          this._output.show(true);
          throw new Error('Could not compile the Swift helper. See the JohnnyGrab output panel for the compiler errors.');
        }
      }
    );
    fs.renameSync(tmpBin, bin);
    fs.writeFileSync(hashFile, hash);
    this._log(`Compiled helper: ${bin}`);
    return bin;
  }

  // Runs a helper subcommand. Cancelling the token kills the helper and throws CancelledError.
  async _tool(args, token) {
    const bin = await this.ensureTool();
    this._log(`tool ${args.join(' ')}`);
    let stdout;
    try {
      ({ stdout } = await run(bin, args, {}, token));
    } catch (err) {
      if (err.cancelled) throw err;
      stdout = err.stdout || '';
      if (!stdout.trim()) throw new Error((err.stderr || err.message).trim());
    }
    const line = stdout.trim().split('\n').pop();
    let result;
    try {
      result = JSON.parse(line);
    } catch {
      throw new Error(`Helper returned unexpected output: ${line}`);
    }
    if (!result.ok) throw new Error(result.error || 'helper failed');
    return result;
  }

  async _makeThumb(file, token, name) {
    fs.mkdirSync(this._thumbs, { recursive: true });
    const base = name || path.basename(file).replace(/\.[^.]+$/, '');
    const out = path.join(this._thumbs, `${base}-${Date.now()}.jpg`);
    try {
      await this._tool(['thumb', file, out], token);
      return out;
    } catch (err) {
      removeQuietly(out);
      if (err.cancelled) throw err;
      this._log(`thumbnail failed: ${err.message}`);
      return '';
    }
  }

  // Only thumbnails older than a day are removed, so other windows' result cards keep theirs.
  _pruneThumbs() {
    try {
      const keep = new Set(this._results.map(r => r.thumb));
      const cutoff = Date.now() - 24 * 3600 * 1000;
      for (const f of fs.readdirSync(this._thumbs)) {
        const full = path.join(this._thumbs, f);
        if (keep.has(full)) continue;
        try {
          if (fs.statSync(full).mtimeMs < cutoff) removeQuietly(full);
        } catch { /* gone */ }
      }
    } catch { /* nothing to prune */ }
  }

  _setResults(results) {
    this._results = results;
    this._pruneThumbs();
    this._pushState();
  }

  _ensureOutputFolder() {
    const folder = this._outputFolder();
    if (!fs.existsSync(folder)) throw new Error(`Output folder does not exist: ${folder}. Choose one with Browse...`);
    return folder;
  }

  async _withBusy(task) {
    if (this._busy) {
      vscode.window.showWarningMessage('JohnnyGrab: Already working on a capture.');
      return;
    }
    this._busy = true;
    this._pushState();
    try {
      await task();
    } finally {
      this._busy = false;
      this._pushState();
    }
  }

  // Waits johnnygrab.captureDelay seconds so the app can settle. Returns false if cancelled.
  async _countdown(progress, token) {
    const delay = Math.max(0, Math.min(30, Math.round(Number(vscode.workspace.getConfiguration('johnnygrab').get('captureDelay', 3)) || 0)));
    for (let s = delay; s > 0; s--) {
      if (token && token.isCancellationRequested) return false;
      progress.report({ message: `Starting in ${s}…` });
      await sleep(1000);
    }
    return !(token && token.isCancellationRequested);
  }

  // Screenshots one display into `dir` and runs the black check. Returns true when black.
  async _isDisplayBlack(sim, display, dir, token) {
    const raw = path.join(dir, `probe-${display}.png`);
    const flat = path.join(dir, `probe-${display}-flat.png`);
    try {
      await run(XCRUN, ['simctl', 'io', sim.udid, 'screenshot', '--type=png', `--display=${display}`, raw], {}, token);
      const result = await this._tool(['shot', raw, flat], token);
      return !!result.black;
    } finally {
      removeQuietly(raw);
      removeQuietly(flat);
    }
  }

  // ----- video -----

  async _record(kind) {
    if (!LENGTHS[kind]) return;
    // The list can be stale: a simulator may have shut down since the last refresh.
    const wanted = this._get('selectedUdid');
    await this._refresh();
    const sim = this._selectedSim();
    if (!sim) throw new Error('No booted simulator. Boot one in Simulator, then press Refresh.');
    if (wanted && sim.udid !== wanted) {
      await this._set('selectedUdid', sim.udid);
      this._pushState();
      throw new Error(`The selected simulator is no longer running. ${sim.name} is now selected: check it and press Record again.`);
    }
    await this._withBusy(async () => {
      const folder = this._ensureOutputFolder();
      await this.ensureTool();
      const seconds = this._lengths()[kind];
      const app = safeName(this._get('appName', ''));
      const dir = this._newRunDir();
      const raw = path.join(dir, 'raw.mov');
      const exported = path.join(dir, 'export.mp4');
      const label = { header: 'Header', search: 'Search Results', preview: 'App Preview' }[kind];
      const notes = [];

      try {
        await this._overrideStatusBar(sim);
        const saved = await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: `JohnnyGrab: ${label} video`, cancellable: true },
          async (progress, token) => {
            try {
              // On a Duo only the showing panel has a picture. Record the chosen panel if it is
              // lit, otherwise switch to the other one; stop if both are black.
              let panel = this._get('duoPanel', 'open');
              if (sim.isDuo) {
                progress.report({ message: 'Checking the Duo panel...' });
                const other = panel === 'open' ? 'closed' : 'open';
                const display = p => (p === 'closed' ? 1 : 3);
                if (await this._isDisplayBlack(sim, display(panel), dir, token)) {
                  if (await this._isDisplayBlack(sim, display(other), dir, token)) {
                    throw new Error('Both Duo panels are black. Make sure the Duo is showing in Simulator.');
                  }
                  notes.push(`The Duo is ${other}: recorded the ${other === 'open' ? 'Open' : 'Closed'} panel instead`);
                  panel = other;
                  await this._set('duoPanel', panel);
                  this._pushState();
                }
              }

              if (!(await this._countdown(progress, token))) return false;
              const recorded = await this._recordRaw(sim, panel, raw, seconds, dir, progress, token);
              if (!recorded) return false;
              progress.report({ message: 'Exporting...' });
              const args = ['video', raw, exported, kind, String(seconds)];
              if (kind === 'preview') args.push('--target', sim.isIpad ? 'ipad' : 'iphone');
              const result = await this._tool(args, token);
              const info = await this._tool(['info', exported], token);
              const base = `${app}-${kind}-${result.width}x${result.height}-${stamp()}`;
              const thumb = await this._makeThumb(exported, token, base);
              if (thumb) {
                const check = await this._tool(['shot', thumb, path.join(dir, 'thumb-check.png')], token);
                if (check.black) notes.push('the exported video looks black at 1 s');
              }
              if (token.isCancellationRequested) {
                removeQuietly(thumb);
                return false;
              }
              const final = uniquePath(folder, base, 'mp4');
              moveFile(exported, final);
              this._log(`Saved ${final} (recorded ${result.recorded}, crop ${result.crop})`);
              this._setResults([{
                path: final,
                name: path.basename(final),
                thumb,
                size: `${info.width}x${info.height}`,
                length: `${Number(info.duration).toFixed(2)} s`,
                fps: info.frameCount && info.duration ? `${Math.round(info.frameCount / info.duration)} fps` : `${Math.round(info.nominalFps)} fps`,
                label: sim.isDuo ? `${sim.name} (${panel})` : sim.name,
                video: true
              }]);
              return true;
            } catch (err) {
              if (err.cancelled) return false;
              throw err;
            }
          }
        );
        if (saved) {
          const message = `JohnnyGrab: Saved ${label} video${notes.length ? ` (${notes.join('; ')})` : ''}.`;
          if (notes.some(n => /black/.test(n))) vscode.window.showWarningMessage(message);
          else vscode.window.showInformationMessage(message);
        } else {
          vscode.window.showInformationMessage(`JohnnyGrab: ${label} video cancelled. Nothing was saved.`);
        }
      } finally {
        this._cleanTemp();
      }
    });
  }

  // Records `seconds` + 2 s after simctl reports "Recording started" (the export keeps the
  // first `seconds`), then stops with SIGINT (like Ctrl-C) so the movie is finalized.
  // The child is tracked in this._recorder so deactivate() can stop it.
  _recordRaw(sim, panel, file, seconds, dir, progress, token) {
    return new Promise((resolve, reject) => {
      const total = seconds + 2;
      const args = ['simctl', 'io', sim.udid, 'recordVideo', '--codec=h264', '--force'];
      if (sim.isDuo) args.push(`--display=${panel === 'closed' ? 1 : 3}`);
      args.push(file);
      this._log(`xcrun ${args.join(' ')}`);
      const child = cp.spawn(XCRUN, args);
      const rec = { child, dir, disposed: false };
      this._recorder = rec;
      let stderr = '';
      let timer = null;
      let startTimeout = null;
      let cancelled = false;
      let stopping = false;

      const stop = () => {
        if (stopping) return;
        stopping = true;
        clearInterval(timer);
        clearTimeout(startTimeout);
        child.kill('SIGINT');
        // If simctl does not finish within 30 s, force it.
        setTimeout(() => child.kill('SIGKILL'), 30000).unref();
      };

      const startCounting = () => {
        if (timer) return;
        clearTimeout(startTimeout);
        const started = Date.now();
        progress.report({ message: `Recording… 0 s of ${seconds}` });
        timer = setInterval(() => {
          const elapsed = Math.floor((Date.now() - started) / 1000);
          if (elapsed >= total) {
            progress.report({ message: 'Finishing recording…' });
            stop();
          } else {
            progress.report({ message: `Recording… ${Math.min(elapsed, seconds)} s of ${seconds}` });
          }
        }, 250);
      };

      child.stderr.on('data', chunk => {
        stderr += chunk.toString();
        if (/Recording started/.test(stderr)) startCounting();
      });
      child.on('error', err => {
        clearInterval(timer);
        if (this._recorder === rec) this._recorder = null;
        reject(err);
      });
      child.on('exit', (code, signal) => {
        clearInterval(timer);
        clearTimeout(startTimeout);
        if (this._recorder === rec) this._recorder = null;
        this._log(`recordVideo exited (code ${code}, signal ${signal})\n${stderr.trim()}`);
        if (cancelled || rec.disposed) return resolve(false);
        if (!stopping) return reject(new Error(`recordVideo stopped early: ${stderr.trim() || `exit code ${code}`}`));
        if (!fs.existsSync(file)) return reject(new Error(`recordVideo wrote no file: ${stderr.trim()}`));
        resolve(true);
      });

      token.onCancellationRequested(() => {
        cancelled = true;
        stop();
      });
      progress.report({ message: 'Starting recording…' });
      // If "Recording started" never shows, start counting anyway after 10 s.
      startTimeout = setTimeout(startCounting, 10000);
    });
  }

  // ----- screenshots -----

  async _screenshots() {
    await this._refresh();
    if (!this._sims.length) throw new Error('No booted simulator. Boot one in Simulator, then press Refresh.');
    const missing = [];
    if (!this._sims.some(s => s.isProMax)) missing.push('iPhone Pro Max');
    if (!this._sims.some(s => s.isIpad13)) missing.push('iPad 13"');
    if (missing.length) {
      vscode.window.showWarningMessage(`JohnnyGrab: ${missing.join(' and ')} not booted. App Store Connect needs both screenshot sizes.`);
    }

    await this._withBusy(async () => {
      const folder = this._ensureOutputFolder();
      await this.ensureTool();
      const app = safeName(this._get('appName', ''));
      const orientation = this._get('orientation', 'auto');
      const dir = this._newRunDir();
      const results = [];
      const problems = [];

      try {
        await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: 'JohnnyGrab: Screenshots', cancellable: true },
          async (progress, token) => {
            if (!(await this._countdown(progress, token))) {
              problems.push('Cancelled before capture.');
              return;
            }
            for (const sim of this._sims) {
              progress.report({ message: sim.name });
              try {
                await this._overrideStatusBar(sim);
                const displays = sim.isDuo ? [{ n: 1, kind: 'duo-closed' }, { n: 3, kind: 'duo-open' }] : [{ n: null, kind: sim.isIpad ? 'ipad' : 'iphone' }];
                const kept = [];
                for (const d of displays) {
                  const raw = path.join(dir, `shot-${Date.now()}-${d.n || 0}.png`);
                  const flat = path.join(dir, `flat-${Date.now()}-${d.n || 0}.png`);
                  try {
                    const args = ['simctl', 'io', sim.udid, 'screenshot', '--type=png'];
                    if (d.n) args.push(`--display=${d.n}`);
                    args.push(raw);
                    await run(XCRUN, args);
                    const before = await this._tool(['info', raw]);
                    const rotate = this._rotationFor(sim, orientation, before);
                    const shotArgs = ['shot', raw, flat];
                    if (rotate) shotArgs.push('--rotate', rotate);
                    const result = await this._tool(shotArgs);
                    // The black check only chooses between the two Duo panels.
                    // iPhone and iPad captures are always kept.
                    if (sim.isDuo && result.black) {
                      this._log(`${sim.name} display ${d.n}: black, skipped`);
                      continue;
                    }
                    const final = uniquePath(folder, `${app}-${d.kind}-${result.width}x${result.height}-${stamp()}`, 'png');
                    moveFile(flat, final);
                    kept.push(final);
                    results.push({
                      path: final,
                      name: path.basename(final),
                      thumb: await this._makeThumb(final),
                      size: `${result.width}x${result.height}`,
                      label: sim.isDuo ? `${sim.name} (${d.kind === 'duo-open' ? 'open' : 'closed'})` : sim.name,
                      video: false
                    });
                  } finally {
                    removeQuietly(raw);
                    removeQuietly(flat);
                  }
                }
                if (!kept.length) problems.push(`${sim.name}: both Duo panels were black`);
              } catch (err) {
                this._log(`${sim.name}: ${err.message}`);
                problems.push(`${sim.name}: ${err.message}`);
              }
            }
          }
        );
      } finally {
        this._cleanTemp();
      }

      this._setResults(results);
      if (problems.length) {
        vscode.window.showWarningMessage(`JohnnyGrab: ${problems.join('; ')}`);
      } else {
        vscode.window.showInformationMessage(`JohnnyGrab: Saved ${results.length} screenshot${results.length === 1 ? '' : 's'}.`);
      }
    });
  }

  // Duo shots are kept as captured. iPhone/iPad shots are only turned when "Landscape" is
  // chosen and the capture came out portrait.
  _rotationFor(sim, orientation, info) {
    if (sim.isDuo || orientation === 'auto') return null;
    if (info.width > info.height) return null;
    return orientation === 'landscape-right' ? 'right' : 'left';
  }

  _getHtml(webview) {
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource}; script-src 'unsafe-inline'; style-src 'unsafe-inline';">
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }

  body {
    padding: 8px;
    background: var(--vscode-sideBar-background);
    color: var(--vscode-foreground);
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
  }

  h3 {
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--vscode-descriptionForeground);
    margin: 12px 0 6px;
  }

  h3:first-child { margin-top: 0; }

  .row {
    display: flex;
    gap: 6px;
    align-items: center;
    margin-bottom: 6px;
  }

  .row > .grow { flex: 1; min-width: 0; }

  select, input[type="text"], input[type="number"] {
    width: 100%;
    background: var(--vscode-input-background);
    color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border, transparent);
    padding: 4px 6px;
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    border-radius: 2px;
    outline: none;
  }

  select:focus, input:focus { border-color: var(--vscode-focusBorder); }

  input[type="number"] { width: 52px; text-align: center; }

  label.check {
    display: flex;
    gap: 6px;
    align-items: center;
    cursor: pointer;
    margin-bottom: 6px;
  }

  button {
    padding: 4px 10px;
    cursor: pointer;
    border: none;
    border-radius: 2px;
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    background: var(--vscode-button-secondaryBackground);
    color: var(--vscode-button-secondaryForeground);
    white-space: nowrap;
  }

  button:hover { background: var(--vscode-button-secondaryHoverBackground); }

  button.primary {
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
  }

  button.primary:hover { background: var(--vscode-button-hoverBackground); }

  button:disabled { opacity: 0.5; cursor: default; }

  .segmented { display: flex; }
  .segmented button { flex: 1; border-radius: 0; }
  .segmented button:first-child { border-radius: 2px 0 0 2px; }
  .segmented button:last-child { border-radius: 0 2px 2px 0; }
  .segmented button.on {
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
  }

  .folder {
    font-size: 11px;
    color: var(--vscode-descriptionForeground);
    word-break: break-all;
    margin-bottom: 6px;
  }

  .action {
    border: 1px solid var(--vscode-panel-border, rgba(128, 128, 128, 0.35));
    border-radius: 3px;
    padding: 6px;
    margin-bottom: 6px;
  }

  .action .title { font-weight: 600; }
  .action .size { font-size: 11px; color: var(--vscode-descriptionForeground); margin: 2px 0 6px; }
  .action .row { margin-bottom: 0; }
  .action button.primary { flex: 1; }
  .unit { font-size: 11px; color: var(--vscode-descriptionForeground); }

  .checklist div { margin-bottom: 3px; }
  .checklist .done { color: var(--vscode-testing-iconPassed, #73c991); }
  .checklist .todo { color: var(--vscode-descriptionForeground); }

  .warning {
    background: var(--vscode-inputValidation-warningBackground, rgba(255, 200, 0, 0.1));
    border: 1px solid var(--vscode-inputValidation-warningBorder, rgba(255, 200, 0, 0.5));
    padding: 4px 6px;
    border-radius: 2px;
    margin: 4px 0;
    font-size: 11px;
  }

  .card {
    border: 1px solid var(--vscode-panel-border, rgba(128, 128, 128, 0.35));
    border-radius: 3px;
    padding: 6px;
    margin-bottom: 6px;
  }

  .card img { width: 100%; max-height: 220px; object-fit: contain; background: #000; display: block; margin-bottom: 4px; }
  .card .name { font-size: 11px; word-break: break-all; margin-bottom: 2px; }
  .card .meta { font-size: 11px; color: var(--vscode-descriptionForeground); margin-bottom: 6px; }

  .hidden { display: none !important; }
</style>
</head>
<body>
<div id="controls">
<h3>Simulator</h3>
<div class="row">
  <select id="sim" class="grow"><option value="">No booted simulators</option></select>
  <button id="refresh" title="Refresh booted simulators">Refresh</button>
</div>
<div id="duoRow" class="row hidden">
  <span class="unit">Duo panel</span>
  <div class="segmented grow">
    <button id="duoOpen">Open</button>
    <button id="duoClosed">Closed</button>
  </div>
</div>

<h3>Output</h3>
<div class="row"><input id="appName" type="text" placeholder="App name (used in file names)"></div>
<div id="folder" class="folder"></div>
<div class="row">
  <button id="browse">Browse...</button>
  <button id="showFolder">Show in Finder</button>
</div>
<label class="check"><input id="clean" type="checkbox"> Clean status bar (9:41, full bars, charged)</label>
<div class="row"><button id="resetBar">Reset status bar</button></div>

<h3>Videos</h3>
<div id="actions"></div>

<h3>Screenshots</h3>
<div class="row">
  <span class="unit">iPhone/iPad</span>
  <select id="orientation" class="grow">
    <option value="auto">Keep as captured</option>
    <option value="landscape-left">Landscape, turn left if portrait</option>
    <option value="landscape-right">Landscape, turn right if portrait</option>
  </select>
</div>
<div class="row"><button id="shots" class="primary grow">Capture screenshots (all booted sims)</button></div>
<div id="checklist" class="checklist"></div>
<div id="warnings"></div>
</div>

<div id="resultsBox" class="hidden">
  <h3>Result</h3>
  <div id="results"></div>
</div>

<script>
  const vscode = acquireVsCodeApi();
  const KINDS = [
    { kind: 'header', title: 'Header video' },
    { kind: 'search', title: 'Search Results video' },
    { kind: 'preview', title: 'App Preview video' }
  ];
  const $ = id => document.getElementById(id);
  let state = null;

  // Build the three video actions once.
  const actions = $('actions');
  KINDS.forEach(k => {
    const box = document.createElement('div');
    box.className = 'action';
    box.innerHTML =
      '<div class="title"></div>' +
      '<div class="size"></div>' +
      '<div class="row">' +
      '<button class="minus" title="Shorter">-</button>' +
      '<input type="number" class="len">' +
      '<button class="plus" title="Longer">+</button>' +
      '<span class="unit">s</span>' +
      '<button class="primary go">Record</button>' +
      '</div>';
    box.querySelector('.title').textContent = k.title;
    box.dataset.kind = k.kind;
    const len = box.querySelector('.len');
    const set = v => {
      if (!state || state.busy) return;
      const r = state.ranges[k.kind];
      const clamped = Math.min(r.max, Math.max(r.min, Math.round(Number(v) || r.def)));
      len.value = clamped;
      vscode.postMessage({ command: 'length', kind: k.kind, value: clamped });
    };
    box.querySelector('.minus').addEventListener('click', () => set(Number(len.value) - 1));
    box.querySelector('.plus').addEventListener('click', () => set(Number(len.value) + 1));
    len.addEventListener('change', () => set(len.value));
    box.querySelector('.go').addEventListener('click', () => vscode.postMessage({ command: 'record', kind: k.kind }));
    actions.appendChild(box);
  });

  // Controls stay disabled until the first state message arrives.
  function setControlsDisabled(disabled) {
    document.querySelectorAll('#controls button, #controls input, #controls select').forEach(el => { el.disabled = disabled; });
  }
  setControlsDisabled(true);

  $('refresh').addEventListener('click', () => vscode.postMessage({ command: 'refresh' }));
  $('sim').addEventListener('change', e => vscode.postMessage({ command: 'selectSim', udid: e.target.value }));
  $('duoOpen').addEventListener('click', () => vscode.postMessage({ command: 'duoPanel', value: 'open' }));
  $('duoClosed').addEventListener('click', () => vscode.postMessage({ command: 'duoPanel', value: 'closed' }));
  $('appName').addEventListener('change', e => vscode.postMessage({ command: 'appName', value: e.target.value.trim() }));
  $('browse').addEventListener('click', () => vscode.postMessage({ command: 'browse' }));
  $('showFolder').addEventListener('click', () => vscode.postMessage({ command: 'showFolder' }));
  $('clean').addEventListener('change', e => vscode.postMessage({ command: 'clean', value: e.target.checked }));
  $('resetBar').addEventListener('click', () => vscode.postMessage({ command: 'resetStatusBar' }));
  $('orientation').addEventListener('change', e => vscode.postMessage({ command: 'orientation', value: e.target.value }));
  $('shots').addEventListener('click', () => vscode.postMessage({ command: 'screenshots' }));

  function render() {
    const s = state;
    const sim = $('sim');
    sim.innerHTML = '';
    if (!s.sims.length) {
      sim.innerHTML = '<option value="">No booted simulators</option>';
    } else {
      s.sims.forEach(d => {
        const opt = document.createElement('option');
        opt.value = d.udid;
        opt.textContent = d.name;
        sim.appendChild(opt);
      });
      sim.value = s.selected;
    }
    const current = s.sims.find(d => d.udid === s.selected);
    $('duoRow').classList.toggle('hidden', !(current && current.isDuo));
    $('duoOpen').classList.toggle('on', s.duoPanel === 'open');
    $('duoClosed').classList.toggle('on', s.duoPanel === 'closed');

    if (document.activeElement !== $('appName')) $('appName').value = s.appName;
    $('folder').textContent = s.outputFolder;
    $('clean').checked = s.clean;
    $('orientation').value = s.orientation;

    actions.querySelectorAll('.action').forEach(box => {
      const kind = box.dataset.kind;
      const r = s.ranges[kind];
      const len = box.querySelector('.len');
      len.min = r.min;
      len.max = r.max;
      if (document.activeElement !== len) len.value = s.lengths[kind];
      box.querySelector('.size').textContent = s.sizes[kind] + ' · ' + r.min + '-' + r.max + ' s';
    });
    // Every control is off while a capture runs; capture buttons also need a booted sim.
    setControlsDisabled(s.busy);
    actions.querySelectorAll('button, input').forEach(el => { el.disabled = s.busy || !s.sims.length; });
    $('shots').disabled = s.busy || !s.sims.length;

    const list = $('checklist');
    list.innerHTML = '';
    s.checklist.forEach(item => {
      const div = document.createElement('div');
      div.className = item.done ? 'done' : 'todo';
      div.textContent = (item.done ? '☑ ' : '☐ ') + item.label;
      list.appendChild(div);
    });

    const warnings = $('warnings');
    warnings.innerHTML = '';
    s.warnings.forEach(w => {
      const div = document.createElement('div');
      div.className = 'warning';
      div.textContent = w;
      warnings.appendChild(div);
    });

    const results = $('results');
    results.innerHTML = '';
    $('resultsBox').classList.toggle('hidden', !s.results.length);
    s.results.forEach(r => {
      const card = document.createElement('div');
      card.className = 'card';
      if (r.thumbUri) {
        const img = document.createElement('img');
        img.src = r.thumbUri;
        img.alt = r.name;
        card.appendChild(img);
      }
      const name = document.createElement('div');
      name.className = 'name';
      name.textContent = r.name;
      card.appendChild(name);
      const meta = document.createElement('div');
      meta.className = 'meta';
      meta.textContent = r.video ? (r.size + ' · ' + r.length + ' · ' + r.fps + (r.label ? ' · ' + r.label : '')) : (r.size + (r.label ? ' · ' + r.label : ''));
      card.appendChild(meta);
      const row = document.createElement('div');
      row.className = 'row';
      const open = document.createElement('button');
      open.textContent = 'Open';
      open.addEventListener('click', () => vscode.postMessage({ command: 'open', path: r.path }));
      const reveal = document.createElement('button');
      reveal.textContent = 'Reveal in Finder';
      reveal.addEventListener('click', () => vscode.postMessage({ command: 'reveal', path: r.path }));
      row.appendChild(open);
      row.appendChild(reveal);
      card.appendChild(row);
      results.appendChild(card);
    });
  }

  window.addEventListener('message', event => {
    if (event.data.command === 'state') {
      state = event.data;
      render();
    }
  });

  vscode.postMessage({ command: 'ready' });
</script>
</body>
</html>`;
  }
}

let provider = null;

function activate(context) {
  provider = new JohnnyGrabProvider(context);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('johnnygrab.view', provider, {
      webviewOptions: { retainContextWhenHidden: true }
    })
  );
  // Stop recorders left behind by an extension host that died mid-recording.
  provider.killOrphanRecorders().catch(() => {});
}

// Stops a recording in progress (SIGINT, short wait, then SIGKILL) and removes its temp files.
function deactivate() {
  const p = provider;
  provider = null;
  return p ? p.dispose() : undefined;
}

module.exports = { activate, deactivate };

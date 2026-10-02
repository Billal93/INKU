// Bibliothèque de sources : import multiple, analyse en arrière-plan (worker), persistance locale privée.
import { uid } from './edl.js';
import { srcGetAll, srcPut, srcDel, opfsRead, opfsRemove, opfsAvailable } from './storage.js';

const lowMemory = () => (navigator.deviceMemory && navigator.deviceMemory <= 4) || (navigator.hardwareConcurrency && navigator.hardwareConcurrency <= 4);

export class Library extends EventTarget {
  constructor() {
    super();
    this.sources = new Map();
    this.worker = null;
    this.memFiles = new Map();      // File/Blob gardés en mémoire quand l'OPFS est indisponible
    this.thumbUrls = new Map();     // id -> [blob URL | null]
    this.queue = [];                // tâches en attente (une seule tâche lourde à la fois)
    this.running = false;
    this.proxyHeight = lowMemory() ? 540 : 720;
  }

  emit(id) { this.dispatchEvent(new CustomEvent('change', { detail: { id } })); }
  get list() { return Array.from(this.sources.values()); }
  get(id) { return this.sources.get(id) || null; }

  async init() {
    const recs = await srcGetAll().catch(() => []);
    for (const r of recs) {
      const rec = this._hydrate(r);
      if (rec.status === 'analyzing' || rec.status === 'queued') { rec.status = 'error'; rec.error = 'Analyse interrompue — relancez-la'; }
      if (rec.proxy === 'building' || rec.proxy === 'queued') rec.proxy = 'none';
      this.sources.set(rec.id, rec);
    }
    this.emit(null);
  }

  _hydrate(r) {
    const rec = { ...r };
    const urls = (r.thumbs || []).map((b) => (b ? URL.createObjectURL(new Blob([b], { type: 'image/jpeg' })) : null));
    this.thumbUrls.set(r.id, urls);
    return rec;
  }

  _ensureWorker() {
    if (this.worker) return this.worker;
    const w = new Worker(new URL('./analysis.worker.js', import.meta.url), { type: 'module' });
    w.onmessage = (e) => this._onMsg(e.data);
    w.onerror = (e) => {
      console.error('[library] worker', e.message);
      for (const rec of this.sources.values()) if (rec.status === 'analyzing') { rec.status = 'error'; rec.error = 'Le worker d\'analyse a planté : ' + (e.message || 'erreur inconnue'); this.emit(rec.id); }
      this.worker = null; this.running = false; this._next();
    };
    this.worker = w;
    return w;
  }

  // Import multiple : retourne les identifiants (les doublons par empreinte sont signalés, pas recopiés).
  ingest(files) {
    const ids = [];
    for (const file of Array.from(files)) {
      const isMedia = /^(video|audio)\//.test(file.type) || /\.(mp4|mov|m4v|webm|mkv|mp3|wav|m4a|aac|ogg|flac)$/i.test(file.name);
      const id = uid('src');
      const rec = { id, name: file.name, kind: /^audio\//.test(file.type) ? 'audio' : 'video', size: file.size, status: isMedia ? 'queued' : 'error', stage: 'queued', progress: 0, proxy: 'none', shots: [], error: isMedia ? null : 'Ce type de fichier n\'est pas un média' };
      this.sources.set(id, rec);
      ids.push(id);
      if (isMedia) this.queue.push({ cmd: 'ingest', id, file });
      this.emit(id);
    }
    this._next();
    return ids;
  }

  async reanalyze(id) {
    const rec = this.sources.get(id);
    const file = await this.getFile(id, 'media');
    if (!rec || !file) return false;
    rec.status = 'queued'; rec.error = null; rec.progress = 0;
    this.queue.push({ cmd: 'ingest', id, file, skipCopy: !this.memFiles.has(id) });
    this.emit(id); this._next();
    return true;
  }

  _next() {
    if (this.running || !this.queue.length) return;
    const task = this.queue.shift();
    const rec = this.sources.get(task.id);
    if (!rec) { this._next(); return; }
    this.running = true;
    if (task.cmd === 'ingest') { rec.status = 'analyzing'; rec.stage = 'copy'; }
    if (task.cmd === 'proxy') { rec.proxy = 'building'; }
    this.emit(task.id);
    this._ensureWorker().postMessage(task);
  }

  async _onMsg(m) {
    const rec = m.id ? this.sources.get(m.id) : null;
    if (m.type === 'progress' && rec) {
      if (m.stage === 'proxy') rec.proxyProgress = m.progress; else { rec.stage = m.stage; rec.progress = m.progress; }
      this.emit(m.id); return;
    }
    if (m.type === 'ingested' && rec) {
      Object.assign(rec, m.meta, { status: 'ready', stage: 'done', progress: 1, error: null });
      if (m.shots) {
        rec.shots = m.shots;
        const urls = m.thumbs.map((b) => (b ? URL.createObjectURL(new Blob([b], { type: 'image/jpeg' })) : null));
        this.thumbUrls.set(rec.id, urls);
        rec.thumbs = m.thumbs;
      }
      if (m.scrub) rec.scrub = m.scrub;
      if (m.waveform) rec.waveform = m.waveform;
      if (m.file) this.memFiles.set(rec.id, m.file);
      await this._persist(rec);
      this.running = false;
      if (rec.kind === 'video') { rec.proxy = 'queued'; this.queue.push({ cmd: 'proxy', id: rec.id, height: this.proxyHeight, usable: rec.letterbox.usable, file: this.memFiles.get(rec.id) }); }
      this.emit(rec.id); this._next(); return;
    }
    if (m.type === 'proxied' && rec) {
      rec.proxy = 'ready'; rec.proxyHeight = m.height; rec.proxyProgress = 1;
      if (m.blob) this.memFiles.set('proxy:' + rec.id, m.blob);
      await this._persist(rec);
      this.running = false; this.emit(rec.id); this._next(); return;
    }
    if (m.type === 'error') {
      if (rec) {
        if (m.stage === 'proxy') { rec.proxy = 'error'; rec.proxyError = m.message; } else { rec.status = 'error'; rec.error = m.message; }
        this.emit(rec.id);
      }
      this.running = false; this._next();
    }
  }

  async _persist(rec) {
    const { thumbs, ...rest } = rec;
    try { await srcPut({ ...rest, thumbs: thumbs || null, waveform: rec.waveform || null }); } catch (e) { console.warn('[library] persistance', e); }
  }

  thumbUrl(id, shotIndex) { const u = this.thumbUrls.get(id); return (u && u[shotIndex]) || null; }

  // kind : 'media' (original) | 'proxy'. Retourne File/Blob ou null.
  async getFile(id, kind = 'media') {
    const mem = this.memFiles.get(kind === 'proxy' ? 'proxy:' + id : id);
    if (mem) return mem;
    return opfsRead(kind, id);
  }

  async remove(id) {
    const urls = this.thumbUrls.get(id) || [];
    urls.forEach((u) => u && URL.revokeObjectURL(u));
    this.thumbUrls.delete(id); this.memFiles.delete(id); this.memFiles.delete('proxy:' + id);
    this.sources.delete(id);
    await Promise.all([srcDel(id).catch(() => {}), opfsRemove('media', id), opfsRemove('proxy', id)]);
    this.emit(id);
  }

  get persistent() { return opfsAvailable(); }
}

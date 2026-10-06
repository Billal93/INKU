// Côté page : petite interface à promesses autour de speech.worker.js.
export class SpeechClient {
  constructor() {
    this.worker = new Worker(new URL('./speech.worker.js', import.meta.url), { type: 'module' });
    this.seq = 0;
    /** @type {Map<number, { resolve: Function, reject: Function, onProgress?: Function }>} */
    this.pending = new Map();
    this.worker.onmessage = (e) => {
      const { id, ok, result, error, progress } = e.data;
      const p = this.pending.get(id);
      if (!p) return;
      if (progress) { if (p.onProgress) p.onProgress(progress); return; }
      this.pending.delete(id);
      ok ? p.resolve(result) : p.reject(new Error(error));
    };
  }

  /** @param {string} op @param {object} [args] @param {Function} [onProgress] @param {Transferable[]} [transfer] */
  call(op, args = {}, onProgress, transfer = []) {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, onProgress });
      this.worker.postMessage({ id, op, ...args }, transfer);
    });
  }

  terminate() { this.worker.terminate(); for (const p of this.pending.values()) p.reject(new Error('arrêté')); this.pending.clear(); }
}

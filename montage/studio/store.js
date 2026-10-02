// Store : document (EDL) avec annuler/rétablir par instantanés, état d'interface séparé, abonnements.
// Historique plafonné (500 pas) et persistant (voir persist.js). Un « geste » (glisser) = un seul pas.

export function createStore(initialDoc, { maxHistory = 500 } = {}) {
  let doc = initialDoc;
  let undoStack = [];   // chaînes JSON des états précédents
  let redoStack = [];
  let drag = null;      // { before:string, label }
  const ui = { selection: [], playhead: 0, pxPerSec: 36, playing: false, inPoint: null, outPoint: null, multi: false, clipboardAttrs: null };
  const subs = new Set();
  let version = 0;

  const emit = (kind) => { version++; for (const fn of subs) { try { fn(kind); } catch (e) { console.error('[store]', e); } } };
  const snapshot = () => JSON.stringify(doc);
  const pushUndo = (s) => { undoStack.push(s); if (undoStack.length > maxHistory) undoStack.shift(); redoStack = []; };

  return {
    get doc() { return doc; },
    ui,
    get version() { return version; },
    subscribe(fn) { subs.add(fn); return () => subs.delete(fn); },

    // Modification atomique : un pas d'historique.
    commit(label, mutator) {
      if (drag) { mutator(doc); emit('doc'); return; } // dans un geste : pas d'instantané supplémentaire
      const before = snapshot();
      mutator(doc);
      if (snapshot() !== before) { pushUndo(before); emit('doc'); }
    },
    // Geste continu (glisser) : instantané au début, un seul pas à la fin si le document a changé.
    beginGesture(label) { if (!drag) drag = { before: snapshot(), label }; },
    endGesture() {
      if (!drag) return;
      const { before } = drag; drag = null;
      if (snapshot() !== before) pushUndo(before);
      emit('doc');
    },
    cancelGesture() {
      if (!drag) return;
      doc = JSON.parse(drag.before); drag = null; emit('doc');
    },
    get inGesture() { return !!drag; },
    notify(kind = 'ui') { emit(kind); },

    undo() {
      if (!undoStack.length) return false;
      redoStack.push(snapshot());
      doc = JSON.parse(undoStack.pop());
      ui.selection = ui.selection.filter((id) => doc.clips.some((c) => c.id === id));
      emit('doc'); return true;
    },
    redo() {
      if (!redoStack.length) return false;
      undoStack.push(snapshot());
      doc = JSON.parse(redoStack.pop());
      ui.selection = ui.selection.filter((id) => doc.clips.some((c) => c.id === id));
      emit('doc'); return true;
    },
    get canUndo() { return undoStack.length > 0; },
    get canRedo() { return redoStack.length > 0; },

    replaceDoc(next, { keepHistory = false } = {}) {
      doc = next; if (!keepHistory) { undoStack = []; redoStack = []; }
      ui.selection = []; emit('doc');
    },
    serialize() { return { doc: snapshot(), undo: undoStack.slice(-maxHistory), redo: redoStack.slice(-50), ui: { playhead: ui.playhead, pxPerSec: ui.pxPerSec } }; },
    restore(data) {
      doc = JSON.parse(data.doc);
      undoStack = data.undo || []; redoStack = data.redo || [];
      if (data.ui) { ui.playhead = data.ui.playhead || 0; ui.pxPerSec = data.ui.pxPerSec || ui.pxPerSec; }
      emit('doc');
    },
  };
}

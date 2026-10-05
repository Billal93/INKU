// Accès aux bibliothèques d'inférence embarquées (stockées compressées, voir tools/montage-vendor.mjs).
// À utiliser dans un worker. Le moteur WebAssembly d'ONNX Runtime (27 Mo, 7 Mo compressé) n'est décompressé
// qu'une fois par worker et partagé.

/** Fichier embarqué compressé (gzip) → Response du contenu décompressé. @param {string} rel relatif à ce fichier */
export async function gunzip(rel) {
  const resp = await fetch(new URL(rel, import.meta.url));
  if (!resp.ok) throw new Error('Bibliothèque introuvable : ' + rel);
  return new Response(resp.body.pipeThrough(new DecompressionStream('gzip')));
}

let wasmBinary = /** @type {Promise<ArrayBuffer> | null} */ (null);
/** Binaire WebAssembly d'ONNX Runtime (variante « asyncify », compatible WebGPU), décompressé une fois. */
export function ortWasmBinary() {
  wasmBinary ||= gunzip('../vendor/transformers/ort-wasm-simd-threaded.asyncify.wasm.gz').then((r) => r.arrayBuffer());
  return wasmBinary;
}

export const ORT_GLUE = new URL('../vendor/transformers/ort-wasm-simd-threaded.asyncify.mjs', import.meta.url).href;

/** Nombre de fils WebAssembly raisonnable (laisse un cœur à l'interface). */
export function wasmThreads() {
  return globalThis.crossOriginIsolated ? Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 2) - 1)) : 1;
}

let ortMod = /** @type {Promise<typeof import('onnxruntime-web')> | null} */ (null);
/** ONNX Runtime seul (modèles exécutés directement : VAD, FastConformer), configuré une fois. */
export function ort() {
  ortMod ||= (async () => {
    const m = /** @type {typeof import('onnxruntime-web')} */ (await import('../vendor/transformers/ort.webgpu.min.mjs'));
    m.env.wasm.wasmPaths = { mjs: ORT_GLUE };
    m.env.wasm.wasmBinary = await ortWasmBinary();
    m.env.wasm.numThreads = wasmThreads();
    return m;
  })();
  return ortMod;
}

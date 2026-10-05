// Génère montage/speech/models.json : pour chaque modèle d'IA, la révision Hugging Face FIGÉE, la liste exacte
// des fichiers, leur taille et leur SHA-256 (pris dans l'API pour les fichiers LFS, calculé sinon), la licence.
// L'application refuse tout fichier dont l'empreinte ne correspond pas.
// Usage : node tools/montage-models.mjs            (réseau : huggingface.co)
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';

const TJS = ['config.json', 'generation_config.json', 'preprocessor_config.json', 'tokenizer.json', 'tokenizer_config.json'];

/**
 * Modèles candidats (voir docs/decisions.md D18). `dtype` = précision par sous-modèle pour transformers.js.
 * @type {{id:string,label:string,repo:string,task:string,kind:string,license:string,dtype?:Record<string,string>,files:string[],lang?:string,wordTimestamps?:boolean}[]}
 */
const SPEC = [
  {
    id: 'whisper-turbo', label: 'Whisper large-v3-turbo (q4f16)', repo: 'onnx-community/whisper-large-v3-turbo_timestamped',
    task: 'asr', kind: 'whisper', license: 'MIT (OpenAI Whisper)', wordTimestamps: true,
    dtype: { encoder_model: 'q4f16', decoder_model_merged: 'q4f16' },
    files: [...TJS, 'onnx/encoder_model_q4f16.onnx', 'onnx/decoder_model_merged_q4f16.onnx'],
  },
  {
    id: 'whisper-medium', label: 'Whisper medium (q4f16)', repo: 'onnx-community/whisper-medium_timestamped',
    task: 'asr', kind: 'whisper', license: 'MIT (OpenAI Whisper)', wordTimestamps: true,
    dtype: { encoder_model: 'q4f16', decoder_model_merged: 'q4f16' },
    files: [...TJS, 'onnx/encoder_model_q4f16.onnx', 'onnx/decoder_model_merged_q4f16.onnx'],
  },
  {
    id: 'whisper-small', label: 'Whisper small (fp16 + q4f16)', repo: 'onnx-community/whisper-small_timestamped',
    task: 'asr', kind: 'whisper', license: 'MIT (OpenAI Whisper)', wordTimestamps: true,
    dtype: { encoder_model: 'fp16', decoder_model_merged: 'q4f16' },
    files: [...TJS, 'onnx/encoder_model_fp16.onnx', 'onnx/decoder_model_merged_q4f16.onnx'],
  },
  {
    id: 'moonshine-tiny-fr', label: 'Moonshine tiny français (fp16)', repo: 'onnx-community/moonshine-tiny-fr-ONNX',
    task: 'asr', kind: 'moonshine', license: 'MIT', lang: 'fr',
    dtype: { encoder_model: 'fp16', decoder_model_merged: 'fp16' },
    files: [...TJS, 'onnx/encoder_model_fp16.onnx', 'onnx/decoder_model_merged_fp16.onnx'],
  },
  {
    id: 'cohere-transcribe', label: 'Cohere Transcribe 03-2026 (q4f16)', repo: 'onnx-community/cohere-transcribe-03-2026-ONNX',
    task: 'asr', kind: 'cohere', license: 'Apache-2.0',
    dtype: { encoder_model: 'q4f16', decoder_model_merged: 'q4f16' },
    files: [...TJS, 'onnx/encoder_model_q4f16.onnx', 'onnx/encoder_model_q4f16.onnx_data', 'onnx/decoder_model_merged_q4f16.onnx', 'onnx/decoder_model_merged_q4f16.onnx_data'],
  },
  {
    id: 'silero-vad', label: 'Silero VAD v5 (fp32)', repo: 'onnx-community/silero-vad',
    task: 'vad', kind: 'silero', license: 'MIT', files: ['onnx/model.onnx'],
  },
];

/** @param {string} url */
async function getJson(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  return r.json();
}

const out = { generated: new Date().toISOString().slice(0, 10), models: /** @type {any[]} */ ([]) };
for (const m of SPEC) {
  const info = await getJson(`https://huggingface.co/api/models/${m.repo}?blobs=true`);
  const revision = info.sha;
  const sib = new Map(info.siblings.map((/** @type {any} */ s) => [s.rfilename, s]));
  const files = [];
  for (const path of m.files) {
    const s = sib.get(path);
    if (!s) { if (TJS.includes(path)) continue; throw new Error(`${m.repo}: ${path} absent`); }
    let sha256 = s.lfs && s.lfs.sha256, size = s.size;
    if (!sha256) {
      const buf = Buffer.from(await (await fetch(`https://huggingface.co/${m.repo}/resolve/${revision}/${path}`)).arrayBuffer());
      sha256 = createHash('sha256').update(buf).digest('hex'); size = buf.length;
    }
    files.push({ path, size, sha256 });
  }
  const totalMB = Math.round(files.reduce((a, f) => a + f.size, 0) / 1048576);
  out.models.push({ ...m, revision, files, totalMB, cardLicense: (info.cardData && info.cardData.license) || null });
  console.log(m.id.padEnd(20), revision.slice(0, 10), String(totalMB).padStart(5), 'Mo', files.length, 'fichiers');
}
writeFileSync(new URL('../montage/speech/models.json', import.meta.url), JSON.stringify(out, null, 1) + '\n');

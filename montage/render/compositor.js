// Compositeur WebGL2 unique pour l'APERÇU et l'EXPORT (même code, même résultat) : toute la composition est une
// fonction pure de l'image demandée. Espace de travail 1080×1920 (« unités de conception ») quelle que soit la
// résolution réelle du canevas (aperçu 540×960, export 1080×1920, brouillon…) : positions décimales, sous-pixel.
// Calques : fond (clip recadré en UN seul rééchantillonnage), calques plein cadre (retrait de fond noir avec
// décontamination, ou alpha), sprites transformés (sous-titres : texture suréchantillonnée + mipmaps trilinéaires).

const FULL_VS = `#version 300 es
in vec2 aPos;
uniform vec4 uCrop;   // u0, v0, u1, v1 en coordonnées texture (origine haut-gauche)
out vec2 vUv;
void main() {
  vec2 t = aPos * 0.5 + 0.5;
  vUv = vec2(mix(uCrop.x, uCrop.z, t.x), mix(uCrop.w, uCrop.y, t.y));
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

const FULL_FS = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uTex;
uniform int uMode;      // 0 opaque, 1 fond noir → alpha (luminosité, décontaminé), 2 alpha prémultiplié
uniform float uKeyLo, uKeyHi, uCover, uOpacity;
out vec4 outColor;
void main() {
  vec4 s = texture(uTex, vUv);
  if (uMode == 0) { outColor = vec4(s.rgb, 1.0); return; }
  if (uMode == 2) { outColor = s * uOpacity; return; }
  float a0 = max(s.r, max(s.g, s.b));
  if (uCover > 0.5) { outColor = vec4(s.rgb, 1.0); return; }
  float a = smoothstep(uKeyLo, uKeyHi, a0);
  vec3 c = s.rgb / max(a0, 1e-4);   // décontamination : on retire le noir mélangé avant de prémultiplier
  outColor = vec4(c * a, a) * uOpacity;
}`;

const SPRITE_VS = `#version 300 es
in vec2 aPos;               // coin du quad, 0..1
uniform vec2 uView;         // taille de l'espace de conception (1080, 1920)
uniform vec4 uDst;          // x, y du coin haut-gauche et largeur, hauteur (unités de conception, décimales)
uniform vec4 uSrc;          // rectangle source dans la texture (0..1)
out vec2 vUv;
void main() {
  vec2 p = uDst.xy + aPos * uDst.zw;
  vUv = uSrc.xy + aPos * uSrc.zw;
  gl_Position = vec4(p.x / uView.x * 2.0 - 1.0, 1.0 - p.y / uView.y * 2.0, 0.0, 1.0);
}`;

const SPRITE_FS = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uTex;
uniform float uOpacity;
out vec4 outColor;
void main() { outColor = texture(uTex, vUv) * uOpacity; }`;

function program(gl, vs, fs) {
  const mk = (type, src) => {
    const sh = gl.createShader(type);
    gl.shaderSource(sh, src); gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error('Shader : ' + gl.getShaderInfoLog(sh));
    return sh;
  };
  const p = gl.createProgram();
  gl.attachShader(p, mk(gl.VERTEX_SHADER, vs)); gl.attachShader(p, mk(gl.FRAGMENT_SHADER, fs));
  gl.bindAttribLocation(p, 0, 'aPos');
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error('Link : ' + gl.getProgramInfoLog(p));
  const u = {};
  const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
  for (let i = 0; i < n; i++) { const name = gl.getActiveUniform(p, i).name; u[name] = gl.getUniformLocation(p, name); }
  return { p, u };
}

export const DESIGN_W = 1080, DESIGN_H = 1920;

export class Compositor {
  /**
   * @param {HTMLCanvasElement | OffscreenCanvas} canvas
   * @param {number} width @param {number} height résolution réelle de rendu
   */
  constructor(canvas, width, height) {
    this.canvas = canvas; this.kind = 'webgl2';
    canvas.width = width; canvas.height = height;
    this.width = width; this.height = height;
    const gl = /** @type {WebGL2RenderingContext} */ (canvas.getContext('webgl2', {
      alpha: false, antialias: false, preserveDrawingBuffer: true, premultipliedAlpha: true, powerPreference: 'high-performance',
    }));
    if (!gl) throw new Error('WebGL2 indisponible');
    this.gl = gl;
    this.full = program(gl, FULL_VS, FULL_FS);
    this.sprite = program(gl, SPRITE_VS, SPRITE_FS);
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    this.quadFull = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadFull);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    this.quadUnit = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadUnit);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 1, 1, 1, 0, 0, 1, 0]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);   // alpha prémultiplié partout
    gl.viewport(0, 0, width, height);
    this.frameTex = this._newTex(false);
    /** @type {Map<string, { tex: WebGLTexture, w: number, h: number }>} */
    this.sprites = new Map();
  }

  _newTex(mip) {
    const gl = this.gl, t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, mip ? gl.LINEAR_MIPMAP_LINEAR : gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return t;
  }

  resize(width, height) {
    if (width === this.width && height === this.height) return;
    this.canvas.width = width; this.canvas.height = height; this.width = width; this.height = height;
    this.gl.viewport(0, 0, width, height);
  }

  begin() { const gl = this.gl; gl.clearColor(0, 0, 0, 1); gl.clear(gl.COLOR_BUFFER_BIT); }

  /**
   * Calque plein cadre. crop en px de la source (décimales permises).
   * @param {TexImageSource} src @param {{ x: number, y: number, w: number, h: number } | null} crop
   * @param {0|1|2} mode @param {{ lo?: number, hi?: number, cover?: boolean, opacity?: number, premultiply?: boolean }} [o]
   */
  drawFull(src, crop, mode, o = {}) {
    const gl = this.gl, { p, u } = this.full;
    const sw = /** @type {any} */ (src).displayWidth || /** @type {any} */ (src).width, sh = /** @type {any} */ (src).displayHeight || /** @type {any} */ (src).height;
    const c = crop || { x: 0, y: 0, w: sw, h: sh };
    gl.useProgram(p);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadFull); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.frameTex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, !!o.premultiply);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src);
    gl.uniform1i(u.uTex, 0);
    gl.uniform4f(u.uCrop, c.x / sw, c.y / sh, (c.x + c.w) / sw, (c.y + c.h) / sh);
    gl.uniform1i(u.uMode, mode);
    gl.uniform1f(u.uKeyLo, o.lo ?? 0.04); gl.uniform1f(u.uKeyHi, o.hi ?? 0.30);
    gl.uniform1f(u.uCover, o.cover ? 1 : 0); gl.uniform1f(u.uOpacity, o.opacity ?? 1);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  /** Fond : recadrage + mise à l'échelle dans le même passage GPU (un seul rééchantillonnage). */
  drawClip(src, crop) { this.drawFull(src, crop, 0); }
  drawKeyed(src, o) { this.drawFull(src, null, 1, o); }
  drawOverlay(src, o = {}) { this.drawFull(src, null, 2, { ...o, premultiply: true }); }

  /** Charge (une fois) une texture de sprite avec mipmaps. @param {string} key @param {TexImageSource} src */
  uploadSprite(key, src) {
    let s = this.sprites.get(key);
    if (s) return s;
    const gl = this.gl;
    const tex = this._newTex(true);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src);
    gl.generateMipmap(gl.TEXTURE_2D);
    s = { tex, w: /** @type {any} */ (src).width, h: /** @type {any} */ (src).height };
    this.sprites.set(key, s);
    return s;
  }
  releaseSprite(key) { const s = this.sprites.get(key); if (s) { this.gl.deleteTexture(s.tex); this.sprites.delete(key); } }
  releaseAllSprites(keep = new Set()) { for (const k of [...this.sprites.keys()]) if (!keep.has(k)) this.releaseSprite(k); }

  /**
   * Dessine une région de sprite, centrée en (cx, cy) unités de conception, à l'échelle `scale` (1 = taille finale ;
   * la texture est suréchantillonnée d'un facteur ss). Toutes les valeurs sont décimales : aucun arrondi.
   * @param {string} key @param {{ x: number, y: number, w: number, h: number, cx: number, cy: number }} r région (px texture)
   * @param {number} cx @param {number} cy @param {number} scale @param {number} ss @param {number} [opacity]
   */
  drawSprite(key, r, cx, cy, scale, ss, opacity = 1) {
    const s = this.sprites.get(key);
    if (!s) return;
    const gl = this.gl, { p, u } = this.sprite;
    gl.useProgram(p);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadUnit); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, s.tex);
    gl.uniform1i(u.uTex, 0);
    gl.uniform2f(u.uView, DESIGN_W, DESIGN_H);
    const k = scale / ss;
    gl.uniform4f(u.uDst, cx - r.cx * k, cy - r.cy * k, r.w * k, r.h * k);
    gl.uniform4f(u.uSrc, r.x / s.w, r.y / s.h, r.w / s.w, r.h / s.h);
    gl.uniform1f(u.uOpacity, opacity);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  /** Lecture des pixels (tests, contrôles après rendu). */
  readPixels() {
    const gl = this.gl, px = new Uint8Array(this.width * this.height * 4);
    gl.readPixels(0, 0, this.width, this.height, gl.RGBA, gl.UNSIGNED_BYTE, px);
    return px;   // origine bas-gauche
  }

  destroy() {
    this.releaseAllSprites();
    const ext = this.gl.getExtension('WEBGL_lose_context');
    if (ext) ext.loseContext();
  }
}

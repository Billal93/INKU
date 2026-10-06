// Compositeur WebGL2 unique pour l'APERÇU et l'EXPORT (même code, même résultat) : toute la composition est une
// fonction pure de l'image demandée. Espace de travail 1080×1920 (« unités de conception ») quelle que soit la
// résolution réelle du canevas (aperçu 540×960, export 1080×1920, brouillon…) : positions décimales, sous-pixel.
// Calques : fond (clip recadré en UN seul rééchantillonnage, ou paysage sur fond flou), overlays (retrait de fond
// noir décontaminé, fond vert, ou alpha ; plein cadre ou boîte), sprites transformés (sous-titres, copyright :
// texture suréchantillonnée + mipmaps trilinéaires).

const FULL_VS = `#version 300 es
in vec2 aPos;
uniform vec4 uCrop;   // u0, v0, u1, v1 en coordonnées texture (origine haut-gauche)
uniform vec4 uBox;    // x0, y0 (bas), x1, y1 (haut) en coordonnées normalisées : plein cadre = -1, -1, 1, 1
uniform float uFlipV; // 1 : texture issue d'un rendu intermédiaire (origine bas-gauche)
out vec2 vUv;
void main() {
  vec2 t = aPos * 0.5 + 0.5;
  vUv = vec2(mix(uCrop.x, uCrop.z, t.x), mix(uCrop.w, uCrop.y, uFlipV > 0.5 ? 1.0 - t.y : t.y));
  gl_Position = vec4(mix(uBox.xy, uBox.zw, t), 0.0, 1.0);
}`;

const FULL_FS = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uTex;
uniform int uMode;      // 0 opaque, 1 fond noir → alpha (décontaminé), 2 alpha prémultiplié, 3 fond vert (chroma key)
uniform float uKeyLo, uKeyHi, uCover, uOpacity, uGain;
uniform vec3 uKeyColor;
out vec4 outColor;
vec2 cbcr(vec3 c) { return vec2(-0.168736 * c.r - 0.331264 * c.g + 0.5 * c.b, 0.5 * c.r - 0.418688 * c.g - 0.081312 * c.b); }
void main() {
  vec4 s = texture(uTex, vUv);
  if (uMode == 0) { outColor = vec4(s.rgb * uGain, 1.0) * uOpacity; return; }
  if (uMode == 2) { outColor = s * uOpacity; return; }
  if (uCover > 0.5) { outColor = vec4(s.rgb, 1.0) * uOpacity; return; }   // couverture totale : masque VRAIMENT le dessous
  if (uMode == 3) {
    float a = smoothstep(uKeyLo, uKeyHi, distance(cbcr(s.rgb), cbcr(uKeyColor)));
    vec3 c = vec3(s.r, min(s.g, max(s.r, s.b)), s.b);   // suppression du débordement vert
    outColor = vec4(c * a, a) * uOpacity; return;
  }
  float a0 = max(s.r, max(s.g, s.b));
  float a = smoothstep(uKeyLo, uKeyHi, a0);
  vec3 c = min(s.rgb / max(a0, 1e-4), vec3(1.0));   // décontamination : on retire le noir mélangé avant de prémultiplier
  outColor = vec4(c * a, a) * uOpacity;
}`;

// Flou gaussien séparable (fond flou de la fin de vidéo), sur une image réduite au quart.
const BLUR_FS = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uTex;
uniform vec2 uDir;      // pas d'un texel dans la direction du flou
uniform float uSigma;
out vec4 outColor;
void main() {
  vec3 acc = vec3(0.0); float wsum = 0.0;
  for (int i = -30; i <= 30; i++) {
    float x = float(i);
    float w = exp(-0.5 * x * x / (uSigma * uSigma));
    acc += texture(uTex, vUv + uDir * x).rgb * w; wsum += w;
  }
  outColor = vec4(acc / wsum, 1.0);
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

const dims = (src) => [/** @type {any} */ (src).displayWidth || /** @type {any} */ (src).width, /** @type {any} */ (src).displayHeight || /** @type {any} */ (src).height];

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
    this.blur = program(gl, FULL_VS, BLUR_FS);
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
    this.blurTargets = null;
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

  _upload(src, premultiply) {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.frameTex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, !!premultiply);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src);
  }

  /**
   * Calque (plein cadre par défaut). crop en px de la source (décimales permises) ; box en unités de conception.
   * @param {TexImageSource} src @param {{ x: number, y: number, w: number, h: number } | null} crop
   * @param {0|1|2|3} mode @param {{ lo?: number, hi?: number, cover?: boolean, opacity?: number, premultiply?: boolean,
   *   color?: number[], gain?: number, box?: { x: number, y: number, w: number, h: number } | null }} [o]
   */
  drawFull(src, crop, mode, o = {}) {
    this._upload(src, o.premultiply);
    const [sw, sh] = dims(src);
    this._quad(this.frameTex, sw, sh, crop, mode, o);
  }

  /** Dessine une texture déjà chargée. */
  _quad(tex, sw, sh, crop, mode, o = {}, flipV = false) {
    const gl = this.gl, { p, u } = this.full;
    const c = crop || { x: 0, y: 0, w: sw, h: sh };
    gl.useProgram(p);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadFull); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.uniform1i(u.uTex, 0);
    gl.uniform4f(u.uCrop, c.x / sw, c.y / sh, (c.x + c.w) / sw, (c.y + c.h) / sh);
    const b = o.box;
    if (b) gl.uniform4f(u.uBox, b.x / DESIGN_W * 2 - 1, 1 - (b.y + b.h) / DESIGN_H * 2, (b.x + b.w) / DESIGN_W * 2 - 1, 1 - b.y / DESIGN_H * 2);
    else gl.uniform4f(u.uBox, -1, -1, 1, 1);
    gl.uniform1f(u.uFlipV, flipV ? 1 : 0);
    gl.uniform1i(u.uMode, mode);
    gl.uniform1f(u.uKeyLo, o.lo ?? (mode === 3 ? 0.10 : 0.04)); gl.uniform1f(u.uKeyHi, o.hi ?? (mode === 3 ? 0.18 : 0.30));
    const kc = o.color || [0, 1, 0];
    gl.uniform3f(u.uKeyColor, kc[0], kc[1], kc[2]);
    gl.uniform1f(u.uCover, o.cover ? 1 : 0); gl.uniform1f(u.uOpacity, o.opacity ?? 1); gl.uniform1f(u.uGain, o.gain ?? 1);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  /** Fond : recadrage + mise à l'échelle dans le même passage GPU (un seul rééchantillonnage). */
  drawClip(src, crop) { this.drawFull(src, crop, 0); }
  drawKeyed(src, o) { this.drawFull(src, null, 1, o); }
  drawOverlay(src, o = {}) { this.drawFull(src, null, 2, { ...o, premultiply: true }); }

  /**
   * Overlay avec sa méthode de retrait de fond (mémorisée par fichier).
   * @param {TexImageSource} src @param {{ method: string, lo?: number, hi?: number, color?: number[] }} k
   * @param {{ cover?: boolean, box?: any, opacity?: number }} [o]
   */
  drawKeyedOverlay(src, k, o = {}) {
    const mode = k.method === 'alpha' ? 2 : k.method === 'chroma' ? 3 : k.method === 'none' ? 0 : 1;
    this.drawFull(src, null, /** @type {0|1|2|3} */ (mode), { ...o, lo: k.lo, hi: k.hi, color: k.color, premultiply: mode === 2 });
  }

  _targets() {
    const w = Math.max(2, Math.round(this.width / 4)), h = Math.max(2, Math.round(this.height / 4));
    if (this.blurTargets && this.blurTargets.w === w && this.blurTargets.h === h) return this.blurTargets;
    const gl = this.gl;
    const mk = () => {
      const tex = this._newTex(false);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      const fb = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
      return { tex, fb };
    };
    this.blurTargets = { w, h, a: mk(), b: mk() };
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return this.blurTargets;
  }

  /**
   * Composition « paysage au centre sur fond flou » (climax, miniature non 9:16) : fond = même image recadrée pour
   * couvrir, flou gaussien fort (σ ≈ 40 px à 1080 de large) et assombri de 15 % ; avant-plan net, pleine largeur,
   * centré verticalement, jamais déformé. Une seule image source pour les deux : toujours synchronisés.
   * @param {TexImageSource} src @param {{ x: number, y: number, w: number, h: number } | null} crop zone utile
   */
  drawFitBlur(src, crop, { sigma = 40, darken = 0.15 } = {}) {
    const gl = this.gl;
    const T = this._targets();
    const [sw, sh] = dims(src);
    const c = crop || { x: 0, y: 0, w: sw, h: sh };
    // 1. fond : recadrage « couvrir » 9:16 au centre de la zone utile, dans la cible réduite
    let cw = c.h * (DESIGN_W / DESIGN_H), ch = c.h;
    if (cw > c.w) { cw = c.w; ch = cw * (DESIGN_H / DESIGN_W); }
    const cover = { x: c.x + (c.w - cw) / 2, y: c.y + (c.h - ch) / 2, w: cw, h: ch };
    this._upload(src, false);
    gl.disable(gl.BLEND);
    gl.bindFramebuffer(gl.FRAMEBUFFER, T.a.fb); gl.viewport(0, 0, T.w, T.h);
    this._quad(this.frameTex, sw, sh, cover, 0);
    // 2. flou séparable : σ exprimé en unités de conception, ramené aux pixels de la cible réduite
    const s = Math.min(10, Math.max(0.5, sigma * T.w / DESIGN_W));
    const pass = (from, to, dx, dy) => {
      const { p, u } = this.blur;
      gl.bindFramebuffer(gl.FRAMEBUFFER, to.fb);
      gl.useProgram(p);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.quadFull); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, from.tex);
      gl.uniform1i(u.uTex, 0);
      gl.uniform4f(u.uCrop, 0, 0, 1, 1); gl.uniform4f(u.uBox, -1, -1, 1, 1); gl.uniform1f(u.uFlipV, 1);
      gl.uniform2f(u.uDir, dx / T.w, dy / T.h); gl.uniform1f(u.uSigma, s);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    };
    pass(T.a, T.b, 1, 0); pass(T.b, T.a, 0, 1);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.viewport(0, 0, this.width, this.height);
    // 3. fond flou assombri, puis avant-plan net pleine largeur centré
    this._quad(T.a.tex, T.w, T.h, null, 0, { gain: 1 - darken }, true);
    gl.enable(gl.BLEND);
    const fh = DESIGN_W * (c.h / c.w);
    this._quad(this.frameTex, sw, sh, c, 0, { box: { x: 0, y: (DESIGN_H - fh) / 2, w: DESIGN_W, h: fh } });
  }

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

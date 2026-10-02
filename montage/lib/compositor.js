// Compositeur : WebGL2 (niveau A/B) avec repli canvas 2D (dégradé).
// Toute la composition est une fonction pure du contenu fourni pour l'image courante.

const VS = `#version 300 es
in vec2 aPos;
uniform vec4 uCrop; // u0, vBas, u1, vHaut (en coordonnées texture, origine bas-gauche)
out vec2 vUv;
void main() {
  vec2 t = aPos * 0.5 + 0.5;
  vUv = vec2(mix(uCrop.x, uCrop.z, t.x), mix(uCrop.y, uCrop.w, t.y));
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

const FS = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uTex;
uniform int uMode;      // 0 opaque, 1 retrait de fond noir (luminosité -> alpha), 2 calque alpha prémultiplié
uniform float uKeyLo;
uniform float uKeyHi;
uniform float uCover;   // 1.0 = couverture totale : calque forcé opaque
out vec4 outColor;
void main() {
  vec4 s = texture(uTex, vUv);
  if (uMode == 0) { outColor = vec4(s.rgb, 1.0); return; }
  if (uMode == 2) { outColor = s; return; }
  float a0 = max(s.r, max(s.g, s.b));
  if (uCover > 0.5) { outColor = vec4(s.rgb, 1.0); return; }
  float a = smoothstep(uKeyLo, uKeyHi, a0);
  // Décontamination : on retire la part de noir mélangée aux couleurs avant de prémultiplier.
  vec3 c = s.rgb / max(a0, 1e-4);
  outColor = vec4(c * a, a);
}`;

function compile(gl, type, src) {
  const sh = gl.createShader(type);
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    throw new Error('Shader: ' + gl.getShaderInfoLog(sh));
  }
  return sh;
}

export class WebGLCompositor {
  constructor(width, height) {
    this.width = width; this.height = height; this.degraded = false; this.kind = 'webgl2';
    this.canvas = document.createElement('canvas');
    this.canvas.width = width; this.canvas.height = height;
    const gl = this.canvas.getContext('webgl2', {
      alpha: false, antialias: false, preserveDrawingBuffer: true, premultipliedAlpha: false,
    });
    if (!gl) throw new Error('WebGL2 indisponible');
    this.gl = gl;
    const prog = gl.createProgram();
    gl.attachShader(prog, compile(gl, gl.VERTEX_SHADER, VS));
    gl.attachShader(prog, compile(gl, gl.FRAGMENT_SHADER, FS));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error('Link: ' + gl.getProgramInfoLog(prog));
    gl.useProgram(prog);
    this.u = {
      crop: gl.getUniformLocation(prog, 'uCrop'),
      mode: gl.getUniformLocation(prog, 'uMode'),
      lo: gl.getUniformLocation(prog, 'uKeyLo'),
      hi: gl.getUniformLocation(prog, 'uKeyHi'),
      cover: gl.getUniformLocation(prog, 'uCover'),
      tex: gl.getUniformLocation(prog, 'uTex'),
    };
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, 'aPos');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    gl.viewport(0, 0, width, height);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.uniform1i(this.u.tex, 0);
    this.tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    for (const [p, v] of [[gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR],
      [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]]) {
      gl.texParameteri(gl.TEXTURE_2D, p, v);
    }
  }

  begin() {
    const gl = this.gl;
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
  }

  // Remplit d'une couleur unie (sert aux tests de repli, ex. MediaRecorder).
  fillColor(r, g, b) { this.gl.clearColor(r, g, b, 1); this.gl.clear(this.gl.COLOR_BUFFER_BIT); }

  _draw(src, crop, mode, premultiply, extra) {
    const gl = this.gl;
    const sw = src.width, sh = src.height;
    const c = crop || { x: 0, y: 0, w: sw, h: sh };
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, !!premultiply);
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src);
    gl.uniform4f(this.u.crop, c.x / sw, 1 - (c.y + c.h) / sh, (c.x + c.w) / sw, 1 - c.y / sh);
    gl.uniform1i(this.u.mode, mode);
    gl.uniform1f(this.u.lo, extra && extra.lo !== undefined ? extra.lo : 0.04);
    gl.uniform1f(this.u.hi, extra && extra.hi !== undefined ? extra.hi : 0.30);
    gl.uniform1f(this.u.cover, extra && extra.cover ? 1 : 0);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  // Fond : un seul rééchantillonnage (recadrage + mise à l'échelle dans le même passage GPU).
  drawClip(src, crop) { this._draw(src, crop, 0, false); }
  // Overlay sans canal alpha sur fond noir.
  drawKeyed(src, opts) { this._draw(src, null, 1, false, opts); }
  // Calque 2D avec alpha (sous-titres, logo, copyright).
  drawOverlay(src) { this._draw(src, null, 2, true); }
}

export class Canvas2DCompositor {
  constructor(width, height) {
    this.width = width; this.height = height; this.degraded = true; this.kind = 'canvas2d';
    this.canvas = document.createElement('canvas');
    this.canvas.width = width; this.canvas.height = height;
    this.ctx = this.canvas.getContext('2d', { alpha: false });
  }
  begin() { this.ctx.globalCompositeOperation = 'source-over'; this.ctx.fillStyle = '#000'; this.ctx.fillRect(0, 0, this.width, this.height); }
  drawClip(src, crop) {
    const c = crop || { x: 0, y: 0, w: src.width, h: src.height };
    this.ctx.globalCompositeOperation = 'source-over';
    this.ctx.drawImage(src, c.x, c.y, c.w, c.h, 0, 0, this.width, this.height);
  }
  // Approximation : "screen" ne masque pas le fond (pas d'alpha réel) sauf pendant la couverture totale.
  drawKeyed(src, opts) {
    this.ctx.globalCompositeOperation = opts && opts.cover ? 'source-over' : 'screen';
    this.ctx.drawImage(src, 0, 0, this.width, this.height);
    this.ctx.globalCompositeOperation = 'source-over';
  }
  drawOverlay(src) { this.ctx.globalCompositeOperation = 'source-over'; this.ctx.drawImage(src, 0, 0, this.width, this.height); }
  fillColor(r, g, b) { this.ctx.fillStyle = 'rgb(' + Math.round(r * 255) + ',' + Math.round(g * 255) + ',' + Math.round(b * 255) + ')'; this.ctx.fillRect(0, 0, this.width, this.height); }
}

export function createCompositor(w, h, forceKind) {
  if (forceKind !== 'canvas2d') {
    try { return new WebGLCompositor(w, h); } catch (e) { console.warn('[montage] WebGL2 indisponible, repli canvas 2D :', e.message); }
  }
  return new Canvas2DCompositor(w, h);
}

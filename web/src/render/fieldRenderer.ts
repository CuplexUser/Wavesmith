// WebGL2 renderer: uploads the simulation as a float texture and the material overlay as an
// RGBA8 texture, then colors both in one full-screen pass. The float texture is filtered by
// hand with texelFetch so it works without OES_texture_float_linear, which many phones lack;
// the overlay is 8-bit, so the GPU filters it.
//
// Two modes:
// - sound: one signed field shown as warm crests and cool troughs;
// - light: red/green/blue intensity envelopes mixed additively, with moving wavefronts.
//
// Walls are drawn from signed-distance fields rather than the solver's cell mask, so edges are
// anti-aliased and follow the true geometry. Fixed walls look like stone; the player's walls
// and reflectors look like polished metal.

import { paletteMix } from './palette';

const VERT = `#version 300 es
in vec2 aPos;
out vec2 vUv;
void main() {
  vUv = vec2(aPos.x * 0.5 + 0.5, 0.5 - aPos.y * 0.5);
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

const FRAG = `#version 300 es
precision highp float;
precision highp int;
uniform highp sampler2D uField;
uniform sampler2D uMat;
uniform vec2 uGrid;
uniform vec2 uPlay;
uniform float uPad;
uniform float uGain;
uniform float uPx;
uniform int uMode;
uniform vec3 uColR;
uniform vec3 uColG;
uniform vec3 uColB;
uniform float uWaves;
in vec2 vUv;
out vec4 outColor;

// Must match OVERLAY_SDF_RANGE in wavesmith-core/src/materials.rs.
const float SDF_RANGE = 4.0;

vec4 tex(ivec2 p) { return texelFetch(uField, p, 0); }

vec4 sampleField(vec2 g) {
  ivec2 i0 = ivec2(floor(g));
  vec2 t = fract(g);
  return mix(mix(tex(i0), tex(i0 + ivec2(1, 0)), t.x),
             mix(tex(i0 + ivec2(0, 1)), tex(i0 + ivec2(1, 1)), t.x), t.y);
}

// Light mode packs each color's wavefront phase into the fourth value as 5-bit integers
// (32²·red + 32·green + blue; see Session::light_image), so unpack before filtering.
vec3 wavefronts(vec4 v) {
  float p = max(v.a, 0.0);
  return vec3(floor(p / 1024.0), mod(floor(p / 32.0), 32.0), mod(p, 32.0)) / 31.0;
}

vec3 sampleWavefronts(vec2 g) {
  ivec2 i0 = ivec2(floor(g));
  vec2 t = fract(g);
  return mix(mix(wavefronts(tex(i0)), wavefronts(tex(i0 + ivec2(1, 0))), t.x),
             mix(wavefronts(tex(i0 + ivec2(0, 1))), wavefronts(tex(i0 + ivec2(1, 1))), t.x), t.y);
}

vec4 mat(vec2 g) { return texture(uMat, (g + 0.5) / uGrid); }

float decode(float v) { return v * (2.0 * SDF_RANGE) - SDF_RANGE; }

/** Distance in cells to the nearest fixed (x) and player (y) wall surface, negative inside. */
vec2 wallDist(vec2 g) {
  vec4 m = mat(g);
  return vec2(decode(m.r), decode(m.a));
}

float hash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}

vec3 soundColor(float u) {
  // Soft-saturating diverging map: warm crests, cool troughs.
  float x = u * uGain;
  float s = pow(abs(x) / (1.0 + abs(x)), 0.9);
  vec3 bg = vec3(0.027, 0.043, 0.082);
  vec3 hue = x >= 0.0 ? vec3(1.0, 0.62, 0.24) : vec3(0.22, 0.72, 1.0);
  vec3 col = mix(bg, hue, s);
  return mix(col, vec3(1.0, 0.97, 0.9), smoothstep(0.82, 1.0, s) * 0.6);
}

vec3 waterColor(float u) {
  // Water seen from above: deep blue, crests catching pale light, troughs darker.
  float x = u * uGain;
  float s = x / (1.0 + abs(x));
  vec3 deep = vec3(0.02, 0.10, 0.20);
  vec3 col = deep + vec3(0.05, 0.16, 0.22) * (0.5 + 0.5 * s);
  col += vec3(0.75, 0.92, 1.0) * pow(max(s, 0.0), 2.2) * 0.85;
  col *= 1.0 - 0.35 * max(-s, 0.0);
  return col;
}

vec3 lightColor(vec3 v, vec3 phase) {
  // Additive mixing of the three channels, each with faint moving wavefronts from its own
  // phase, so beams a prism has split keep their own wave spacing and direction.
  vec3 i = max(v, 0.0) * uGain * mix(vec3(0.97), 0.82 + 0.3 * phase, uWaves);
  vec3 c = i.r * uColR + i.g * uColG + i.b * uColB;
  vec3 bg = vec3(0.010, 0.013, 0.028);
  return bg + (1.0 - exp(-c * 1.5));
}

void main() {
  vec2 g = vec2(uPad) + vUv * uPlay - 0.5;
  vec4 v = sampleField(g);
  vec3 col = uMode == 1 ? lightColor(v.rgb, sampleWavefronts(g)) : uMode == 2 ? waterColor(v.r) : soundColor(v.r);

  // Faint cell grid for a sense of scale.
  vec2 cell = vUv * uPlay;
  vec2 gd = (0.5 - abs(fract(cell / 16.0) - 0.5)) * 16.0;
  float line = 1.0 - smoothstep(0.0, uPx * 1.2, min(gd.x, gd.y));
  col += vec3(0.05, 0.08, 0.14) * line * (uMode == 0 ? 0.35 : 0.2);

  vec4 m = mat(g);
  // One device pixel, in cells: the width of every anti-aliased edge.
  float aa = uPx;

  // Slow media: a faint tint (the canvas layer draws the glass itself).
  // Water: slow regions are shallows, tinted like sand.
  vec3 tint = uMode == 1 ? vec3(0.55, 0.7, 0.95) : uMode == 2 ? vec3(0.78, 0.7, 0.48) : vec3(0.62, 0.42, 1.0);
  col = mix(col, tint, m.b * (uMode == 1 ? 0.10 : 0.30));

  // Absorbers swallow waves; the canvas layer draws foam over them.
  if (m.g > 0.0) {
    float w = max(fwidth(m.g), 1e-4);
    col *= 1.0 - 0.45 * smoothstep(0.5 - w, 0.5 + w, m.g);
  }

  vec2 d2 = wallDist(g);
  float d = min(d2.x, d2.y);
  if (d < 2.0) {
    // Soft contact shadow cast down and to the right of walls.
    vec2 ds2 = wallDist(g - vec2(0.8, 0.8));
    float ds = min(ds2.x, ds2.y);
    col *= 1.0 - 0.45 * (1.0 - smoothstep(-0.5, 1.5, ds));

    float wall = 1.0 - smoothstep(-0.5 * aa, 0.5 * aa, d);
    if (wall > 0.0) {
      bool player = d2.y < d2.x;
      // Bevel from the distance gradient (it points out of the wall), lit from the top-left.
      float e = 0.5;
      vec2 gx = wallDist(g + vec2(e, 0.0)) - wallDist(g - vec2(e, 0.0));
      vec2 gy = wallDist(g + vec2(0.0, e)) - wallDist(g - vec2(0.0, e));
      vec2 grad = player ? vec2(gx.y, gy.y) : vec2(gx.x, gy.x);
      vec2 n = grad / max(length(grad), 1e-4);
      float lit = dot(n, vec2(-0.7071, -0.7071));
      float rim = smoothstep(-1.4, -0.1, d);
      vec3 wallCol;
      if (player) {
        // Polished metal: bright core, darker edges, a hard specular along the lit rim, and a
        // trace of the player's mint at the edges.
        float core = clamp(-d / 1.6, 0.0, 1.0);
        wallCol = mix(vec3(0.34, 0.47, 0.50), vec3(0.93, 0.96, 1.0), pow(core, 0.55));
        wallCol += rim * max(lit, 0.0) * 0.35 - rim * max(-lit, 0.0) * 0.18;
      } else {
        // Stone: matte slate with a little grain.
        float grain = hash(floor(g * 2.0)) * 0.05;
        wallCol = vec3(0.30, 0.34, 0.42) + grain + rim * (0.16 * lit + 0.03);
      }
      col = mix(col, wallCol, wall);
    }
  }
  outColor = vec4(col, 1.0);
}`;

function compile(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader {
  const sh = gl.createShader(type)!;
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    throw new Error(`shader: ${gl.getShaderInfoLog(sh) ?? 'compile failed'}`);
  }
  return sh;
}

export type RenderMode = 'sound' | 'light' | 'water';

export class FieldRenderer {
  readonly gl: WebGL2RenderingContext;
  private prog: WebGLProgram;
  private fieldTex: WebGLTexture;
  private matTex: WebGLTexture;
  private uniforms: Record<string, WebGLUniformLocation | null> = {};
  private nx = 0;
  private ny = 0;
  private mode: RenderMode = 'sound';
  /** Value multiplier before tone mapping. */
  gain = 1.6;
  /** Strength of the moving wavefronts drawn inside light beams (0 for reduced motion). */
  waves = 1;

  constructor(readonly canvas: HTMLCanvasElement) {
    const gl = canvas.getContext('webgl2', { antialias: false, alpha: false, preserveDrawingBuffer: false });
    if (!gl) throw new Error('WebGL2 is not available');
    this.gl = gl;
    const prog = gl.createProgram()!;
    gl.attachShader(prog, compile(gl, gl.VERTEX_SHADER, VERT));
    gl.attachShader(prog, compile(gl, gl.FRAGMENT_SHADER, FRAG));
    gl.bindAttribLocation(prog, 0, 'aPos');
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      throw new Error(`program: ${gl.getProgramInfoLog(prog) ?? 'link failed'}`);
    }
    this.prog = prog;
    for (const name of [
      'uField',
      'uMat',
      'uGrid',
      'uPlay',
      'uPad',
      'uGain',
      'uPx',
      'uMode',
      'uColR',
      'uColG',
      'uColB',
      'uWaves',
    ]) {
      this.uniforms[name] = gl.getUniformLocation(prog, name);
    }
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    this.fieldTex = this.makeTexture(gl.NEAREST);
    this.matTex = this.makeTexture(gl.LINEAR);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  }

  private makeTexture(filter: number): WebGLTexture {
    const gl = this.gl;
    const t = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return t;
  }

  /** Allocates textures for a solver grid of `nx × ny`. */
  setGrid(nx: number, ny: number, mode: RenderMode = 'sound'): void {
    const gl = this.gl;
    this.nx = nx;
    this.ny = ny;
    this.mode = mode;
    gl.bindTexture(gl.TEXTURE_2D, this.fieldTex);
    if (mode === 'light') {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, nx, ny, 0, gl.RGBA, gl.FLOAT, null);
    } else {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, nx, ny, 0, gl.RED, gl.FLOAT, null);
    }
    gl.bindTexture(gl.TEXTURE_2D, this.matTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, nx, ny, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  }

  /** Uploads the sound field (one float per cell) or the light image (four per cell). */
  uploadField(field: Float32Array): void {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.fieldTex);
    const format = this.mode === 'light' ? gl.RGBA : gl.RED;
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, this.nx, this.ny, format, gl.FLOAT, field);
  }

  uploadOverlay(overlay: Uint8Array): void {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.matTex);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, this.nx, this.ny, gl.RGBA, gl.UNSIGNED_BYTE, overlay);
  }

  /** Matches the drawing buffer to the canvas's CSS size and device pixel ratio. */
  resize(cssW: number, cssH: number, dpr: number): void {
    const w = Math.max(1, Math.round(cssW * dpr));
    const h = Math.max(1, Math.round(cssH * dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
  }

  /** Draws the play area: `playW × playH` cells inside a `pad`-cell sponge border. */
  draw(playW: number, playH: number, pad: number): void {
    const gl = this.gl;
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.useProgram(this.prog);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.fieldTex);
    gl.uniform1i(this.uniforms.uField!, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.matTex);
    gl.uniform1i(this.uniforms.uMat!, 1);
    gl.uniform2f(this.uniforms.uGrid!, this.nx, this.ny);
    gl.uniform2f(this.uniforms.uPlay!, playW, playH);
    gl.uniform1f(this.uniforms.uPad!, pad);
    gl.uniform1f(this.uniforms.uGain!, this.gain);
    gl.uniform1i(this.uniforms.uMode!, this.mode === 'light' ? 1 : this.mode === 'water' ? 2 : 0);
    const mix = paletteMix();
    gl.uniform3f(this.uniforms.uColR!, ...mix.red);
    gl.uniform3f(this.uniforms.uColG!, ...mix.green);
    gl.uniform3f(this.uniforms.uColB!, ...mix.blue);
    gl.uniform1f(this.uniforms.uWaves!, this.waves);
    // Anti-aliasing width, in cells per device pixel.
    gl.uniform1f(this.uniforms.uPx!, playW / this.canvas.width);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }
}

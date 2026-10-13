// WebGL2 renderer: uploads the wave field as an R32F texture and the material overlay as an
// RGBA8 texture, then colors both in one full-screen pass. The field is filtered by hand with
// texelFetch so it works without OES_texture_float_linear, which many phones lack; the
// overlay is 8-bit, so the GPU filters it.
//
// Walls are drawn from a signed-distance field (overlay red channel) rather than from the
// solver's cell mask, so their edges are anti-aliased and follow the true geometry.

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
in vec2 vUv;
out vec4 outColor;

// Must match OVERLAY_SDF_RANGE in wavesmith-core/src/materials.rs.
const float SDF_RANGE = 4.0;

float f(ivec2 p) { return texelFetch(uField, p, 0).r; }

vec4 mat(vec2 g) { return texture(uMat, (g + 0.5) / uGrid); }

/** Distance in cells to the nearest wall surface, negative inside. */
float wallDist(vec2 g) { return mat(g).r * (2.0 * SDF_RANGE) - SDF_RANGE; }

void main() {
  vec2 g = vec2(uPad) + vUv * uPlay - 0.5;
  ivec2 i0 = ivec2(floor(g));
  vec2 t = fract(g);
  float u = mix(mix(f(i0), f(i0 + ivec2(1, 0)), t.x),
                mix(f(i0 + ivec2(0, 1)), f(i0 + ivec2(1, 1)), t.x), t.y);

  // Soft-saturating diverging map: warm crests, cool troughs.
  float x = u * uGain;
  float s = pow(abs(x) / (1.0 + abs(x)), 0.9);
  vec3 bg = vec3(0.027, 0.043, 0.082);
  vec3 warm = vec3(1.0, 0.62, 0.24);
  vec3 cool = vec3(0.22, 0.72, 1.0);
  vec3 hue = x >= 0.0 ? warm : cool;
  vec3 col = mix(bg, hue, s);
  col = mix(col, vec3(1.0, 0.97, 0.9), smoothstep(0.82, 1.0, s) * 0.6);

  // Faint cell grid for a sense of scale.
  vec2 cell = vUv * uPlay;
  vec2 gd = (0.5 - abs(fract(cell / 16.0) - 0.5)) * 16.0;
  float line = 1.0 - smoothstep(0.0, uPx * 1.2, min(gd.x, gd.y));
  col += vec3(0.05, 0.08, 0.14) * line * 0.35;

  vec4 m = mat(g);
  // One device pixel, in cells: the width of every anti-aliased edge.
  float aa = uPx;

  // Lens: violet tint scaled by how much it slows waves.
  col = mix(col, vec3(0.62, 0.42, 1.0), m.b * 0.38);

  // Absorber: darkened and hatched, with its edge at 50% coverage.
  if (m.g > 0.0) {
    float w = max(fwidth(m.g), 1e-4);
    float cover = smoothstep(0.5 - w, 0.5 + w, m.g);
    float phase = fract((gl_FragCoord.x + gl_FragCoord.y) / 9.0);
    float stripe = smoothstep(0.55, 0.62, phase) * (1.0 - smoothstep(0.9, 0.97, phase));
    vec3 hatched = col * 0.55 + vec3(0.09, 0.05, 0.12) * stripe;
    col = mix(col, hatched, cover);
  }

  float d = wallDist(g);
  if (d < 2.0) {
    // Soft contact shadow cast down and to the right of walls.
    float ds = wallDist(g - vec2(0.8, 0.8));
    col *= 1.0 - 0.4 * (1.0 - smoothstep(-0.5, 1.5, ds));

    float wall = 1.0 - smoothstep(-0.5 * aa, 0.5 * aa, d);
    if (wall > 0.0) {
      // Bevel from the distance gradient (it points out of the wall), lit from the top-left.
      vec2 grad = vec2(wallDist(g + vec2(0.5, 0.0)) - wallDist(g - vec2(0.5, 0.0)),
                       wallDist(g + vec2(0.0, 0.5)) - wallDist(g - vec2(0.0, 0.5)));
      vec2 n = grad / max(length(grad), 1e-4);
      float lit = dot(n, vec2(-0.7071, -0.7071));
      float rim = smoothstep(-1.4, -0.1, d);
      vec3 wallCol = vec3(0.6, 0.66, 0.76) + rim * (0.2 * lit + 0.05);
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

export class FieldRenderer {
  readonly gl: WebGL2RenderingContext;
  private prog: WebGLProgram;
  private fieldTex: WebGLTexture;
  private matTex: WebGLTexture;
  private uniforms: Record<string, WebGLUniformLocation | null> = {};
  private nx = 0;
  private ny = 0;
  /** Field-value multiplier before tone mapping. */
  gain = 1.6;

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
    for (const name of ['uField', 'uMat', 'uGrid', 'uPlay', 'uPad', 'uGain', 'uPx']) {
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
  setGrid(nx: number, ny: number): void {
    const gl = this.gl;
    this.nx = nx;
    this.ny = ny;
    gl.bindTexture(gl.TEXTURE_2D, this.fieldTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, nx, ny, 0, gl.RED, gl.FLOAT, null);
    gl.bindTexture(gl.TEXTURE_2D, this.matTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, nx, ny, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  }

  uploadField(field: Float32Array): void {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.fieldTex);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, this.nx, this.ny, gl.RED, gl.FLOAT, field);
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
    // Grid line width, in cells per device pixel.
    gl.uniform1f(this.uniforms.uPx!, playW / this.canvas.width);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }
}

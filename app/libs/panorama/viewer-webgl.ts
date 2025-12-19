import type { ToneMappingMode } from './types'

type WebGLContext = WebGLRenderingContext | WebGL2RenderingContext

export type PanoramaTextureKind = 'rgb16f' | 'rgba8'

export interface PanoramaRenderState {
  yaw: number
  pitch: number
  fovY: number
  toneMapping: ToneMappingMode
  exposure: number
  gamma: number
}

export class PanoramaWebGLRenderer {
  private canvas: HTMLCanvasElement
  private gl: WebGLContext
  private isWebGL2: boolean
  private program: WebGLProgram
  private texture: WebGLTexture
  private vao: WebGLVertexArrayObject | null = null
  private vbo: WebGLBuffer
  private textureKind: PanoramaTextureKind | null = null
  private textureWidth = 0
  private textureHeight = 0

  private uResolution: WebGLUniformLocation
  private uYawPitch: WebGLUniformLocation
  private uFovY: WebGLUniformLocation
  private uToneMapping: WebGLUniformLocation
  private uExposure: WebGLUniformLocation
  private uGamma: WebGLUniformLocation
  private uTex: WebGLUniformLocation
  private uTextureKind: WebGLUniformLocation

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas
    const gl2 = canvas.getContext('webgl2', {
      alpha: false,
      antialias: false,
      depth: false,
      stencil: false,
      premultipliedAlpha: false,
      preserveDrawingBuffer: false,
    })
    const gl1 =
      gl2 ||
      canvas.getContext('webgl', {
        alpha: false,
        antialias: false,
        depth: false,
        stencil: false,
        premultipliedAlpha: false,
        preserveDrawingBuffer: false,
      })
    if (!gl1) {
      throw new Error('WebGL not available')
    }
    this.gl = gl1
    this.isWebGL2 = Boolean(gl2)

    this.program = this.createProgram()
    const texture = this.gl.createTexture()
    const vbo = this.gl.createBuffer()
    if (!texture || !vbo) {
      throw new Error('Failed to initialize WebGL')
    }
    this.texture = texture
    this.vbo = vbo

    this.uResolution = this.getUniform('uResolution')
    this.uYawPitch = this.getUniform('uYawPitch')
    this.uFovY = this.getUniform('uFovY')
    this.uToneMapping = this.getUniform('uToneMapping')
    this.uExposure = this.getUniform('uExposure')
    this.uGamma = this.getUniform('uGamma')
    this.uTex = this.getUniform('uTex')
    this.uTextureKind = this.getUniform('uTextureKind')

    this.initGeometry()
    this.initTexture()
  }

  getMaxTextureSize() {
    return this.gl.getParameter(this.gl.MAX_TEXTURE_SIZE) as number
  }

  supportsRGB16F() {
    return this.isWebGL2
  }

  resize(width: number, height: number, dpr: number) {
    const w = Math.max(1, Math.floor(width * dpr))
    const h = Math.max(1, Math.floor(height * dpr))
    if (this.canvas.width === w && this.canvas.height === h) return
    this.canvas.width = w
    this.canvas.height = h
    this.gl.viewport(0, 0, w, h)
  }

  setTextureRGBA8(width: number, height: number, rgba: Uint8ClampedArray) {
    if (width <= 0 || height <= 0) throw new Error('Invalid texture size')
    this.textureKind = 'rgba8'
    this.textureWidth = width
    this.textureHeight = height

    const gl = this.gl
    gl.bindTexture(gl.TEXTURE_2D, this.texture)
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1)
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA,
      width,
      height,
      0,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      rgba,
    )
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
  }

  setTextureRGB16F(width: number, height: number, rgbHalf: Uint16Array) {
    if (!this.isWebGL2) throw new Error('WebGL2 required for RGB16F')
    if (width <= 0 || height <= 0) throw new Error('Invalid texture size')
    this.textureKind = 'rgb16f'
    this.textureWidth = width
    this.textureHeight = height

    const gl = this.gl as WebGL2RenderingContext
    gl.bindTexture(gl.TEXTURE_2D, this.texture)
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1)
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGB16F,
      width,
      height,
      0,
      gl.RGB,
      gl.HALF_FLOAT,
      rgbHalf,
    )

    const linearExt = gl.getExtension('OES_texture_float_linear')
    const filter = linearExt ? gl.LINEAR : gl.NEAREST
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter)
  }

  render(state: PanoramaRenderState) {
    if (!this.textureKind) return

    const gl = this.gl
    gl.useProgram(this.program)
    if (this.vao && this.isWebGL2) {
      ;(gl as WebGL2RenderingContext).bindVertexArray(this.vao)
    }

    gl.uniform2f(this.uResolution, this.canvas.width, this.canvas.height)
    gl.uniform2f(this.uYawPitch, state.yaw, state.pitch)
    gl.uniform1f(this.uFovY, state.fovY)
    gl.uniform1f(this.uExposure, state.exposure)
    gl.uniform1f(this.uGamma, state.gamma)
    gl.uniform1i(this.uToneMapping, this.toneMappingToInt(state.toneMapping))
    gl.uniform1i(this.uTex, 0)
    gl.uniform1i(this.uTextureKind, this.textureKind === 'rgb16f' ? 1 : 0)

    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, this.texture)

    gl.drawArrays(gl.TRIANGLES, 0, 3)
    if (this.vao && this.isWebGL2) {
      ;(gl as WebGL2RenderingContext).bindVertexArray(null)
    }
  }

  dispose() {
    const gl = this.gl
    gl.deleteTexture(this.texture)
    gl.deleteBuffer(this.vbo)
    if (this.vao && this.isWebGL2) {
      ;(gl as WebGL2RenderingContext).deleteVertexArray(this.vao)
    }
    gl.deleteProgram(this.program)
  }

  private initGeometry() {
    const gl = this.gl
    const vertices = new Float32Array([
      -1, -1, 0, 0,
      3, -1, 2, 0,
      -1, 3, 0, 2,
    ])

    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo)
    gl.bufferData(gl.ARRAY_BUFFER, vertices, gl.STATIC_DRAW)

    if (this.isWebGL2) {
      const gl2 = gl as WebGL2RenderingContext
      const vao = gl2.createVertexArray()
      if (!vao) throw new Error('Failed to create VAO')
      this.vao = vao
      gl2.bindVertexArray(vao)
    }

    const aPos = gl.getAttribLocation(this.program, 'aPos')
    const aUv = gl.getAttribLocation(this.program, 'aUv')
    gl.enableVertexAttribArray(aPos)
    gl.enableVertexAttribArray(aUv)
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 16, 0)
    gl.vertexAttribPointer(aUv, 2, gl.FLOAT, false, 16, 8)

    if (this.isWebGL2) {
      ;(gl as WebGL2RenderingContext).bindVertexArray(null)
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, null)
  }

  private initTexture() {
    const gl = this.gl
    gl.bindTexture(gl.TEXTURE_2D, this.texture)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    gl.bindTexture(gl.TEXTURE_2D, null)
  }

  private getUniform(name: string) {
    const loc = this.gl.getUniformLocation(this.program, name)
    if (!loc) {
      throw new Error(`Missing uniform: ${name}`)
    }
    return loc
  }

  private createProgram() {
    const gl = this.gl
    const vsSource = this.isWebGL2 ? VERT_300 : VERT_100
    const fsSource = this.isWebGL2 ? FRAG_300 : FRAG_100

    const vs = this.compile(gl.VERTEX_SHADER, vsSource)
    const fs = this.compile(gl.FRAGMENT_SHADER, fsSource)

    const program = gl.createProgram()
    if (!program) throw new Error('Failed to create program')
    gl.attachShader(program, vs)
    gl.attachShader(program, fs)
    gl.linkProgram(program)
    gl.deleteShader(vs)
    gl.deleteShader(fs)

    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      const info = gl.getProgramInfoLog(program) || 'Unknown link error'
      gl.deleteProgram(program)
      throw new Error(info)
    }
    return program
  }

  private compile(type: number, source: string) {
    const gl = this.gl
    const shader = gl.createShader(type)
    if (!shader) throw new Error('Failed to create shader')
    gl.shaderSource(shader, source)
    gl.compileShader(shader)
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      const info = gl.getShaderInfoLog(shader) || 'Unknown compile error'
      gl.deleteShader(shader)
      throw new Error(info)
    }
    return shader
  }

  private toneMappingToInt(mode: ToneMappingMode) {
    if (mode === 'linear') return 0
    if (mode === 'reinhard') return 1
    return 2
  }
}

const VERT_100 = `
attribute vec2 aPos;
attribute vec2 aUv;
varying vec2 vUv;
void main() {
  vUv = aUv;
  gl_Position = vec4(aPos, 0.0, 1.0);
}
`

const FRAG_100 = `
precision highp float;
varying vec2 vUv;
uniform sampler2D uTex;
uniform vec2 uResolution;
uniform vec2 uYawPitch;
uniform float uFovY;
uniform int uToneMapping;
uniform float uExposure;
uniform float uGamma;
uniform int uTextureKind;

float toneMap(float x) {
  x = max(0.0, x) * pow(2.0, uExposure);
  if (uToneMapping == 0) return x;
  if (uToneMapping == 1) return x / (1.0 + x);
  float a = 2.51;
  float b = 0.03;
  float c = 2.43;
  float d = 0.59;
  float e = 0.14;
  return (x * (a * x + b)) / (x * (c * x + d) + e);
}

vec3 toSRGB(vec3 linear) {
  vec3 mapped = vec3(toneMap(linear.r), toneMap(linear.g), toneMap(linear.b));
  mapped = clamp(mapped, 0.0, 1.0);
  float g = uGamma > 0.0 ? uGamma : 2.2;
  return pow(mapped, vec3(1.0 / g));
}

void main() {
  vec2 ndc = vUv * 2.0 - 1.0;
  float aspect = uResolution.x / uResolution.y;
  float tanHalf = tan(0.5 * uFovY);
  vec3 dir = normalize(vec3(ndc.x * tanHalf * aspect, ndc.y * tanHalf, -1.0));

  float yaw = uYawPitch.x;
  float pitch = uYawPitch.y;
  float cy = cos(yaw);
  float sy = sin(yaw);
  float cp = cos(pitch);
  float sp = sin(pitch);
  mat3 rotY = mat3(
    cy, 0.0, -sy,
    0.0, 1.0, 0.0,
    sy, 0.0, cy
  );
  mat3 rotX = mat3(
    1.0, 0.0, 0.0,
    0.0, cp, sp,
    0.0, -sp, cp
  );
  vec3 d = rotY * rotX * dir;

  float u = atan(d.x, -d.z) / (2.0 * 3.141592653589793) + 0.5;
  float v = 0.5 - asin(clamp(d.y, -1.0, 1.0)) / 3.141592653589793;
  vec2 uv = vec2(fract(u), clamp(v, 0.0, 1.0));
  vec3 sampled = texture2D(uTex, uv).rgb;
  if (uTextureKind == 0) {
    gl_FragColor = vec4(sampled, 1.0);
    return;
  }
  gl_FragColor = vec4(toSRGB(sampled), 1.0);
}
`

const VERT_300 = `#version 300 es
in vec2 aPos;
in vec2 aUv;
out vec2 vUv;
void main() {
  vUv = aUv;
  gl_Position = vec4(aPos, 0.0, 1.0);
}
`

const FRAG_300 = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D uTex;
uniform vec2 uResolution;
uniform vec2 uYawPitch;
uniform float uFovY;
uniform int uToneMapping;
uniform float uExposure;
uniform float uGamma;
uniform int uTextureKind;

float toneMap(float x) {
  x = max(0.0, x) * pow(2.0, uExposure);
  if (uToneMapping == 0) return x;
  if (uToneMapping == 1) return x / (1.0 + x);
  float a = 2.51;
  float b = 0.03;
  float c = 2.43;
  float d = 0.59;
  float e = 0.14;
  return (x * (a * x + b)) / (x * (c * x + d) + e);
}

vec3 toSRGB(vec3 linear) {
  vec3 mapped = vec3(toneMap(linear.r), toneMap(linear.g), toneMap(linear.b));
  mapped = clamp(mapped, 0.0, 1.0);
  float g = uGamma > 0.0 ? uGamma : 2.2;
  return pow(mapped, vec3(1.0 / g));
}

void main() {
  vec2 ndc = vUv * 2.0 - 1.0;
  float aspect = uResolution.x / uResolution.y;
  float tanHalf = tan(0.5 * uFovY);
  vec3 dir = normalize(vec3(ndc.x * tanHalf * aspect, ndc.y * tanHalf, -1.0));

  float yaw = uYawPitch.x;
  float pitch = uYawPitch.y;
  float cy = cos(yaw);
  float sy = sin(yaw);
  float cp = cos(pitch);
  float sp = sin(pitch);
  mat3 rotY = mat3(
    cy, 0.0, -sy,
    0.0, 1.0, 0.0,
    sy, 0.0, cy
  );
  mat3 rotX = mat3(
    1.0, 0.0, 0.0,
    0.0, cp, sp,
    0.0, -sp, cp
  );
  vec3 d = rotY * rotX * dir;

  float u = atan(d.x, -d.z) / (2.0 * 3.141592653589793) + 0.5;
  float v = 0.5 - asin(clamp(d.y, -1.0, 1.0)) / 3.141592653589793;
  vec2 uv = vec2(fract(u), clamp(v, 0.0, 1.0));
  vec3 sampled = texture(uTex, uv).rgb;
  if (uTextureKind == 0) {
    outColor = vec4(sampled, 1.0);
    return;
  }
  outColor = vec4(toSRGB(sampled), 1.0);
}
`

import {
  DataTexture,
  FloatType,
  MathUtils,
  RedFormat,
  ShaderMaterial,
  UniformsUtils,
} from "three";
import { Pass, FullScreenQuad } from "three/addons/postprocessing/Pass.js";

// A trimmed fork of three.js's own GlitchPass/DigitalGlitch shader — same
// RGB-shift + block-displacement "shifted pixels" look, but with the
// built-in white "snow" noise term removed (that term is what was
// occasionally blowing the whole screen out to white on big glitch frames).
const PixelShiftGlitchShader = {
  uniforms: {
    tDiffuse: { value: null },
    tDisp: { value: null },
    byp: { value: 0 },
    amount: { value: 0.08 },
    angle: { value: 0.02 },
    seed: { value: 0.02 },
    seed_x: { value: 0.02 },
    seed_y: { value: 0.02 },
    distortion_x: { value: 0.5 },
    distortion_y: { value: 0.6 },
    col_s: { value: 0.05 },
  },

  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
    }`,

  fragmentShader: /* glsl */ `
    uniform int byp;
    uniform sampler2D tDiffuse;
    uniform sampler2D tDisp;
    uniform float amount;
    uniform float angle;
    uniform float seed;
    uniform float seed_x;
    uniform float seed_y;
    uniform float distortion_x;
    uniform float distortion_y;
    uniform float col_s;
    varying vec2 vUv;

    void main() {
      if (byp < 1) {
        vec2 p = vUv;
        float disp = texture2D(tDisp, p * seed * seed).r;
        if (p.y < distortion_x + col_s && p.y > distortion_x - col_s * seed) {
          if (seed_x > 0.) {
            p.y = 1. - (p.y + distortion_y);
          } else {
            p.y = distortion_y;
          }
        }
        if (p.x < distortion_y + col_s && p.x > distortion_y - col_s * seed) {
          if (seed_y > 0.) {
            p.x = distortion_x;
          } else {
            p.x = 1. - (p.x + distortion_x);
          }
        }
        p.x += disp * seed_x * (seed / 5.);
        p.y += disp * seed_y * (seed / 5.);

        vec2 offset = amount * vec2(cos(angle), sin(angle));
        vec4 cr = texture2D(tDiffuse, p + offset);
        vec4 cga = texture2D(tDiffuse, p);
        vec4 cb = texture2D(tDiffuse, p - offset);
        gl_FragColor = vec4(cr.r, cga.g, cb.b, cga.a);
      } else {
        gl_FragColor = texture2D(tDiffuse, vUv);
      }
    }`,
};

export class PixelShiftGlitchPass extends Pass {
  constructor(dtSize = 64) {
    super();

    this.uniforms = UniformsUtils.clone(PixelShiftGlitchShader.uniforms);
    this.uniforms.tDisp.value = this.generateHeightmap(dtSize);

    this.material = new ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: PixelShiftGlitchShader.vertexShader,
      fragmentShader: PixelShiftGlitchShader.fragmentShader,
    });

    this.fsQuad = new FullScreenQuad(this.material);
    this.goWild = false;
  }

  generateHeightmap(dtSize) {
    const length = dtSize * dtSize;
    const data = new Float32Array(length);
    for (let i = 0; i < length; i++) {
      data[i] = MathUtils.randFloat(0, 1);
    }
    const texture = new DataTexture(data, dtSize, dtSize, RedFormat, FloatType);
    texture.needsUpdate = true;
    return texture;
  }

  render(renderer, writeBuffer, readBuffer) {
    this.uniforms.tDiffuse.value = readBuffer.texture;
    this.uniforms.seed.value = Math.random();

    if (this.goWild) {
      this.uniforms.byp.value = 0;
      this.uniforms.amount.value = Math.random() / 30;
      this.uniforms.angle.value = MathUtils.randFloat(-Math.PI, Math.PI);
      this.uniforms.seed_x.value = MathUtils.randFloat(-1, 1);
      this.uniforms.seed_y.value = MathUtils.randFloat(-1, 1);
      this.uniforms.distortion_x.value = MathUtils.randFloat(0, 1);
      this.uniforms.distortion_y.value = MathUtils.randFloat(0, 1);
    } else {
      this.uniforms.byp.value = 1;
    }

    if (this.renderToScreen) {
      renderer.setRenderTarget(null);
      this.fsQuad.render(renderer);
    } else {
      renderer.setRenderTarget(writeBuffer);
      if (this.clear) renderer.clear();
      this.fsQuad.render(renderer);
    }
  }

  dispose() {
    this.material.dispose();
    this.uniforms.tDisp.value.dispose();
    this.fsQuad.dispose();
  }
}

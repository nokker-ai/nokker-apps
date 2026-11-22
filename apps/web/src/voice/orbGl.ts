/*
 * Voice orb, WebGL layer (one fragment shader, no dependency, no texture, no network).
 *
 * Design after the `orb` component of github.com/elevenlabs/ui (MIT): a disc of flowing colour, a soft noisy ring that
 * swells with the voice level, state-driven speed. It is a from-scratch lightweight port (value noise in the shader
 * instead of three.js + a downloaded noise texture); the idea and look come from that component, whose licence says:
 *
 *   MIT License
 *   Copyright (c) 2025 Eleven Labs Inc.
 *
 *   Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated
 *   documentation files (the "Software"), to deal in the Software without restriction, including without limitation
 *   the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and
 *   to permit persons to whom the Software is furnished to do so, subject to the following conditions:
 *
 *   The above copyright notice and this permission notice shall be included in all copies or substantial portions of
 *   the Software.
 *
 *   THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO
 *   THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 *   AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT,
 *   TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 *   SOFTWARE.
 *
 * Loaded lazily (dynamic import) only when an orb is on screen. Colours come from the CSS custom properties
 * `--orb-c1` / `--orb-c2` (theme tokens), read from the element, so light and dark follow the theme.
 */
import type { OrbState } from "./orbState.js";

const VERT = `attribute vec2 p; varying vec2 v; void main(){ v = p; gl_Position = vec4(p, 0.0, 1.0); }`;
const FRAG = `precision mediump float;
varying vec2 v;
uniform float t, flow, level, sat, ring;
uniform vec3 c1, c2;
float h(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float n(vec2 p){ vec2 i = floor(p), f = fract(p); f = f*f*(3.0-2.0*f);
  return mix(mix(h(i), h(i+vec2(1.,0.)), f.x), mix(h(i+vec2(0.,1.)), h(i+vec2(1.,1.)), f.x), f.y); }
float fbm(vec2 p){ float a = 0.5, s = 0.0; for (int i = 0; i < 4; i++){ s += a*n(p); p = p*2.03 + 7.1; a *= 0.5; } return s; }
void main(){
  float r = length(v);
  float a = atan(v.y, v.x);
  vec2 q = v * 1.4 + vec2(cos(flow*0.7), sin(flow*0.9)) * 0.6;
  float f = fbm(q + fbm(q*1.3 + flow*0.5) * (0.8 + level));
  float g = clamp(f * 1.25 + (v.x - v.y) * 0.18, 0.0, 1.0);
  vec3 col = mix(c1, c2, g);
  col = mix(col, vec3(1.0), smoothstep(0.6, 1.0, f) * 0.1);
  // soft noisy ring that swells with the voice level
  float rr = 0.78 + level * 0.14 + (n(vec2(a * 2.2 + flow, t * 0.4)) - 0.5) * 0.12 * (0.4 + level);
  float rg = smoothstep(0.1, 0.0, abs(r - rr)) * (0.18 + level * 0.5) * ring;
  col = mix(col, vec3(1.0), rg);
  float edge = smoothstep(1.0, 0.9, r);
  float lum = dot(col, vec3(0.299, 0.587, 0.114));
  col = mix(vec3(lum), col, sat);
  col *= 0.95 + 0.05 * smoothstep(1.0, 0.2, r);
  gl_FragColor = vec4(col * edge, edge);
}`;

interface Target {
  speed: number;
  level: (t: number) => number;
  sat: number;
  ring: number;
}
const TARGETS: Record<Exclude<OrbState, "off">, Target> = {
  idle: { speed: 0.12, level: () => 0.12, sat: 0.85, ring: 0.3 },
  listening: { speed: 0.5, level: (t) => 0.55 + Math.sin(t * 6.4) * 0.3 * Math.sin(t * 1.3 + 1), sat: 1, ring: 1 },
  thinking: { speed: 1.5, level: (t) => 0.28 + Math.sin(t * 2.1) * 0.06, sat: 0.9, ring: 0.5 },
  speaking: { speed: 0.9, level: (t) => 0.68 + Math.sin(t * 9.2) * 0.16 + Math.sin(t * 3.7) * 0.1, sat: 1, ring: 0.9 },
  muted: { speed: 0, level: () => 0.04, sat: 0, ring: 0 },
};

const rgb = (s: string): [number, number, number] => {
  const m = s.match(/(\d+(?:\.\d+)?)[\s,]+(\d+(?:\.\d+)?)[\s,]+(\d+(?:\.\d+)?)/);
  return m ? [Number(m[1]) / 255, Number(m[2]) / 255, Number(m[3]) / 255] : [0.8, 0.2, 0.22];
};

export interface OrbGl {
  setState(s: Exclude<OrbState, "off">): void;
  destroy(): void;
}

/** Starts the orb on `canvas`; `null` when WebGL is not available (the caller keeps the CSS version). */
export function startOrbGl(canvas: HTMLCanvasElement, tokens: HTMLElement, onLost: () => void): OrbGl | null {
  const gl = canvas.getContext("webgl", { alpha: true, premultipliedAlpha: true, antialias: true }) as WebGLRenderingContext | null;
  if (!gl) return null;
  const sh = (type: number, src: string): WebGLShader | null => {
    const s = gl.createShader(type);
    if (!s) return null;
    gl.shaderSource(s, src);
    gl.compileShader(s);
    return gl.getShaderParameter(s, gl.COMPILE_STATUS) ? s : null;
  };
  const vs = sh(gl.VERTEX_SHADER, VERT);
  const fs = sh(gl.FRAGMENT_SHADER, FRAG);
  const prog = gl.createProgram();
  if (!vs || !fs || !prog) return null;
  gl.attachShader(prog, vs);
  gl.attachShader(prog, fs);
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return null;
  gl.useProgram(prog);
  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  const loc = gl.getAttribLocation(prog, "p");
  gl.enableVertexAttribArray(loc);
  gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
  const U = (n: string): WebGLUniformLocation | null => gl.getUniformLocation(prog, n);
  const u = { t: U("t"), flow: U("flow"), level: U("level"), sat: U("sat"), ring: U("ring"), c1: U("c1"), c2: U("c2") };
  gl.enable(gl.BLEND);
  gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

  let state: Exclude<OrbState, "off"> = "idle";
  let raf = 0;
  let last = 0;
  let time = 0;
  let flow = 0;
  let speed = 0.12;
  let level = 0.12;
  let sat = 0.85;
  let ring = 0.3;
  let colours: [[number, number, number], [number, number, number]] = [[0.8, 0.2, 0.22], [0.9, 0.5, 0.2]];
  let colourAge = 1e9;
  let dead = false;

  const resize = (): void => {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.max(1, Math.round(canvas.clientWidth * dpr));
    if (canvas.width !== w) {
      canvas.width = w;
      canvas.height = w;
    }
    gl.viewport(0, 0, canvas.width, canvas.height);
  };
  const frame = (now: number): void => {
    if (dead) return;
    const dt = Math.min(0.05, (now - last) / 1000 || 0.016);
    last = now;
    time += dt;
    const tg = TARGETS[state];
    speed += (tg.speed - speed) * 0.08;
    level += (tg.level(time) - level) * 0.2;
    sat += (tg.sat - sat) * 0.08;
    ring += (tg.ring - ring) * 0.08;
    flow += dt * speed;
    colourAge += dt;
    if (colourAge > 0.5) {
      colourAge = 0;
      const cs = getComputedStyle(tokens);
      colours = [rgb(cs.getPropertyValue("--orb-c1")), rgb(cs.getPropertyValue("--orb-c2"))];
    }
    resize();
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.uniform1f(u.t, time);
    gl.uniform1f(u.flow, flow);
    gl.uniform1f(u.level, level);
    gl.uniform1f(u.sat, sat);
    gl.uniform1f(u.ring, ring);
    gl.uniform3f(u.c1, ...colours[0]);
    gl.uniform3f(u.c2, ...colours[1]);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    raf = requestAnimationFrame(frame);
  };
  const lost = (e: Event): void => {
    e.preventDefault();
    dead = true;
    cancelAnimationFrame(raf);
    onLost();
  };
  canvas.addEventListener("webglcontextlost", lost);
  raf = requestAnimationFrame(frame);
  return {
    setState: (s) => {
      state = s;
    },
    destroy: () => {
      dead = true;
      cancelAnimationFrame(raf);
      canvas.removeEventListener("webglcontextlost", lost);
      gl.getExtension("WEBGL_lose_context")?.loseContext();
    },
  };
}

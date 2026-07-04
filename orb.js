// The Orb — faithful WebGL port of the native iOS renderer (OrbMetalView.swift):
// three nested swarms ("an orb within an orb"), additive point sprites with a
// radial core/halo falloff, per-swarm connection lines, quarter-res bloom, and
// an exponential tonemap. Same constants, same state machine, same autonomous
// surges and spontaneous deep-thoughts. Pointer lean stands in for the gyro.
import * as THREE from "three";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { ShaderPass } from "three/addons/postprocessing/ShaderPass.js";

const POINT_VERT = `
uniform float focalPx; uniform float pointSize; uniform float bright;
varying float vBright;
void main() {
  vec4 vp = modelViewMatrix * vec4(position, 1.0);
  float vd = max(0.001, -vp.z);
  gl_Position = projectionMatrix * vp;
  gl_PointSize = clamp(pointSize * focalPx / vd, 3.0, 26.0);
  vBright = bright * clamp(44.0 / vd, 0.5, 1.5);
}`;
const POINT_FRAG = `
uniform vec3 coreColor; uniform vec3 edgeColor;
varying float vBright;
void main() {
  float d = length(gl_PointCoord - vec2(0.5)) * 2.0;
  if (d > 1.0) discard;
  float k = clamp(1.0 - d, 0.0, 1.0);
  float core = pow(k, 3.0); float halo = pow(k, 1.3) * 0.4;
  float a = (core + halo) * vBright;
  gl_FragColor = vec4(mix(edgeColor, coreColor, core) * a, a);
}`;
const LINE_VERT = `
uniform float lineBright;
varying float vBright;
void main() {
  vec4 vp = modelViewMatrix * vec4(position, 1.0);
  float vd = max(0.001, -vp.z);
  gl_Position = projectionMatrix * vp;
  vBright = lineBright * 0.22 * clamp(55.0 / vd, 0.2, 1.0);
}`;
const LINE_FRAG = `
uniform vec3 edgeColor;
varying float vBright;
void main() { gl_FragColor = vec4(edgeColor * vBright, vBright); }`;
const TONEMAP = {
  uniforms: { tDiffuse: { value: null } },
  vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix*modelViewMatrix*vec4(position,1.0); }`,
  fragmentShader: `uniform sampler2D tDiffuse; varying vec2 vUv;
    void main(){ vec3 c = texture2D(tDiffuse, vUv).rgb; c = 1.0 - exp(-c * 1.5); gl_FragColor = vec4(c, 1.0); }`,
};

class Swarm {
  constructor({ N, baseRadius, spinSpeed, sizeScale, brightScale, seed, edge, core, ax, shellBias }) {
    Object.assign(this, { N, baseRadius, spinSpeed, sizeScale, brightScale, seed });
    this.lineDistance = baseRadius * 0.5;
    this.maxLines = 6000;
    this.ax = new THREE.Vector3(...ax).normalize();
    this.curRadius = baseRadius; this.curSpeed = 0.3; this.curBright = 0.6; this.curSize = 0.4;
    this.lineAmount = 0; this.spin = 0; this.cloudZ = 0; this.cloudZVel = 0;

    this.pos = new Float32Array(N * 3);
    this.vel = new Float32Array(N * 3);
    this.phase = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      const th = Math.random() * Math.PI * 2, ph = Math.acos(2 * Math.random() - 1);
      const rf = Math.sqrt(Math.random());
      const rs = 0.80 + 0.20 * Math.random();
      const r = (rf * (1 - shellBias) + rs * shellBias) * baseRadius;
      this.pos[i*3] = r * Math.sin(ph) * Math.cos(th);
      this.pos[i*3+1] = r * Math.sin(ph) * Math.sin(th);
      this.pos[i*3+2] = r * Math.cos(ph);
      this.phase[i] = Math.random() * 1000;
    }

    this.geo = new THREE.BufferGeometry();
    this.geo.setAttribute("position", new THREE.BufferAttribute(this.pos, 3));
    this.mat = new THREE.ShaderMaterial({
      vertexShader: POINT_VERT, fragmentShader: POINT_FRAG,
      uniforms: {
        focalPx: { value: 1000 }, pointSize: { value: 1 }, bright: { value: 1 },
        coreColor: { value: new THREE.Color(...core) }, edgeColor: { value: new THREE.Color(...edge) },
      },
      transparent: true, depthWrite: false, depthTest: false, blending: THREE.AdditiveBlending,
    });
    this.points = new THREE.Points(this.geo, this.mat);
    this.points.frustumCulled = false;

    this.linePos = new Float32Array(this.maxLines * 6);
    this.lineGeo = new THREE.BufferGeometry();
    this.lineGeo.setAttribute("position", new THREE.BufferAttribute(this.linePos, 3));
    this.lineGeo.setDrawRange(0, 0);
    this.lineMat = new THREE.ShaderMaterial({
      vertexShader: LINE_VERT, fragmentShader: LINE_FRAG,
      uniforms: { lineBright: { value: 0 }, edgeColor: { value: new THREE.Color(...edge) } },
      transparent: true, depthWrite: false, depthTest: false, blending: THREE.AdditiveBlending,
    });
    this.lines = new THREE.LineSegments(this.lineGeo, this.lineMat);
    this.lines.frustumCulled = false;

    this.group = new THREE.Group();
    this.group.add(this.lines, this.points);
  }

  step(t, dts, state, audio, surge, intro) {
    let tr = this.baseRadius, ts = 0.2, tb = 0.6, tsz = 0.4, tla = 0.4;
    switch (state) {
      case "idle":      tr = this.baseRadius * 1.0;  ts = 0.22; tb = 0.6;  tsz = 0.4;  tla = 0.4;  break;
      case "listening": tr = this.baseRadius * 1.06; ts = 0.45; tb = 0.95; tsz = 0.44; tla = 0.75; break;
      case "thinking":  tr = this.baseRadius * 0.58; ts = 0.75; tb = 1.15; tsz = 0.36; tla = 1.0;  break;
      case "speaking":  tr = this.baseRadius * (0.95 + audio * 0.3); ts = 0.3; tb = 1.15; tsz = 0.46; tla = 0.9; break;
    }
    if (intro) { tr = this.baseRadius * 0.92; tb = Math.max(tb, 1.05); ts = Math.max(ts, 0.55); tla = 1.0; }
    tb += surge * 0.6; tla = Math.min(1.0, tla + surge * 0.5); tr *= (1 + surge * 0.05);
    const e = 0.05 * dts;
    this.curRadius += (tr - this.curRadius) * e;
    this.curSpeed  += (ts - this.curSpeed) * e;
    this.curBright += (tb - this.curBright) * e;
    this.curSize   += (tsz - this.curSize) * e;
    this.lineAmount += (tla - this.lineAmount) * e;
    this.spin += this.spinSpeed * 0.016 * dts;

    let zT = Math.sin(t * 0.12 + this.seed) * (this.baseRadius * 0.3);
    if (state === "thinking") zT = (Math.sin(t*0.3+this.seed)*15 + Math.sin(t*0.9+this.seed)*6) * (this.baseRadius/28);
    this.cloudZVel += (zT - this.cloudZ) * 0.008 * dts;
    this.cloudZVel *= Math.pow(0.94, dts);
    this.cloudZ += this.cloudZVel * dts;

    const p = this.pos, v = this.vel;
    for (let i = 0; i < this.N; i++) {
      const i3 = i * 3, px = this.phase[i] + this.seed;
      const x = p[i3], y = p[i3+1], z = p[i3+2];
      v[i3]   += (Math.sin(t*0.05 + px) * 0.001 + Math.sin(t*0.02 + px*2.1 + y*0.1) * 0.0008) * this.curSpeed * dts;
      v[i3+1] += (Math.cos(t*0.06 + px*1.3) * 0.001 + Math.cos(t*0.025 + px*1.7 + z*0.1) * 0.0008) * this.curSpeed * dts;
      v[i3+2] += (Math.sin(t*0.055 + px*0.7) * 0.001 + Math.sin(t*0.022 + px*0.9 + x*0.1) * 0.0008) * this.curSpeed * dts;
      const dist = Math.max(0.01, Math.hypot(x, y, z));
      const pull = Math.max(0, dist - this.curRadius) * 0.002 + 0.0003;
      v[i3] -= (x/dist) * pull * dts; v[i3+1] -= (y/dist) * pull * dts; v[i3+2] -= (z/dist) * pull * dts;
      if (audio > 0.05) { v[i3] += (x/dist)*audio*0.02*dts; v[i3+1] += (y/dist)*audio*0.02*dts; v[i3+2] += (z/dist)*audio*0.02*dts; }
      const damp = Math.pow(0.992, dts);
      v[i3] *= damp; v[i3+1] *= damp; v[i3+2] *= damp;
      p[i3] += v[i3]; p[i3+1] += v[i3+1]; p[i3+2] += v[i3+2];
    }
    this.geo.attributes.position.needsUpdate = true;
  }

  buildLines(audio) {
    if (this.lineAmount <= 0.01) { this.lineGeo.setDrawRange(0, 0); return; }
    const maxDist = this.lineDistance * (1 + audio * 0.5);
    const maxDistSq = maxDist * maxDist;
    const step = Math.max(2, Math.floor(this.N / 350));
    const p = this.pos, lp = this.linePos;
    let count = 0;
    for (let i = 0; i < this.N && count < this.maxLines; i += step) {
      const i3 = i * 3, x1 = p[i3], y1 = p[i3+1], z1 = p[i3+2];
      for (let j = i + step; j < this.N && count < this.maxLines; j += step) {
        const j3 = j * 3, dx = p[j3]-x1, dy = p[j3+1]-y1, dz = p[j3+2]-z1;
        if (dx*dx + dy*dy + dz*dz < maxDistSq) {
          const k = count * 6;
          lp[k]=x1; lp[k+1]=y1; lp[k+2]=z1; lp[k+3]=p[j3]; lp[k+4]=p[j3+1]; lp[k+5]=p[j3+2];
          count++;
        }
      }
    }
    this.lineGeo.setDrawRange(0, count * 2);
    this.lineGeo.attributes.position.needsUpdate = true;
  }
}

export function createOrb(canvas) {
  let destroyed = false;
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: false });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.setSize(innerWidth, innerHeight);
  renderer.setClearColor(0x000000, 1);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(45, innerWidth / innerHeight, 1, 1000);

  // Back → front, exactly the Metal init: outer shell, mid cloud, bright nucleus.
  const outer = new Swarm({ N: 1000, baseRadius: 21, spinSpeed: 0.13, sizeScale: 0.8, brightScale: 0.6,
    seed: 37.0, edge: [0.20,0.52,0.95], core: [0.45,0.74,1.0], ax: [0.45, 0.0, -0.9], shellBias: 0.7 });
  const mid = new Swarm({ N: 800, baseRadius: 13, spinSpeed: -0.23, sizeScale: 0.95, brightScale: 0.95,
    seed: 19.0, edge: [0.30,0.68,1.0], core: [0.7,0.9,1.0], ax: [1.0, 0.25, 0.35], shellBias: 0.35 });
  const inner = new Swarm({ N: 600, baseRadius: 6, spinSpeed: 0.34, sizeScale: 1.2, brightScale: 1.6,
    seed: 0, edge: [0.62,0.86,1.0], core: [0.95,0.99,1.0], ax: [0.15, 1.0, 0.0], shellBias: 0.0 });
  const swarms = [outer, mid, inner];
  swarms.forEach(s => scene.add(s.group));

  const composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  const bloom = new UnrealBloomPass(new THREE.Vector2(innerWidth, innerHeight), 0.65, 0.5, 0.0);
  composer.addPass(bloom);
  composer.addPass(new ShaderPass(TONEMAP));

  let state = "thinking";                 // the launch intro plays as a deep thought
  let audioLevel = 0;
  let surge = 0, surgeTimer = 3;
  let deepUntil = 0, nextDeep = 0, lastActive = 0;
  const start = performance.now() / 1000;
  let last = start;
  let introUntil = start + 1.4;
  let tiltX = 0, tiltY = 0, tgtTX = 0, tgtTY = 0;

  addEventListener("pointermove", ev => {   // the gyro "looks at you", web edition
    tgtTX = Math.max(-0.7, Math.min(0.7, (ev.clientX / innerWidth - 0.5) * 0.9));
    tgtTY = Math.max(-0.7, Math.min(0.7, (0.5 - ev.clientY / innerHeight) * 0.9));
  }, { passive: true });

  nextDeep = start + 25 + Math.random() * 30;

  function frame() {
    if (destroyed) return;
    requestAnimationFrame(frame);
    const now = performance.now() / 1000;
    const t = now - start;
    const dt = Math.min(Math.max(now - last, 0), 0.05); last = now;
    const dts = Math.min(dt * 60, 3);
    if (introUntil !== 0 && now >= introUntil && state === "thinking") { state = "idle"; introUntil = 0; }

    tiltX += (tgtTX - tiltX) * 0.14 * dts;
    tiltY += (tgtTY - tiltY) * 0.14 * dts;

    if (state !== "idle") lastActive = now;
    const restless = Math.max(0, Math.min(1, (now - lastActive) / 120));

    let effState = state;
    if (state === "idle") {
      if (now >= nextDeep) {
        deepUntil = now + 2 + Math.random() * 1.5;
        nextDeep = now + (35 + Math.random() * 40) - restless * 18;
      }
      if (now < deepUntil) effState = "thinking";
    } else { deepUntil = 0; nextDeep = now + 35 + Math.random() * 40; }

    surge *= Math.pow(0.93, dts);
    surgeTimer -= dt;
    if (surgeTimer <= 0) {
      surge = Math.max(surge, 0.45 + Math.random() * 0.4);
      surgeTimer = 11 + Math.random() * 15 - restless * 6;
    }

    const intro = introUntil !== 0 && now < introUntil;
    for (const s of swarms) { s.step(t, dts, effState, audioLevel, surge, intro); s.buildLines(audioLevel); }

    // camera — fitZ from the Metal uniforms (×0.74: the Metal value fit a
    // phone panel; the hero wants the orb commanding the viewport)
    const aspect = innerWidth / innerHeight;
    const fitZ = Math.max(120, Math.min(172, 112 + (1 - aspect) * 60)) * 0.74;
    camera.aspect = aspect; camera.updateProjectionMatrix();
    camera.position.set(-tiltX * 11, tiltY * 11, fitZ);
    camera.lookAt(0, 0, 0);
    const focalPx = renderer.domElement.height / (2 * Math.tan((45 * Math.PI / 180) / 2));

    for (const s of swarms) {
      s.group.rotation.set(0.3 + tiltY, tiltX, 0);
      s.group.rotateOnAxis(s.ax, s.spin);
      s.group.position.z = s.cloudZ;
      s.group.position.y = 7;   // orb rides above center; the words live below
      s.mat.uniforms.focalPx.value = focalPx;
      // the app renders at contentScaleFactor 3 — floor the term so desktop
      // sprites keep the same body the phone look was tuned on
      s.mat.uniforms.pointSize.value = s.curSize * 0.42 * s.sizeScale *
        Math.max(Math.min(devicePixelRatio, 3), 2);
      s.mat.uniforms.bright.value = s.curBright * 1.7 * s.brightScale;
      s.lineMat.uniforms.lineBright.value = s.lineAmount * 0.55;
    }
    composer.render();
  }

  function onResize() {
    renderer.setSize(innerWidth, innerHeight);
    composer.setSize(innerWidth, innerHeight);
  }
  addEventListener("resize", onResize);
  frame();

  return {
    setState(s) {
      if (performance.now() / 1000 < introUntil) {
        if (s === "idle") return;
        introUntil = 0;
      }
      state = s;
    },
    setAudioLevel(l) { audioLevel = Math.max(0, Math.min(1, l)); },
    poke(amount = 0.45) { surge = Math.max(surge, amount); },
    destroy() { destroyed = true; renderer.dispose(); },
  };
}

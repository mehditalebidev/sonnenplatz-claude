import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { sunPosition, compass } from "./sun.js";

const $ = (s) => document.querySelector(s);
const LAT = 48.1374, LON = 11.5755; // Marienplatz: sun position is computed here for the whole city
const TZ = "Europe/Berlin";
const REDUCED = matchMedia("(prefers-reduced-motion: reduce)").matches;
const MOBILE = () => innerWidth <= 820;
const store = { get(k, d) { try { const v = localStorage.getItem("sonnenplatz:" + k); return v == null ? d : JSON.parse(v); } catch { return d; } }, set(k, v) { try { localStorage.setItem("sonnenplatz:" + k, JSON.stringify(v)); } catch {} } };

// ---------------------------------------------------------------- Munich time helpers
const fmt = new Intl.DateTimeFormat("en-GB", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
function parts(ms) { const o = {}; for (const p of fmt.formatToParts(ms)) o[p.type] = p.value; return { y: +o.year, mo: +o.month, d: +o.day, h: +o.hour, mi: +o.minute, s: +o.second }; }
const tzOffset = (ms) => { const p = parts(ms); return Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s) - Math.floor(ms / 1000) * 1000; };
function berlin(y, mo, d, h = 0, mi = 0) { const g = Date.UTC(y, mo - 1, d, h, mi); let ms = g - tzOffset(g); const o2 = tzOffset(ms); if (g - o2 !== ms) ms = g - o2; return ms; }
const midnightOf = (ms) => { const p = parts(ms); return berlin(p.y, p.mo, p.d); };
const pad = (n) => String(n).padStart(2, "0");
const hhmm = (ms) => { const p = parts(ms); return pad(p.h) + ":" + pad(p.mi); };
const dayLabel = (ms) => {
  const diff = Math.round((midnightOf(ms) - midnightOf(Date.now())) / 864e5);
  if (diff === 0) return "Today"; if (diff === 1) return "Tomorrow"; if (diff === -1) return "Yesterday";
  return new Intl.DateTimeFormat("en-GB", { timeZone: TZ, weekday: "short", day: "numeric", month: "short" }).format(ms);
};
const longDate = (ms) => new Intl.DateTimeFormat("en-GB", { timeZone: TZ, weekday: "long", day: "numeric", month: "long" }).format(ms);
const dur = (min) => { min = Math.round(min); const h = Math.floor(min / 60), m = min % 60; return h ? `${h} h ${pad(m)} m` : `${m} min`; };

// ---------------------------------------------------------------- state
const S = {
  gardens: [], byId: new Map(), H: null, meta: null,
  sel: null, live: true, t: Date.now(), day: null, weather: null,
  playing: false, filter: "sunny", q: "", muted: store.get("muted", false),
};

// ---------------------------------------------------------------- day tables
// For every garden, share of its sample points in sun for each minute of the day (0–255).
function buildDay(ms) {
  const m0 = midnightOf(ms), p = parts(m0), m1 = berlin(p.y, p.mo, p.d + 1);
  const N = Math.round((m1 - m0) / 60000);
  const alt = new Float32Array(N + 1), az = new Float32Array(N + 1);
  for (let i = 0; i <= N; i++) { const s = sunPosition(m0 + i * 60000, LAT, LON); alt[i] = s.alt; az[i] = s.az; }
  let rise = null, set = null, noon = 0;
  for (let i = 1; i <= N; i++) {
    if (alt[i - 1] < -0.833 && alt[i] >= -0.833 && rise == null) rise = i;
    if (alt[i - 1] >= -0.833 && alt[i] < -0.833) set = i;
    if (alt[i] > alt[noon]) noon = i;
  }
  const H = S.H, share = new Map();
  for (const g of S.gardens) {
    const arr = new Uint8Array(N + 1), n = g.n, base = g.h * 360;
    for (let i = 0; i <= N; i++) {
      if (alt[i] <= 0.3) continue;
      const a2 = alt[i] * 2, k = Math.round(az[i]) % 360;
      let c = 0;
      for (let j = 0; j < n; j++) if (a2 > H[base + j * 360 + k]) c++;
      arr[i] = Math.round((c / n) * 255);
    }
    share.set(g.id, arr);
  }
  return { m0, m1, N, alt, az, rise, set, noon, share };
}
const minuteOf = (ms) => Math.max(0, Math.min(S.day.N, Math.round((ms - S.day.m0) / 60000)));
const atMin = (i) => S.day.m0 + i * 60000;

const SUNNY = 128, PART = 38; // ≥50 % of the garden lit = sunny, ≥15 % = partly
const cls = (v, alt) => alt <= 0.3 ? "night" : v >= SUNNY ? "sun" : v >= PART ? "part" : "shade";
function status(g, i) {
  const d = S.day, arr = d.share.get(g.id), v = arr[i], c = cls(v, d.alt[i]);
  let left = 0; for (let j = i; j <= d.N; j++) if (arr[j] >= SUNNY) left++;
  // first minute after i where fn holds for 10 minutes in a row (or until the sun sets), so tiny flickers don't count
  const find = (fn) => {
    for (let j = i + 1; j <= d.N; j++) {
      if (!fn(arr[j], j)) continue;
      let ok = true;
      for (let k = j + 1; k < Math.min(j + 10, d.N); k++) if (!fn(arr[k], k) && d.alt[k] > 0.3) { ok = false; break; }
      if (ok) return j;
    }
    return null;
  };
  const setMin = d.set ?? d.N;
  let text;
  if (c === "night") {
    const next = d.rise != null && i < d.rise ? find((x) => x >= SUNNY) : null;
    text = next != null ? `Sun is down · first sun here <b>${hhmm(atMin(next))}</b>`
      : d.set != null && i < d.set ? `Sun is on the horizon · sunset <b>${hhmm(atMin(d.set))}</b>`
      : `Sun is down · sunset was <b>${d.set != null ? hhmm(atMin(d.set)) : "–"}</b>`;
  } else if (c === "sun") {
    const j = find((x) => x < SUNNY);
    text = j == null || j >= setMin - 2 ? `Sunny until sunset, <b>${hhmm(atMin(setMin))}</b>` : `Sunny until <b>${hhmm(atMin(j))}</b>, then shade`;
    if (j != null && j < setMin - 2) { const back = find((x, k) => k > j && x >= SUNNY); if (back) text += ` · back at ${hhmm(atMin(back))}`; }
  } else if (c === "part") {
    const up = find((x) => x >= SUNNY), down = find((x) => x < PART);
    text = up != null && (down == null || up < down) ? `Partly sunny · full sun at <b>${hhmm(atMin(up))}</b>` : down != null && down < setMin - 2 ? `Partly sunny until <b>${hhmm(atMin(down))}</b>` : `Partly sunny until sunset`;
  } else {
    const up = find((x) => x >= SUNNY), some = find((x) => x >= PART);
    text = up != null ? `In the shade · sun from <b>${hhmm(atMin(up))}</b>` : some != null ? `In the shade · some sun from <b>${hhmm(atMin(some))}</b>` : `In the shade · no more sun today`;
  }
  return { v, pct: Math.round((v / 255) * 100), c, left, text };
}

// ---------------------------------------------------------------- weather (Open-Meteo)
const WMO = { 0: "Clear sky", 1: "Mostly clear", 2: "Partly cloudy", 3: "Overcast", 45: "Fog", 48: "Rime fog", 51: "Light drizzle", 53: "Drizzle", 55: "Heavy drizzle", 61: "Light rain", 63: "Rain", 65: "Heavy rain", 66: "Freezing rain", 67: "Freezing rain", 71: "Light snow", 73: "Snow", 75: "Heavy snow", 77: "Snow grains", 80: "Showers", 81: "Showers", 82: "Heavy showers", 85: "Snow showers", 86: "Snow showers", 95: "Thunderstorm", 96: "Thunderstorm, hail", 99: "Thunderstorm, hail" };
async function loadWeather() {
  try {
    const u = `https://api.open-meteo.com/v1/forecast?latitude=${LAT}&longitude=${LON}&hourly=temperature_2m,cloud_cover,weather_code&current=temperature_2m,cloud_cover,weather_code&timezone=Europe%2FBerlin&past_days=1&forecast_days=7`;
    const r = await fetch(u); if (!r.ok) throw new Error(r.status);
    const j = await r.json();
    const hours = j.hourly.time.map((t, i) => {
      const [dt, tm] = t.split("T"), [y, mo, d] = dt.split("-").map(Number), [h] = tm.split(":").map(Number);
      return { ms: berlin(y, mo, d, h), temp: j.hourly.temperature_2m[i], cloud: j.hourly.cloud_cover[i], code: j.hourly.weather_code[i] };
    });
    S.weather = { hours, current: j.current, fetched: Date.now() };
  } catch (e) { console.warn("weather unavailable", e); S.weather = null; }
  drawStrip(); renderAll();
}
function weatherAt(ms) {
  if (!S.weather) return null;
  if (S.live && S.weather.current) { const c = S.weather.current; return { temp: c.temperature_2m, cloud: c.cloud_cover, code: c.weather_code }; }
  let best = null, bd = Infinity;
  for (const h of S.weather.hours) { const d = Math.abs(h.ms + 1800e3 - ms); if (d < bd) { bd = d; best = h; } }
  return bd <= 3600e3 ? best : null;
}

// ---------------------------------------------------------------- sound
let actx = null;
function audio() { if (!actx) { try { actx = new (window.AudioContext || window.webkitAudioContext)(); } catch { return null; } } if (actx.state === "suspended") actx.resume(); return actx; }
function clink() {
  if (S.muted) return; const a = audio(); if (!a) return;
  const t = a.currentTime, out = a.createGain(); out.gain.value = 0.16; out.connect(a.destination);
  for (const [f, d] of [[2380, 0.9], [3170, 0.6], [4130, 0.35], [5520, 0.2]]) {
    const o = a.createOscillator(), g = a.createGain(); o.frequency.value = f * (0.99 + Math.random() * 0.02); o.type = "sine";
    g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(d, t + 0.004); g.gain.exponentialRampToValueAtTime(0.0008, t + 0.5 + d);
    o.connect(g).connect(out); o.start(t); o.stop(t + 1.6);
  }
}
function tick(bright) {
  if (S.muted || !actx) return;
  const a = actx, t = a.currentTime, o = a.createOscillator(), g = a.createGain();
  o.type = "triangle"; o.frequency.value = bright ? 880 : 520;
  g.gain.setValueAtTime(0.05, t); g.gain.exponentialRampToValueAtTime(0.0005, t + 0.12);
  o.connect(g).connect(a.destination); o.start(t); o.stop(t + 0.14);
}

// ---------------------------------------------------------------- three.js scene
const stage = $("#stage");
const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
stage.appendChild(renderer.domElement);
const scene = new THREE.Scene();
const VIEW = 700; // metres visible vertically at zoom 1
const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 1, 6000);
camera.position.set(0, 1100, 1100);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true; controls.dampingFactor = 0.09;
controls.minPolarAngle = 0.12; controls.maxPolarAngle = 1.2;
controls.minZoom = 0.55; controls.maxZoom = 9;
controls.zoomToCursor = true;
controls.screenSpacePanning = false;
controls.addEventListener("change", () => { const t = controls.target; const r = Math.hypot(t.x, t.z); if (r > 260) { t.x *= 260 / r; t.z *= 260 / r; } t.y = 0; wake(); });

const hemi = new THREE.HemisphereLight(0xcfdcff, 0xf3e3c8, 1.0);
scene.add(hemi);
const sunLight = new THREE.DirectionalLight(0xffffff, 2.6);
sunLight.castShadow = true;
const SM = MOBILE() ? 2048 : 4096;
sunLight.shadow.mapSize.set(SM, SM);
Object.assign(sunLight.shadow.camera, { left: -320, right: 320, top: 320, bottom: -320, near: 10, far: 3000 });
sunLight.shadow.bias = -0.0004; sunLight.shadow.normalBias = 0.35;
scene.add(sunLight, sunLight.target);

// sun marker + daily path around the diorama
const ARC_R = 470;
const sunBall = new THREE.Group();
sunBall.add(new THREE.Mesh(new THREE.SphereGeometry(11, 24, 16), new THREE.MeshBasicMaterial({ color: 0xffd35a })));
{
  const c = document.createElement("canvas"); c.width = c.height = 128; const x = c.getContext("2d");
  const gr = x.createRadialGradient(64, 64, 4, 64, 64, 64); gr.addColorStop(0, "rgba(255,214,110,.9)"); gr.addColorStop(0.35, "rgba(255,200,80,.35)"); gr.addColorStop(1, "rgba(255,200,80,0)");
  x.fillStyle = gr; x.fillRect(0, 0, 128, 128);
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(c), depthWrite: false, transparent: true }));
  sp.scale.set(110, 110, 1); sunBall.add(sp);
}
scene.add(sunBall);
let sunPath = null;
function buildSunPath() {
  if (sunPath) { scene.remove(sunPath); sunPath.geometry.dispose(); }
  const pts = []; const d = S.day;
  for (let i = 0; i <= d.N; i += 6) if (d.alt[i] > -1) pts.push(sunDir(d.alt[i], d.az[i]).multiplyScalar(ARC_R));
  const g = new THREE.BufferGeometry().setFromPoints(pts);
  sunPath = new THREE.Line(g, new THREE.LineDashedMaterial({ color: 0xf2b134, dashSize: 6, gapSize: 7, transparent: true, opacity: 0.7 }));
  sunPath.computeLineDistances(); scene.add(sunPath);
}
function sunDir(alt, az) {
  const a = THREE.MathUtils.degToRad(alt), z = THREE.MathUtils.degToRad(az);
  return new THREE.Vector3(Math.sin(z) * Math.cos(a), Math.sin(a), -Math.cos(z) * Math.cos(a));
}

// soft contact shadow under the diorama
{
  const c = document.createElement("canvas"); c.width = c.height = 256; const x = c.getContext("2d");
  const gr = x.createRadialGradient(128, 128, 60, 128, 128, 128); gr.addColorStop(0, "rgba(70,70,110,.35)"); gr.addColorStop(1, "rgba(70,70,110,0)");
  x.fillStyle = gr; x.fillRect(0, 0, 256, 256);
  const m = new THREE.Mesh(new THREE.PlaneGeometry(900, 900), new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(c), transparent: true, depthWrite: false }));
  m.rotation.x = -Math.PI / 2; m.position.y = -26; scene.add(m);
}

const PAL = {
  ground: 0xece5d6, soil: 0xc9a27f, soilDark: 0xa98163,
  park: 0xb6d99a, grass: 0xc3e0a6, pitch: 0x9fd08f, wood: 0x8fc27e, water: 0x93cbe6, paved: 0xf5efe3,
  road: 0xfdfaf4, path: 0xf6eee0, rail: 0xb7aaa6, tram: 0xc9bdb6, stream: 0x93cbe6,
  walls: [0xf6efe2, 0xf2e8d8, 0xf8f2e8, 0xefe4d3, 0xf4ebe0],
  roofsLow: [0xe39a82, 0xd9886f, 0xe8a88f, 0xcf7f69, 0xe0a07f],
  roofsFlat: [0xdcd8e4, 0xd2d6df, 0xe4ddd0, 0xd8d3dc, 0xcfd8d6],
  garden: 0xffcf4d, dotSun: 0xffb71c, dotShade: 0x5d68a3,
};
let world = null; // THREE.Group for the current garden
let dots = null, sceneGardens = [];
const matCache = {};
const lambert = (color, extra = {}) => new THREE.MeshLambertMaterial({ color, ...extra });

function shapeOf(flat, Cls = THREE.Shape) {
  const s = new Cls();
  for (let i = 0; i < flat.length; i += 2) { const x = flat[i] / 10, y = flat[i + 1] / 10; i ? s.lineTo(x, y) : s.moveTo(x, y); }
  return s;
}
function flatGeo(flat, y) { const g = new THREE.ShapeGeometry(shapeOf(flat)); g.rotateX(-Math.PI / 2); g.translate(0, y, 0); return g; }
function ribbon(lines, y) {
  const pos = [];
  const push = (ax, az, bx, bz, cx, cz) => pos.push(ax, y, az, bx, y, bz, cx, y, cz);
  for (const [flat, w] of lines) {
    const hw = w / 2;
    for (let i = 0; i + 3 < flat.length; i += 2) {
      const x1 = flat[i] / 10, z1 = -flat[i + 1] / 10, x2 = flat[i + 2] / 10, z2 = -flat[i + 3] / 10;
      const dx = x2 - x1, dz = z2 - z1, L = Math.hypot(dx, dz) || 1, nx = (-dz / L) * hw, nz = (dx / L) * hw;
      push(x1 + nx, z1 + nz, x2 + nx, z2 + nz, x2 - nx, z2 - nz); push(x1 + nx, z1 + nz, x2 - nx, z2 - nz, x1 - nx, z1 - nz);
    }
    if (hw >= 1.5) for (let i = 2; i + 2 < flat.length; i += 2) { // round joins
      const cx = flat[i] / 10, cz = -flat[i + 1] / 10;
      for (let k = 0; k < 8; k++) { const a = (k / 8) * Math.PI * 2, b = ((k + 1) / 8) * Math.PI * 2; push(cx, cz, cx + Math.cos(b) * hw, cz + Math.sin(b) * hw, cx + Math.cos(a) * hw, cz + Math.sin(a) * hw); } // counter-clockwise seen from above
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  const n = new Float32Array(pos.length); for (let i = 1; i < n.length; i += 3) n[i] = 1;
  g.setAttribute("normal", new THREE.BufferAttribute(n, 3));
  return g;
}
const hash = (n) => { n = Math.imul(n ^ (n >>> 15), 0x2c1b3c6d); n = Math.imul(n ^ (n >>> 12), 0x297a2d39); return (n ^ (n >>> 15)) >>> 0; };

function buildBuildings(list) {
  const geos = [], col = new THREE.Color();
  list.forEach(([h10, outer, ...inner], idx) => {
    try {
      const shape = shapeOf(outer);
      for (const r of inner) shape.holes.push(shapeOf(r, THREE.Path));
      const h = h10 / 10;
      const g = new THREE.ExtrudeGeometry(shape, { depth: h, bevelEnabled: false, curveSegments: 1 });
      g.rotateX(-Math.PI / 2);
      g.deleteAttribute("uv");
      const r = hash(idx * 7919 + outer[0]);
      const wall = new THREE.Color(PAL.walls[r % PAL.walls.length]);
      const roof = new THREE.Color((h <= 11 ? PAL.roofsLow : PAL.roofsFlat)[(r >>> 8) % 5]);
      const n = g.attributes.normal, p = g.attributes.position, cnt = n.count, colors = new Float32Array(cnt * 3);
      for (let v = 0; v < cnt; v++) {
        if (n.getY(v) > 0.5) col.copy(roof);
        else { col.copy(wall); const k = 0.9 + 0.1 * Math.min(1, p.getY(v) / 6); col.multiplyScalar(k); } // slightly darker at street level
        colors[v * 3] = col.r; colors[v * 3 + 1] = col.g; colors[v * 3 + 2] = col.b;
      }
      g.setAttribute("color", new THREE.BufferAttribute(colors, 3));
      geos.push(g);
    } catch { /* malformed outline: skip */ }
  });
  if (!geos.length) return null;
  const merged = mergeGeometries(geos); geos.forEach((g) => g.dispose());
  const m = new THREE.Mesh(merged, new THREE.MeshLambertMaterial({ vertexColors: true }));
  m.castShadow = true; m.receiveShadow = true;
  return m;
}

function gardenAreaGeo(g, dx, dz, y) {
  // dx/dz: offset of this garden's centre from the scene centre (metres, world axes)
  let geo;
  if (g.area) geo = flatGeo(g.area, y);
  else { geo = new THREE.CircleGeometry(g.approx, 40); geo.rotateX(-Math.PI / 2); geo.translate(0, y, 0); }
  geo.translate(dx, 0, dz);
  return geo;
}

let sceneToken = 0;
async function loadScene(g) {
  const token = ++sceneToken;
  const r = await fetch(`data/g/${g.id}.json`);
  const data = await r.json();
  if (token !== sceneToken) return;
  if (world) { scene.remove(world); world.traverse((o) => { o.geometry?.dispose(); if (o.material && !o.material.shared) [].concat(o.material).forEach((m) => m.dispose()); }); }
  world = new THREE.Group();
  const R = S.meta.sceneR;

  // diorama base
  const base = new THREE.Mesh(new THREE.CylinderGeometry(R, R, 22, 120, 1), [lambert(PAL.soil), lambert(PAL.ground), lambert(PAL.soilDark)]);
  base.position.y = -11; base.receiveShadow = true; world.add(base);
  const lip = new THREE.Mesh(new THREE.CylinderGeometry(R + 0.2, R + 0.2, 3, 120, 1, true), lambert(0xe6dcc7));
  lip.position.y = -1.5; world.add(lip);

  // ground layers
  const layers = { park: [], grass: [], pitch: [], wood: [], water: [], paved: [] }, lines = { road: [], path: [], rail: [], tram: [], stream: [] };
  for (const [kind, flat, w] of data.g) { if (w != null) (lines[kind] ||= []).push([flat, w]); else (layers[kind] ||= []).push(flat); }
  const Y = { wood: 0.04, park: 0.06, grass: 0.08, pitch: 0.1, paved: 0.12, stream: 0.14, water: 0.16, road: 0.2, path: 0.24, tram: 0.28, rail: 0.3 };
  const addLayer = (geos, kind) => {
    if (!geos.length) return;
    const m = new THREE.Mesh(mergeGeometries(geos), lambert(PAL[kind], { side: THREE.DoubleSide }));
    m.receiveShadow = true; m.renderOrder = 1; m.name = kind; world.add(m);
  };
  for (const k of Object.keys(layers)) addLayer(layers[k].map((f) => flatGeo(f, Y[k])), k);
  for (const k of Object.keys(lines)) if (lines[k].length) addLayer([ribbon(lines[k], Y[k])], k);

  const b = buildBuildings(data.b); if (b) world.add(b);

  // beer gardens in view: the selected one bright, neighbours faint
  sceneGardens = S.gardens.filter((o) => Math.hypot(o.x - g.x, o.y - g.y) < R - 20);
  for (const o of sceneGardens) {
    const dx = o.x - g.x, dz = -(o.y - g.y), main = o === g;
    const m = new THREE.Mesh(gardenAreaGeo(o, dx, dz, main ? 0.34 : 0.32), lambert(PAL.garden, { transparent: true, opacity: main ? 0.55 : 0.3, depthWrite: false, side: THREE.DoubleSide }));
    m.receiveShadow = true; m.renderOrder = 2; world.add(m);
    if (main) { // dashed outline
      const pts = [];
      if (o.area) for (let i = 0; i <= o.area.length; i += 2) { const k = i % o.area.length; pts.push(new THREE.Vector3(o.area[k] / 10, 0.4, -o.area[k + 1] / 10)); }
      else for (let i = 0; i <= 48; i++) { const a = (i / 48) * Math.PI * 2; pts.push(new THREE.Vector3(Math.cos(a) * o.approx, 0.4, Math.sin(a) * o.approx)); }
      const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineDashedMaterial({ color: 0xe0901a, dashSize: 2.2, gapSize: 1.6 }));
      line.computeLineDistances(); world.add(line);
    }
  }

  // sample points (coloured sun / shade from the horizon table)
  const n = g.n, spacing = g.spacing;
  dots = new THREE.InstancedMesh(new THREE.CircleGeometry(Math.min(1.1, Math.max(0.45, spacing * 0.22)), 12).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0xffffff }), n);
  const mtx = new THREE.Matrix4();
  for (let j = 0; j < n; j++) { mtx.makeTranslation(g.pts[j * 2] / 10, 0.5, -g.pts[j * 2 + 1] / 10); dots.setMatrixAt(j, mtx); dots.setColorAt(j, new THREE.Color(PAL.dotShade)); }
  dots.renderOrder = 3; world.add(dots);

  scene.add(world);
  buildLabels(g);
  // frame the garden
  const ext = g.extent;
  const zoom = THREE.MathUtils.clamp(60 / ext, 1, 2.2);
  controls.target.set(0, 0, 0);
  animateCamera(zoom);
  if (!REDUCED) { world.scale.set(1, 0.001, 1); growStart = performance.now(); }
  applyTime();
  wake();
}

let growStart = 0, camAnim = null;
function animateCamera(zoom) {
  if (REDUCED) { camera.zoom = zoom; camera.updateProjectionMatrix(); return; }
  camAnim = { from: camera.zoom, to: zoom, t0: performance.now() };
}

// ---------------------------------------------------------------- labels over the 3D view
const labelsEl = $("#labels");
let labelEls = [];
function buildLabels(g) {
  labelsEl.innerHTML = ""; labelEls = [];
  for (const o of sceneGardens) {
    const el = document.createElement(o === g ? "div" : "button");
    el.className = "lbl" + (o === g ? " main" : "");
    el.innerHTML = `<i></i><span></span>`;
    el.querySelector("span").textContent = o.name;
    if (o !== g) { el.addEventListener("click", () => select(o, true)); el.setAttribute("aria-label", "Show " + o.name); }
    labelsEl.appendChild(el);
    labelEls.push({ el, o, pos: new THREE.Vector3(o.x - g.x, o === g ? 14 : 8, -(o.y - g.y)) });
  }
}
const tmpV = new THREE.Vector3();
function placeLabels() {
  const rect = stage.getBoundingClientRect();
  for (const L of labelEls) {
    tmpV.copy(L.pos).applyMatrix4(world ? world.matrixWorld : new THREE.Matrix4()).project(camera);
    const x = rect.left + (tmpV.x * 0.5 + 0.5) * rect.width, y = rect.top + (-tmpV.y * 0.5 + 0.5) * rect.height;
    const vis = Math.abs(tmpV.x) < 1.05 && Math.abs(tmpV.y) < 1.05;
    L.el.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px) translate(-50%, -100%)`;
    L.el.style.opacity = vis ? 1 : 0;
  }
}

// ---------------------------------------------------------------- render loop
let scheduled = false;
function wake() { if (!scheduled) { scheduled = true; requestAnimationFrame(frame); } }
let lastPlay = 0;
function frame(now) {
  scheduled = false;
  if (document.hidden) return;
  let busy = false;
  if (S.playing) {
    const dt = lastPlay ? Math.min(100, now - lastPlay) : 16; lastPlay = now;
    S.t += dt * 60 * 20; // 20 minutes per second
    const d = S.day;
    if (S.t > atMin(d.set ?? d.N) + 20 * 60000) S.t = atMin(Math.max(0, (d.rise ?? 0) - 20));
    applyTime(); busy = true;
  } else lastPlay = 0;
  if (camAnim) {
    const k = Math.min(1, (now - camAnim.t0) / 900), e = 1 - Math.pow(1 - k, 3);
    camera.zoom = camAnim.from + (camAnim.to - camAnim.from) * e; camera.updateProjectionMatrix();
    if (k >= 1) camAnim = null; busy = true;
  }
  if (world && growStart) {
    const k = Math.min(1, (now - growStart) / 1100);
    const e = k === 1 ? 1 : 1 + 1.6 * Math.pow(k - 1, 3) + 0.6 * Math.pow(k - 1, 2); // gentle overshoot
    world.scale.y = Math.max(0.001, e);
    if (k >= 1) growStart = 0; busy = true;
  }
  const damped = controls.update();
  if (sunPath) sunPath.material.opacity = THREE.MathUtils.clamp((1.9 - camera.zoom) / 0.6, 0, 0.7);
  renderer.render(scene, camera);
  placeLabels();
  if (busy || damped) wake();
}
document.addEventListener("visibilitychange", () => { if (!document.hidden) wake(); });

function resize() {
  const w = stage.clientWidth, h = stage.clientHeight;
  renderer.setSize(w, h);
  const vh = VIEW / 2, a = w / h;
  Object.assign(camera, { left: -vh * a, right: vh * a, top: vh, bottom: -vh });
  camera.updateProjectionMatrix();
  drawStrip(); wake();
}
addEventListener("resize", resize);

// ---------------------------------------------------------------- applying the time
const SKY = [ // [altitude, top, bottom]
  [-12, "#1e2342", "#3a3d66"], [-4, "#39406f", "#c98b8b"], [0, "#7d8fc4", "#f6c49a"], [6, "#8fc3e8", "#ffe2bd"], [15, "#9fd3f0", "#eaf5fb"], [90, "#8ccbef", "#e6f3fb"],
];
const lerpC = (a, b, k) => new THREE.Color(a).lerp(new THREE.Color(b), k);
function skyAt(alt) {
  for (let i = 1; i < SKY.length; i++) if (alt <= SKY[i][0] || i === SKY.length - 1) {
    const [a0, t0, b0] = SKY[i - 1], [a1, t1, b1] = SKY[i], k = THREE.MathUtils.clamp((alt - a0) / (a1 - a0), 0, 1);
    return [lerpC(t0, t1, k), lerpC(b0, b1, k)];
  }
}
let lastSky = "";
function applyTime() {
  if (!S.day) return;
  if (S.t < S.day.m0 || S.t >= S.day.m1) { S.day = buildDay(S.t); buildSunPath(); drawStrip(); }
  const s = sunPosition(S.t, LAT, LON);
  S.sun = s;
  const dir = sunDir(Math.max(s.alt, 0.5), s.az);
  sunLight.position.copy(dir).multiplyScalar(1200);
  const up = THREE.MathUtils.clamp(s.alt / 12, 0, 1), day = THREE.MathUtils.clamp((s.alt + 4) / 8, 0, 1);
  sunLight.intensity = s.alt > 0 ? 0.8 + 2.0 * Math.min(1, s.alt / 15) : 0;
  sunLight.color.set(0xffc47a).lerp(new THREE.Color(0xfff6e8), up);
  hemi.intensity = 0.35 + 0.65 * day;
  hemi.color.set(0x6b77b8).lerp(new THREE.Color(0xcfdcff), day); // bluish sky light = soft blue-violet shadows
  hemi.groundColor.set(0x3c3a5a).lerp(new THREE.Color(0xf3e3c8), day);
  sunBall.position.copy(sunDir(s.alt, s.az).multiplyScalar(ARC_R));
  sunBall.visible = s.alt > -2;
  const [top, bot] = skyAt(s.alt), key = top.getHexString() + bot.getHexString();
  if (key !== lastSky) {
    lastSky = key;
    document.documentElement.style.setProperty("--sky-top", "#" + top.getHexString());
    document.documentElement.style.setProperty("--sky-bot", "#" + bot.getHexString());
    document.querySelector('meta[name="theme-color"]').content = "#" + top.getHexString();
  }
  // dots
  if (dots && S.sel) {
    const g = S.sel, base = g.h * 360, k = Math.round(s.az) % 360, a2 = s.alt * 2, c = new THREE.Color();
    for (let j = 0; j < g.n; j++) dots.setColorAt(j, c.set(s.alt > 0.3 && a2 > S.H[base + j * 360 + k] ? PAL.dotSun : PAL.dotShade));
    dots.instanceColor.needsUpdate = true;
  }
  renderAll();
  wake();
}

// ---------------------------------------------------------------- UI rendering
const els = {
  clock: $("#clock"), dateLabel: $("#dateLabel"), modeChip: $("#modeChip"), sunMini: $("#sunMini"),
  gName: $("#gName"), gWhere: $("#gWhere"), gPct: $("#gPct"), gChip: $("#gChip"), gNext: $("#gNext"), gMeter: $("#gMeter"), gInfo: $("#gInfo"), gApprox: $("#gApprox"),
  temp: $("#temp"), condText: $("#condText"), cloudText: $("#cloudText"), arc: $("#arc"), sunrise: $("#sunrise"), sunset: $("#sunset"), sunAlt: $("#sunAlt"), sunAz: $("#sunAz"),
  rows: $("#rows"), listTitle: $("#listTitle"), tabCount: $("#tabCount"), cloudWarn: $("#cloudWarn"), minimap: $("#minimap"),
  handle: $("#handle"), handleTime: $("#handleTime"), strip: $("#strip"), stripSvg: $("#stripSvg"), dayName: $("#dayName"), nowBtn: $("#nowBtn"), play: $("#play"),
};
const CHIP = { sun: "In the sun", part: "Partly sunny", shade: "In the shade", night: "After dark" };
let lastChip = "", renderQueued = false;
function renderAll() { if (renderQueued) return; renderQueued = true; requestAnimationFrame(() => { renderQueued = false; render(); }); }
function render() {
  if (!S.day || !S.sel) return;
  const i = minuteOf(S.t), s = S.sun || sunPosition(S.t, LAT, LON);
  // title card
  els.clock.textContent = hhmm(S.t);
  els.dateLabel.textContent = dayLabel(S.t) === "Today" ? longDate(S.t) : dayLabel(S.t);
  els.modeChip.classList.toggle("travel", !S.live);
  els.modeChip.querySelector("span").textContent = S.live ? "Live" : S.playing ? "Time-lapse" : "Time travel";
  els.sunMini.textContent = s.alt > 0 ? `${s.alt.toFixed(0)}° ${compass(s.az)}` : "below horizon";
  els.nowBtn.disabled = S.live;
  els.play.setAttribute("aria-pressed", S.playing);
  els.play.setAttribute("aria-label", S.playing ? "Pause time-lapse" : "Play time-lapse");

  // garden card
  const g = S.sel, st = status(g, i);
  els.gName.textContent = g.name;
  els.gWhere.textContent = [g.info.street, g.info.suburb].filter(Boolean).join(" · ") || "München";
  els.gPct.textContent = st.c === "night" ? "0" : st.pct;
  els.gChip.textContent = st.c === "night" && S.day.set != null && i < S.day.set ? "Sun too low" : CHIP[st.c]; els.gChip.className = "status " + st.c;
  if (lastChip && lastChip !== g.id + st.c) { void els.gChip.offsetWidth; els.gChip.classList.add("pop"); if (lastChip.startsWith(g.id)) tick(st.c === "sun"); }
  lastChip = g.id + st.c;
  els.gNext.innerHTML = st.text + (st.left > 0 && st.c !== "night" ? `<br>${dur(st.left)} of sun left today` : "");
  els.gMeter.style.width = (st.c === "night" ? 0 : st.pct) + "%";
  if (els.gInfo.dataset.id !== g.id) {
    els.gInfo.dataset.id = g.id;
    const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
    const rows = [];
    if (g.info.hours) rows.push(["Hours", esc(g.info.hours.replace(/;\s*/g, "; "))]);
    if (g.info.seats) rows.push(["Seats", esc(g.info.seats)]);
    if (g.info.brewery) rows.push(["Beer", esc(g.info.brewery)]);
    if (g.info.web && /^https?:\/\//.test(g.info.web)) rows.push(["Web", `<a href="${esc(g.info.web)}" target="_blank" rel="noopener">${esc(g.info.web.replace(/^https?:\/\/(www\.)?/, "").replace(/\/$/, ""))}</a>`]);
    rows.push(["OSM", `<a href="https://www.openstreetmap.org/${{ n: "node", w: "way", r: "relation" }[g.osm[0]]}/${g.osm.slice(1)}" target="_blank" rel="noopener">view on the map</a>`]);
    els.gInfo.innerHTML = rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join("");
    els.gApprox.textContent = g.area ? "" : `The garden's outline isn't mapped in OpenStreetMap, so this looks at a ${g.approx} m circle around it.`;
  }

  // sky card
  const w = weatherAt(S.t);
  els.temp.textContent = w ? Math.round(w.temp) : "–";
  els.condText.textContent = w ? (s.alt <= 0 && w.code <= 1 ? "Clear night" : WMO[w.code] || "–") : S.weather === null ? "Weather unavailable" : "No forecast";
  els.cloudText.textContent = w ? `${w.cloud}% cloud cover` : "";
  const d = S.day;
  els.sunrise.textContent = d.rise != null ? hhmm(atMin(d.rise)) : "–";
  els.sunset.textContent = d.set != null ? hhmm(atMin(d.set)) : "–";
  els.sunAlt.textContent = `${s.alt.toFixed(1)}°`;
  els.sunAz.textContent = `${compass(s.az)} ${Math.round(s.az)}°`;
  drawArc(i);

  // cloud warning
  const cloudy = w && (w.cloud >= 85 || w.code >= 51);
  els.cloudWarn.hidden = !cloudy || s.alt <= 0;
  if (cloudy) els.cloudWarn.textContent = w.code >= 51 ? `${WMO[w.code]} right now: the shadows below show where the sun would be.` : `Overcast (${w.cloud}% cloud): the list shows where the sun would be.`;

  renderList(i);
  for (const L of labelEls) { const c = status(L.o, i).c; L.el.classList.toggle("sun", c === "sun"); L.el.classList.toggle("part", c === "part"); }
  // strip handle
  const x = stripX(i); els.handle.style.left = x + "px"; els.handleTime.textContent = hhmm(S.t);
  els.strip.setAttribute("aria-valuenow", i); els.strip.setAttribute("aria-valuetext", hhmm(S.t));
  els.dayName.textContent = dayLabel(S.t);
}

let listCache = "";
function renderList(i) {
  const d = S.day;
  const all = S.gardens.map((g) => ({ g, st: status(g, i) }));
  const sunny = all.filter((r) => r.st.c === "sun" || r.st.c === "part");
  els.tabCount.textContent = sunny.length;
  const q = S.q.trim().toLowerCase();
  let rows;
  if (S.filter === "sunny") {
    rows = sunny.sort((a, b) => (b.st.c === "sun") - (a.st.c === "sun") || b.st.left - a.st.left || b.st.v - a.st.v);
    els.listTitle.textContent = d.alt[i] > 0.3 ? `Sunny now · ${sunny.length}/${all.length}` : "Sun is down";
  } else {
    rows = all.sort((a, b) => b.st.v - a.st.v || b.st.left - a.st.left || a.g.name.localeCompare(b.g.name));
    els.listTitle.textContent = `All Biergärten · ${all.length}`;
  }
  if (q) rows = (S.filter === "sunny" ? all : rows).filter((r) => r.g.name.toLowerCase().includes(q) || (r.g.info.suburb || "").toLowerCase().includes(q));
  const showMap = S.filter === "map";
  els.rows.hidden = showMap; els.minimap.hidden = !showMap;
  if (showMap) { els.listTitle.textContent = "Map · " + sunny.length + " sunny"; drawMinimap(all); return; }
  const key = S.filter + q + S.sel.id + rows.map((r) => r.g.id + r.st.pct + r.st.c + r.st.text).join();
  if (key === listCache) return; listCache = key;
  if (!rows.length) {
    els.rows.innerHTML = `<div class="empty">${q ? "No Biergarten matches that." : d.alt[i] > 0.3 ? "Every Biergarten is in the shade right now.<br>Drag the time bar to find the next sunny spot." : "The sun is down. Drag the time bar or press <b>Space</b> for tomorrow's sun."}</div>`;
    return;
  }
  const frag = document.createDocumentFragment();
  for (const { g, st } of rows) {
    const b = document.createElement("button");
    b.className = "row " + st.c; b.setAttribute("role", "option"); b.dataset.id = g.id;
    b.setAttribute("aria-selected", g === S.sel);
    const short = st.text.replace(/<[^>]+>/g, "").replace(/^(In the shade|Partly sunny|Sun is down|Sun is on the horizon) · /, "");
    b.innerHTML = `<span class="ico"><i></i></span><span class="nm"><b></b><small></small></span><span class="p num">${st.c === "night" ? "–" : st.pct + "%"}<u><s style="width:${st.pct}%"></s></u></span>`;
    b.querySelector("b").textContent = g.name;
    b.querySelector("small").textContent = (g.info.suburb ? g.info.suburb + " · " : "") + short;
    frag.appendChild(b);
  }
  els.rows.replaceChildren(frag);
  els.rows.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
}
els.rows.addEventListener("click", (e) => { const b = e.target.closest(".row"); if (b) select(S.byId.get(b.dataset.id), true); });

function drawMinimap(all) {
  const svg = els.minimap, W = svg.clientWidth || 300, Hh = svg.clientHeight || 300;
  const xs = S.gardens.map((g) => g.x), ys = S.gardens.map((g) => g.y);
  const x0 = Math.min(...xs) - 800, x1 = Math.max(...xs) + 800, y0 = Math.min(...ys) - 800, y1 = Math.max(...ys) + 800;
  const sc = Math.min(W / (x1 - x0), Hh / (y1 - y0)), ox = (W - (x1 - x0) * sc) / 2, oy = (Hh - (y1 - y0) * sc) / 2;
  const px = (x) => ox + (x - x0) * sc, py = (y) => oy + (y1 - y) * sc;
  const col = { sun: "var(--sun)", part: "var(--part)", shade: "var(--shade)", night: "var(--ink-3)" };
  svg.setAttribute("viewBox", `0 0 ${W} ${Hh}`);
  let h = `<circle cx="${px(0)}" cy="${py(0)}" r="${4000 * sc}" fill="none" stroke="var(--line)" stroke-width="1.5" stroke-dasharray="4 5"/>`;
  h += `<circle cx="${px(0)}" cy="${py(0)}" r="${8000 * sc}" fill="none" stroke="var(--line)" stroke-width="1.5" stroke-dasharray="4 5"/>`;
  h += `<text x="${px(0) + 7}" y="${py(0) + 4}" font-size="10" font-weight="800" fill="var(--ink-3)">Marienplatz</text><path d="M${px(0)} ${py(0) - 5}l1.5 3.4 3.6.3-2.8 2.4.9 3.6-3.2-2-3.2 2 .9-3.6-2.8-2.4 3.6-.3z" fill="var(--ink-3)"/>`;
  const order = all.slice().sort((a, b) => a.st.v - b.st.v);
  for (const { g, st } of order) {
    const sel = g === S.sel;
    h += `<circle class="dot" data-id="${g.id}" cx="${px(g.x).toFixed(1)}" cy="${py(g.y).toFixed(1)}" r="${sel ? 7 : 5}" fill="${col[st.c]}" stroke="${sel ? "var(--ink)" : "#fff"}" stroke-width="${sel ? 2.5 : 1.5}"><title>${g.name.replace(/[<&]/g, "")} · ${st.c === "night" ? "dark" : st.pct + "% sun"}</title></circle>`;
  }
  h += `<text x="10" y="${Hh - 10}" font-size="10.5" font-weight="700" fill="var(--ink-3)">rings: 4 km · 8 km from Marienplatz</text>`;
  svg.innerHTML = h;
}
els.minimap.addEventListener("click", (e) => { const c = e.target.closest(".dot"); if (c) select(S.byId.get(c.dataset.id), true); });

function drawArc(i) {
  const d = S.day, W = Math.round(els.arc.clientWidth) || 300, Hh = Math.round(els.arc.clientHeight) || 108, base = Hh - 22;
  els.arc.setAttribute("viewBox", `0 0 ${W} ${Hh}`);
  if (d.rise == null || d.set == null) { els.arc.innerHTML = ""; return; }
  const a0 = d.rise, a1 = d.set, maxAlt = Math.max(d.alt[d.noon], 1);
  const X = (m) => 12 + ((m - a0) / (a1 - a0)) * (W - 24), Yc = (alt) => base - (Math.max(alt, 0) / maxAlt) * (base - 14);
  let path = "", fill = "";
  for (let m = a0; m <= a1; m += 5) path += (m === a0 ? "M" : "L") + X(m).toFixed(1) + " " + Yc(d.alt[m]).toFixed(1);
  const cur = Math.max(a0, Math.min(a1, i));
  for (let m = a0; m <= cur; m += 5) fill += (m === a0 ? "M" : "L") + X(m).toFixed(1) + " " + Yc(d.alt[m]).toFixed(1);
  fill += `L${X(cur).toFixed(1)} ${Yc(d.alt[cur]).toFixed(1)}L${X(cur).toFixed(1)} ${base}L${X(a0)} ${base}Z`;
  const up = i > a0 && i < a1, left = up ? a1 - i : 0;
  const sx = X(cur), sy = Yc(d.alt[cur]);
  els.arc.innerHTML = `
    <defs><linearGradient id="arcfill" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="#ffc23d" stop-opacity=".55"/><stop offset="1" stop-color="#ffc23d" stop-opacity=".05"/></linearGradient>
    <radialGradient id="glow"><stop offset="0" stop-color="#ffd35a" stop-opacity=".9"/><stop offset="1" stop-color="#ffd35a" stop-opacity="0"/></radialGradient></defs>
    <line x1="0" x2="${W}" y1="${base}" y2="${base}" stroke="rgba(59,58,85,.18)" stroke-width="1.5"/>
    <path d="${fill}" fill="url(#arcfill)"/>
    <path d="${path}" fill="none" stroke="#e9a21a" stroke-width="2" stroke-dasharray="${up ? "0" : "3 4"}" opacity=".9"/>
    ${up ? `<circle cx="${sx}" cy="${sy}" r="16" fill="url(#glow)"/><circle cx="${sx}" cy="${sy}" r="6.5" fill="#ffc23d" stroke="#fff" stroke-width="2"/>` : ""}
    <text x="${W / 2}" y="${base + 16}" text-anchor="middle" font-size="11.5" font-weight="700" fill="var(--ink-2)">${up ? dur(left) + " of daylight left" : i <= a0 ? "sunrise in " + dur(a0 - i) : "the sun has set"}</text>`;
}

// ---------------------------------------------------------------- time strip
let stripRange = [0, 1440];
function stripX(i) { const w = els.strip.clientWidth, [a, b] = stripRange; return THREE.MathUtils.clamp(((i - a) / (b - a)) * w, 0, w); }
function drawStrip() {
  const d = S.day; if (!d || !S.sel) return;
  const W = els.strip.clientWidth, Hh = els.strip.clientHeight; if (!W) return;
  const a = Math.max(0, (d.rise ?? 300) - 60), b = Math.min(d.N, (d.set ?? 1260) + 60);
  stripRange = [Math.floor(a / 60) * 60, Math.min(d.N, Math.ceil(b / 60) * 60)];
  const [s0, s1] = stripRange, arr = d.share.get(S.sel.id);
  const X = (m) => ((m - s0) / (s1 - s0)) * W;
  const band = { y: 14, h: Hh - 26 };
  let h = `<defs><clipPath id="bandclip"><rect x="0" y="${band.y}" width="${W}" height="${band.h}" rx="8"/></clipPath></defs><g clip-path="url(#bandclip)"><rect x="0" y="${band.y}" width="${W}" height="${band.h}" fill="#2f3354"/>`;
  const step = Math.max(1, Math.round((s1 - s0) / W * 2));
  for (let m = s0; m < s1; m += step) {
    const v = arr[m] / 255, alt = d.alt[m];
    if (alt <= 0.3) continue;
    const c = v >= 0.5 ? lerpC("#ffd466", "#ffb31a", (v - 0.5) * 2) : v >= 0.15 ? lerpC("#b9b2b8", "#f7cf6c", (v - 0.15) / 0.35) : lerpC("#7581b8", "#9aa3cf", v / 0.15);
    h += `<rect x="${X(m).toFixed(1)}" y="${band.y}" width="${(X(m + step) - X(m) + 0.6).toFixed(1)}" height="${band.h}" fill="#${c.getHexString()}"/>`;
  }
  h += `</g>`;
  // cloud cover row
  if (S.weather) for (const hr of S.weather.hours) {
    const m = (hr.ms - d.m0) / 60000; if (m < s0 || m >= s1) continue;
    h += `<rect x="${X(m).toFixed(1)}" y="${band.y + band.h + 3}" width="${(X(m + 60) - X(m) - 1).toFixed(1)}" height="4" rx="2" fill="#8a8fb5" opacity="${(0.12 + (hr.cloud / 100) * 0.75).toFixed(2)}"><title>${hhmm(hr.ms)} · ${hr.cloud}% cloud</title></rect>`;
  }
  // hour ticks
  for (let m = s0; m <= s1; m += 60) {
    const hr = Math.round(m / 60); if ((s1 - s0) / 60 > 12 && hr % 2) continue;
    h += `<text x="${X(m).toFixed(1)}" y="10" text-anchor="middle" font-size="9.5" font-weight="700" fill="var(--ink-3)">${pad(parts(atMin(m)).h)}</text>`;
  }
  // "now" marker if the strip shows today
  const nowM = (Date.now() - d.m0) / 60000;
  if (nowM >= s0 && nowM <= s1) h += `<line x1="${X(nowM)}" x2="${X(nowM)}" y1="${band.y - 2}" y2="${band.y + band.h + 2}" stroke="#fff" stroke-width="2" stroke-dasharray="2 3"/>`;
  els.stripSvg.setAttribute("viewBox", `0 0 ${W} ${Hh}`);
  els.stripSvg.innerHTML = h;
}
function setTimeFromX(clientX) {
  const r = els.strip.getBoundingClientRect(), [a, b] = stripRange;
  const m = Math.round(a + THREE.MathUtils.clamp((clientX - r.left) / r.width, 0, 1) * (b - a));
  setTime(atMin(m));
}
function setTime(ms, live = false) {
  S.t = ms; S.live = live;
  applyTime(); writeHash();
}
els.strip.addEventListener("pointerdown", (e) => { els.strip.setPointerCapture(e.pointerId); S.playing = false; audio(); setTimeFromX(e.clientX); });
els.strip.addEventListener("pointermove", (e) => { if (els.strip.hasPointerCapture(e.pointerId)) setTimeFromX(e.clientX); });

// ---------------------------------------------------------------- selection + URL
function select(g, user = false) {
  if (!g) return;
  const changed = S.sel !== g;
  S.sel = g; listCache = "";
  if (changed) { loadScene(g); drawStrip(); if (user) clink(); }
  store.set("last", g.id);
  writeHash(); renderAll();
  if (user && MOBILE()) setTab("garden");
}
function writeHash() {
  if (!S.sel) return;
  let h = "#" + S.sel.id;
  if (!S.live) { const p = parts(S.t); h += `@${p.y}-${pad(p.mo)}-${pad(p.d)}T${pad(p.h)}${pad(p.mi)}`; }
  try { history.replaceState(null, "", h); } catch {}
}
function readHash() {
  const m = decodeURIComponent(location.hash.slice(1)).match(/^([a-z0-9-]+)(?:@(\d{4})-(\d\d)-(\d\d)T(\d\d)(\d\d))?$/);
  if (!m) return null;
  return { id: m[1], t: m[2] ? berlin(+m[2], +m[3], +m[4], +m[5], +m[6]) : null };
}
addEventListener("hashchange", () => { const h = readHash(); if (!h) return; if (h.t) { S.live = false; S.t = h.t; } if (S.byId.get(h.id)) select(S.byId.get(h.id)); applyTime(); });

// ---------------------------------------------------------------- controls
$("#play").addEventListener("click", () => togglePlay());
function togglePlay() {
  audio();
  S.playing = !S.playing;
  if (S.playing) { S.live = false; const d = S.day; if (d.alt[minuteOf(S.t)] <= 0) S.t = atMin(Math.max(0, (d.rise ?? 0) - 20)); }
  applyTime(); writeHash(); wake();
}
function goNow() { S.playing = false; setTime(Date.now(), true); }
$("#nowBtn").addEventListener("click", goNow);
const shiftDay = (n) => { S.playing = false; const p = parts(S.t); setTime(berlin(p.y, p.mo, p.d + n, p.h, p.mi)); };
$("#prevDay").addEventListener("click", () => shiftDay(-1));
$("#nextDay").addEventListener("click", () => shiftDay(1));
$("#mute").addEventListener("click", () => { S.muted = !S.muted; store.set("muted", S.muted); syncMute(); if (!S.muted) clink(); });
function syncMute() { const b = $("#mute"); b.setAttribute("aria-pressed", S.muted); b.setAttribute("aria-label", S.muted ? "Sound off" : "Sound on"); }
document.querySelectorAll(".seg button").forEach((b) => b.addEventListener("click", () => {
  S.filter = b.dataset.filter; listCache = "";
  document.querySelectorAll(".seg button").forEach((x) => x.setAttribute("aria-pressed", x === b));
  store.set("filter", S.filter); render();
}));
$("#q").addEventListener("input", (e) => { S.q = e.target.value; listCache = ""; render(); });
function setTab(t) {
  $("#panels").dataset.tab = t;
  document.querySelectorAll(".tabs button").forEach((b) => b.setAttribute("aria-selected", b.dataset.tab === t));
  if (t === "list") { listCache = ""; render(); }
}
document.querySelectorAll(".tabs button").forEach((b) => b.addEventListener("click", () => setTab(b.dataset.tab)));
function stepGarden(dir) {
  const rows = [...els.rows.querySelectorAll(".row")]; if (!rows.length) return;
  const i = rows.findIndex((r) => r.dataset.id === S.sel.id);
  const n = rows[(i + dir + rows.length) % rows.length]; select(S.byId.get(n.dataset.id), true);
}
function randomSunny() {
  const i = minuteOf(S.t), pool = S.gardens.filter((g) => g !== S.sel && S.day.share.get(g.id)[i] >= SUNNY);
  const list = pool.length ? pool : S.gardens.filter((g) => g !== S.sel);
  select(list[Math.floor(Math.random() * list.length)], true);
}
addEventListener("keydown", (e) => {
  if (e.target.matches("input")) { if (e.key === "Escape") e.target.blur(); return; }
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const k = e.key;
  if (k === "ArrowLeft" || k === "ArrowRight") { e.preventDefault(); S.playing = false; setTime(S.t + (k === "ArrowRight" ? 1 : -1) * (e.shiftKey ? 60 : 15) * 60000); }
  else if (k === " ") { e.preventDefault(); togglePlay(); }
  else if (k === "ArrowDown" || k === "ArrowUp") { e.preventDefault(); stepGarden(k === "ArrowDown" ? 1 : -1); }
  else if (k === "n" || k === "N") goNow();
  else if (k === "r" || k === "R") randomSunny();
  else if (k === "m" || k === "M") $("#mute").click();
  else if (k === "[") shiftDay(-1);
  else if (k === "]") shiftDay(1);
  else if (k === "/") { e.preventDefault(); if (MOBILE()) setTab("list"); $("#q").focus(); }
});
addEventListener("pointerdown", () => audio(), { once: true });

// ---------------------------------------------------------------- boot
async function boot() {
  const [meta, hbuf] = await Promise.all([fetch("data/gardens.json").then((r) => r.json()), fetch("data/horizon.u8.txt").then((r) => r.arrayBuffer())]);
  S.meta = meta; S.H = new Uint8Array(hbuf);
  S.gardens = meta.gardens.map((g) => {
    const n = g.pts.length / 2;
    let ext = g.approx || 10;
    if (g.area) { let mx = 0; for (let i = 0; i < g.area.length; i += 2) mx = Math.max(mx, Math.hypot(g.area[i], g.area[i + 1]) / 10); ext = mx; }
    // typical spacing between sample points (for dot size)
    const areaM2 = g.area ? Math.abs(g.area.reduce((s, v, i, a) => i % 2 ? s : s + (v * a[(i + 3) % a.length] - a[(i + 2) % a.length] * a[i + 1]), 0) / 200) : Math.PI * g.approx * g.approx;
    return { ...g, n, extent: ext, spacing: Math.sqrt(areaM2 / Math.max(n, 1)) };
  });
  for (const g of S.gardens) S.byId.set(g.id, g);
  if (meta.osm) $("#src").textContent = `Buildings & gardens © OpenStreetMap contributors (${meta.osm.slice(0, 10)}) · weather Open-Meteo · shade from buildings only, trees not counted`;
  S.filter = store.get("filter", "sunny");
  if (!["sunny", "all", "map"].includes(S.filter)) S.filter = "sunny";
  document.querySelectorAll(".seg button").forEach((x) => x.setAttribute("aria-pressed", x.dataset.filter === S.filter));
  syncMute();

  const h = readHash();
  if (h?.t) { S.live = false; S.t = h.t; }
  S.day = buildDay(S.t);
  buildSunPath();
  // start on: hash → last viewed → the sunniest well-known garden right now
  let g = h && S.byId.get(h.id) || S.byId.get(store.get("last", ""));
  if (!g) {
    const i = minuteOf(S.t), famous = ["augustiner-keller", "biergarten-am-chinesischen-turm", "koniglicher-hirschgarten", "hofbraukeller", "seehaus", "paulaner-am-nockherberg", "lowenbraukeller"];
    const cands = S.gardens.filter((x) => famous.some((f) => x.id.startsWith(f)));
    const pool = cands.length ? cands : S.gardens;
    g = pool.slice().sort((a, b) => S.day.share.get(b.id)[i] - S.day.share.get(a.id)[i])[0];
  }
  resize();
  select(g);
  $("#loader").classList.add("gone");
  loadWeather();
  // live clock
  setInterval(() => { if (S.live && !S.playing) { S.t = Date.now(); applyTime(); } }, 20000);
  setInterval(() => { if (S.weather && Date.now() - S.weather.fetched > 30 * 60000) loadWeather(); }, 60000);
}
boot().catch((e) => { console.error(e); $("#loader p").textContent = "Couldn't load the map data. Try reloading."; });

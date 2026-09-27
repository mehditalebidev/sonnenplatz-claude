// Build step: turns raw Overpass JSON (data-raw/) into the site's data files (public/data/).
//
//   node tools/build.mjs
//
// Output
//   public/data/gardens.json   list of beer gardens + sample points (decimetres, relative to garden centre)
//   public/data/horizon.u8.txt for every sample point, 360 bytes: the obstruction angle (0.5° units)
//                              of the buildings around it, per 1° of compass azimuth
//   public/data/g/<id>.json    3D scene around each garden (buildings, green, water, roads)
//
// At runtime a point is sunlit when sunAltitude > horizon[point][round(sunAzimuth)].

import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const RAW = path.join(ROOT, "data-raw");
const OUT = path.join(ROOT, "public", "data");
const SCENE_R = 290; // metres around a garden that are modelled
const MAX_POINTS = 64;

const load = (f) => JSON.parse(fs.readFileSync(path.join(RAW, f), "utf8")).elements;

// ---------- projection (local metres, x = east, y = north, origin Marienplatz) ----------
const LAT0 = 48.1374, LON0 = 11.5755;
const phi = (LAT0 * Math.PI) / 180;
const KY = 111132.92 - 559.82 * Math.cos(2 * phi) + 1.175 * Math.cos(4 * phi);
const KX = 111412.84 * Math.cos(phi) - 93.5 * Math.cos(3 * phi);
const proj = (p) => [(p.lon - LON0) * KX, (p.lat - LAT0) * KY];

// ---------- geometry helpers ----------
const ringArea = (r) => { let a = 0; for (let i = 0, n = r.length; i < n; i++) { const [x1, y1] = r[i], [x2, y2] = r[(i + 1) % n]; a += x1 * y2 - x2 * y1; } return a / 2; };
const centroid = (r) => {
  let a = 0, cx = 0, cy = 0;
  for (let i = 0, n = r.length; i < n; i++) { const [x1, y1] = r[i], [x2, y2] = r[(i + 1) % n]; const f = x1 * y2 - x2 * y1; a += f; cx += (x1 + x2) * f; cy += (y1 + y2) * f; }
  if (Math.abs(a) < 1e-6) { const s = r.reduce((s, p) => [s[0] + p[0], s[1] + p[1]], [0, 0]); return [s[0] / r.length, s[1] / r.length]; }
  return [cx / (3 * a), cy / (3 * a)];
};
const inRing = (x, y, r) => {
  let c = false;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    const [xi, yi] = r[i], [xj, yj] = r[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
};
const openRing = (pts) => { const r = pts.slice(); if (r.length > 1 && r[0][0] === r.at(-1)[0] && r[0][1] === r.at(-1)[1]) r.pop(); return r; };
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

// Join member ways of a multipolygon into rings.
function assembleRings(ways) {
  const segs = ways.filter((w) => w.length >= 2).map((w) => w.slice());
  const rings = [];
  const key = (p) => p[0].toFixed(2) + "," + p[1].toFixed(2);
  while (segs.length) {
    let ring = segs.shift();
    let guard = 0;
    while (key(ring[0]) !== key(ring.at(-1)) && guard++ < 5000) {
      const end = key(ring.at(-1));
      const i = segs.findIndex((s) => key(s[0]) === end || key(s.at(-1)) === end);
      if (i < 0) break;
      let s = segs.splice(i, 1)[0];
      if (key(s[0]) !== end) s = s.reverse();
      ring = ring.concat(s.slice(1));
    }
    if (ring.length >= 3) rings.push(openRing(ring));
  }
  return rings;
}

// Polygon rings of an element (way or multipolygon relation): { outer: [...], inner: [...] }
function polygonsOf(el) {
  if (el.type === "way" && el.geometry) {
    const pts = el.geometry.map(proj);
    const g0 = el.geometry[0], g1 = el.geometry.at(-1);
    const closed = g0 && g1 && g0.lat === g1.lat && g0.lon === g1.lon;
    if (!closed || pts.length < 4) return [];
    return [{ outer: openRing(pts), inner: [] }];
  }
  if (el.type === "relation" && el.members) {
    const outerWays = [], innerWays = [];
    for (const m of el.members) {
      if (m.type !== "way" || !m.geometry) continue;
      const g = m.geometry.filter(Boolean).map(proj);
      (m.role === "inner" ? innerWays : outerWays).push(g);
    }
    const outers = assembleRings(outerWays), inners = assembleRings(innerWays);
    return outers.map((o) => ({ outer: o, inner: inners.filter((r) => inRing(r[0][0], r[0][1], o)) }));
  }
  return [];
}

// Sutherland–Hodgman clip of a ring against a convex polygon (the scene circle).
function clipRing(ring, clip) {
  let out = ring;
  for (let i = 0; i < clip.length && out.length; i++) {
    const a = clip[i], b = clip[(i + 1) % clip.length];
    const inside = (p) => (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]) >= 0;
    const inter = (p, q) => {
      const x1 = p[0], y1 = p[1], x2 = q[0], y2 = q[1], x3 = a[0], y3 = a[1], x4 = b[0], y4 = b[1];
      const d = (x1 - x2) * (y3 - y4) - (y1 - y2) * (x3 - x4);
      const t = ((x1 - x3) * (y3 - y4) - (y1 - y3) * (x3 - x4)) / d;
      return [x1 + t * (x2 - x1), y1 + t * (y2 - y1)];
    };
    const inp = out; out = [];
    for (let j = 0; j < inp.length; j++) {
      const p = inp[j], q = inp[(j + 1) % inp.length];
      const pin = inside(p), qin = inside(q);
      if (pin) out.push(p);
      if (pin !== qin) out.push(inter(p, q));
    }
  }
  return out;
}

// Clip a polyline to a circle; returns list of polylines.
function clipLine(pts, c, R) {
  const res = []; let cur = [];
  const inside = (p) => dist(p, c) <= R;
  const cross = (p, q) => { // point where segment p->q crosses circle
    const dx = q[0] - p[0], dy = q[1] - p[1], fx = p[0] - c[0], fy = p[1] - c[1];
    const A = dx * dx + dy * dy, B = 2 * (fx * dx + fy * dy), C = fx * fx + fy * fy - R * R;
    const disc = Math.sqrt(Math.max(0, B * B - 4 * A * C));
    const ts = [(-B - disc) / (2 * A), (-B + disc) / (2 * A)].filter((t) => t >= 0 && t <= 1);
    return ts.map((t) => [p[0] + t * dx, p[1] + t * dy]);
  };
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    if (i === 0) { if (inside(p)) cur.push(p); continue; }
    const q = pts[i - 1], pin = inside(p), qin = inside(q);
    if (qin && pin) cur.push(p);
    else if (qin && !pin) { cur.push(cross(q, p).at(-1) || p); res.push(cur); cur = []; }
    else if (!qin && pin) { cur = [cross(q, p)[0] || q, p]; }
    else { const xs = cross(q, p); if (xs.length === 2) res.push(xs); }
  }
  if (cur.length >= 2) res.push(cur);
  return res.filter((l) => l.length >= 2);
}

// ---------- building heights ----------
const num = (s) => { if (s == null) return NaN; const m = String(s).replace(",", ".").match(/-?\d+(\.\d+)?/); return m ? parseFloat(m[0]) : NaN; };
const LOW = new Set(["garage", "garages", "shed", "carport", "hut", "kiosk", "service", "toilets", "container", "cabin", "greenhouse", "transformer_tower", "bunker", "hangar_small"]);
const HOUSE = new Set(["house", "detached", "semidetached_house", "terrace", "bungalow", "farm", "farm_auxiliary", "barn", "stable"]);
const BLOCK = new Set(["apartments", "residential", "dormitory", "hotel"]);
const WORK = new Set(["commercial", "office", "retail", "industrial", "warehouse", "public", "school", "university", "college", "hospital", "civic", "government", "train_station", "kindergarten", "supermarket", "sports_hall", "stadium"]);
const CHURCH = new Set(["church", "cathedral", "chapel", "mosque", "synagogue", "temple"]);
const heightStats = { tag: 0, levels: 0, guess: 0 };
function heightOf(t, area) {
  let h = num(t.height);
  if (h > 0) { heightStats.tag++; return Math.min(Math.max(h, 2), 160); }
  const lv = num(t["building:levels"]);
  if (lv >= 0) {
    heightStats.levels++;
    const roof = num(t["roof:levels"]) > 0 ? num(t["roof:levels"]) * 2 : (t["roof:shape"] && t["roof:shape"] !== "flat" ? 2 : 0.8);
    return Math.min(lv * 3.1 + roof + 0.5, 160) || 3;
  }
  heightStats.guess++;
  const b = t.building;
  if (b === "roof") return 4;
  if (LOW.has(b)) return 3;
  if (CHURCH.has(b)) return 16;
  if (HOUSE.has(b)) return 8;
  if (BLOCK.has(b)) return 15;
  if (WORK.has(b)) return 12;
  if (area < 25) return 3;
  if (area < 70) return 5;
  if (area < 180) return 8;
  return 12;
}

// ---------- load ----------
const bgEls = load("bg.json");
// bld/ground come from the per-cell cache written by fetch.mjs (deduplicated here)
const cellEls = new Map();
for (const f of fs.readdirSync(path.join(RAW, "cells"))) if (f.endsWith(".json"))
  for (const e of JSON.parse(fs.readFileSync(path.join(RAW, "cells", f), "utf8")).elements) cellEls.set(e.type + e.id, e);
const bldEls = [], groundEls = [];
for (const e of cellEls.values()) (e.tags?.building ? bldEls : groundEls).push(e);

// Buildings
const buildings = [];
for (const el of bldEls) {
  const t = el.tags || {};
  if (!t.building || t.building === "no" || t.building === "construction" && !t.height) continue;
  for (const poly of polygonsOf(el)) {
    const area = Math.abs(ringArea(poly.outer));
    if (area < 4) continue;
    const c = centroid(poly.outer);
    buildings.push({ outer: poly.outer, inner: poly.inner, h: heightOf(t, area), c, area, roof: t.building === "roof" });
  }
}
console.log("buildings", buildings.length, heightStats);

// Spatial grid for buildings (100 m cells)
const CELL = 100, grid = new Map();
buildings.forEach((b, i) => {
  const k = Math.floor(b.c[0] / CELL) + "," + Math.floor(b.c[1] / CELL);
  if (!grid.has(k)) grid.set(k, []);
  grid.get(k).push(i);
});
function buildingsNear(c, R) {
  const res = [];
  const r = Math.ceil((R + 150) / CELL), gx = Math.floor(c[0] / CELL), gy = Math.floor(c[1] / CELL);
  for (let dx = -r; dx <= r; dx++) for (let dy = -r; dy <= r; dy++) {
    for (const i of grid.get(gx + dx + "," + (gy + dy)) || []) if (dist(buildings[i].c, c) <= R) res.push(i);
  }
  return res;
}

// Ground features
const ground = [];
const GREEN = { park: "park", garden: "park", playground: "park", village_green: "park", recreation_ground: "park", grass: "grass", meadow: "grass", grassland: "grass", pitch: "pitch", forest: "wood", wood: "wood", scrub: "wood", allotments: "park", cemetery: "park" };
const ROADW = { motorway: 16, trunk: 14, primary: 12, secondary: 10, tertiary: 8, residential: 6, unclassified: 6, living_street: 5, pedestrian: 6, service: 3.5, motorway_link: 7, trunk_link: 7, primary_link: 7, secondary_link: 6, footway: 2, path: 2, cycleway: 2 };
for (const el of groundEls) {
  const t = el.tags || {};
  const hw = t.highway, rw = t.railway, ww = t.waterway;
  if (el.type === "way" && (hw || rw || (ww && ww !== "riverbank"))) {
    if (hw && t.area === "yes") { /* pedestrian squares: draw as pavement */
      for (const p of polygonsOf(el)) ground.push({ kind: "paved", poly: p.outer });
      continue;
    }
    if (hw && (t.tunnel === "yes" || t.layer && +t.layer < 0)) continue;
    if (rw && (t.tunnel === "yes" || t.service)) continue;
    const pts = el.geometry.map(proj);
    let kind, w;
    if (hw) { w = ROADW[hw] || 4; kind = w <= 2 ? "path" : "road"; }
    else if (rw) { kind = rw === "rail" ? "rail" : "tram"; w = rw === "rail" ? 3 : 2; }
    else { kind = "stream"; w = ww === "river" ? 20 : ww === "canal" ? 8 : 3; }
    ground.push({ kind, w, line: pts, bb: bbox(pts) });
    continue;
  }
  let kind = null;
  if (t.natural === "water" || t.waterway === "riverbank" || t.water) kind = "water";
  else kind = GREEN[t.leisure] || GREEN[t.landuse] || GREEN[t.natural] || null;
  if (!kind) continue;
  for (const p of polygonsOf(el)) ground.push({ kind, poly: p.outer, bb: bbox(p.outer) });
}
for (const g of ground) if (!g.bb) g.bb = bbox(g.poly || g.line);
function bbox(pts) { let a = Infinity, b = Infinity, c = -Infinity, d = -Infinity; for (const [x, y] of pts) { if (x < a) a = x; if (y < b) b = y; if (x > c) c = x; if (y > d) d = y; } return [a, b, c, d]; }
console.log("ground features", ground.length);

// ---------- gardens ----------
const norm = (s) => (s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/\b(biergarten|beer garden|gaststatte|wirtshaus|restaurant|gasthof|zum|zur|der|die|das|am|an|im)\b/g, "").replace(/[^a-z0-9]/g, "");
// Munich city + the first ring of neighbouring towns
const BBOX = { s: 48.061, w: 11.36, n: 48.248, e: 11.723 };
const places = JSON.parse(fs.readFileSync(path.join(RAW, "places.json"), "utf8")).elements.map((p) => ({ ...p, c: proj(p) }));
function districtOf(c) {
  let best = null, bd = Infinity;
  for (const p of places) {
    const w = p.place === "neighbourhood" || p.place === "hamlet" ? 1.6 : 1; // prefer proper districts
    const d = dist(p.c, c) * w;
    if (d < bd) { bd = d; best = p; }
  }
  return bd < 2500 ? best.name : null;
}
let gardens = [];
for (const el of bgEls) {
  const t = el.tags || {};
  const ll = el.lat != null ? el : el.geometry?.[0] || el.members?.[0]?.geometry?.[0];
  if (!ll || ll.lat < BBOX.s || ll.lat > BBOX.n || ll.lon < BBOX.w || ll.lon > BBOX.e) continue;
  if (["fast_food", "cafe", "ice_cream"].includes(t.amenity) && t.amenity !== "biergarten") continue;
  let poly = null, c;
  if (el.type === "node") c = proj(el);
  else {
    const ps = polygonsOf(el);
    if (ps.length) { ps.sort((a, b) => Math.abs(ringArea(b.outer)) - Math.abs(ringArea(a.outer))); poly = ps[0].outer; c = centroid(poly); }
    else if (el.center) c = proj(el.center);
    else continue;
  }
  // A polygon tagged as a restaurant building (beer_garden=yes) is the house, not the garden
  const isBuilding = !!t.building || (t.amenity && t.amenity !== "biergarten");
  gardens.push({ el, t, name: t.name || null, poly: isBuilding ? null : poly, house: isBuilding ? poly : null, c, osm: el.type[0] + el.id });
}
// Merge duplicates (node + area of the same place)
gardens.sort((a, b) => (b.poly ? 1 : 0) - (a.poly ? 1 : 0));
const kept = [];
for (const g of gardens) {
  const dup = kept.find((k) => {
    const d = dist(k.c, g.c);
    if (k.poly && inRing(g.c[0], g.c[1], k.poly) && d < 150) return true;
    const a = norm(k.name), b = norm(g.name);
    return d < 160 && a && b && (a.includes(b) || b.includes(a));
  });
  if (dup) {
    for (const [key, v] of Object.entries(g.t)) if (!(key in dup.t)) dup.t[key] = v;
    if (!dup.name && g.name) dup.name = g.name;
    if (g.name && dup.name && g.t.amenity === "biergarten" && dup.t.amenity !== "biergarten") dup.name = g.name;
    continue;
  }
  kept.push(g);
}
gardens = kept.filter((g) => g.name);
console.log("gardens", gardens.length);

// ---------- per garden: sample points + horizon ----------
function samplePoints(g, blds) {
  const blocked = (x, y) => blds.some((i) => { const b = buildings[i]; return !b.roof && inRing(x, y, b.outer) && !b.inner.some((r) => inRing(x, y, r)); });
  const tryGrid = (s, inside, bb) => {
    const pts = [];
    const x0 = Math.floor(bb[0] / s) * s + s / 2, y0 = Math.floor(bb[1] / s) * s + s / 2;
    for (let x = x0; x <= bb[2]; x += s) for (let y = y0; y <= bb[3]; y += s) if (inside(x, y) && !blocked(x, y)) pts.push([x, y]);
    return pts;
  };
  let inside, bb;
  if (g.poly) { inside = (x, y) => inRing(x, y, g.poly); bb = bbox(g.poly); }
  else {
    // Only a point (or the restaurant building) is mapped: use a 22 m disk around it, minus buildings
    const R = g.house ? Math.sqrt(Math.abs(ringArea(g.house)) / Math.PI) + 16 : 22;
    inside = (x, y) => dist([x, y], g.c) <= R;
    bb = [g.c[0] - R, g.c[1] - R, g.c[0] + R, g.c[1] + R];
    g.approxR = R;
  }
  let s = 2.5, pts = tryGrid(s, inside, bb);
  while (pts.length > MAX_POINTS) { s *= 1.15; pts = tryGrid(s, inside, bb); }
  while (pts.length < 6 && s > 0.8) { s *= 0.7; pts = tryGrid(s, inside, bb); }
  // Every point sits under a roof? (a covered garden) keep the centre anyway
  if (!pts.length) pts = [g.c.slice()];
  return pts;
}

function horizonFor(p, edges) {
  // edges: Float64Array [ax, ay, bx, by, h] * n
  const ratio = new Float64Array(360);
  const n = edges.length / 5;
  for (let e = 0; e < n; e++) {
    const ax = edges[e * 5] - p[0], ay = edges[e * 5 + 1] - p[1], bx = edges[e * 5 + 2] - p[0], by = edges[e * 5 + 3] - p[1], h = edges[e * 5 + 4];
    let t1 = (Math.atan2(ax, ay) * 180) / Math.PI, t2 = (Math.atan2(bx, by) * 180) / Math.PI;
    let diff = t2 - t1; while (diff > 180) diff -= 360; while (diff <= -180) diff += 360;
    const start = diff >= 0 ? t1 : t2, span = Math.abs(diff);
    const ex = bx - ax, ey = by - ay;
    for (let k = Math.ceil(start); k <= Math.floor(start + span); k++) {
      const az = ((k % 360) + 360) % 360, rad = (az * Math.PI) / 180;
      const dx = Math.sin(rad), dy = Math.cos(rad);
      const den = dx * ey - dy * ex;
      if (Math.abs(den) < 1e-9) continue;
      const t = (ax * ey - ay * ex) / den;
      if (t <= 0.05) continue;
      const r = h / t;
      if (r > ratio[az]) ratio[az] = r;
    }
  }
  const out = new Uint8Array(360);
  for (let i = 0; i < 360; i++) out[i] = Math.min(180, Math.ceil((Math.atan(ratio[i]) * 180) / Math.PI * 2));
  return out;
}

const dm = (v) => Math.round(v * 10);
const flat = (ring, c) => ring.flatMap(([x, y]) => [dm(x - c[0]), dm(y - c[1])]);
fs.rmSync(path.join(OUT, "g"), { recursive: true, force: true });
fs.mkdirSync(path.join(OUT, "g"), { recursive: true });
const circle = Array.from({ length: 72 }, (_, i) => [Math.cos((i / 72) * 2 * Math.PI), Math.sin((i / 72) * 2 * Math.PI)]);
const horizonChunks = [];
let hOffset = 0;
const list = [];
const usedIds = new Set();
const slug = (s) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/ß/g, "ss").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);

for (const g of gardens) {
  let id = slug(g.name); if (usedIds.has(id)) id += "-" + g.osm.slice(1).slice(-4); usedIds.add(id);
  const c = g.c;
  const blds = buildingsNear(c, SCENE_R + 40); // shadow casters (a bit beyond the visible disk)
  const shown = blds.filter((i) => buildings[i].outer.every((p) => dist(p, c) <= SCENE_R - 1)); // drawn: fully inside the disk
  const pts = samplePoints(g, blds);
  // Edges for the horizon (building canopies of type=roof count as shade too)
  const edges = [];
  for (const i of blds) {
    const b = buildings[i];
    for (const ring of [b.outer, ...b.inner]) for (let k = 0; k < ring.length; k++) { const a = ring[k], q = ring[(k + 1) % ring.length]; edges.push(a[0], a[1], q[0], q[1], b.h); }
  }
  const E = Float64Array.from(edges);
  for (const p of pts) { horizonChunks.push(horizonFor(p, E)); }

  // Scene file
  const clipPoly = circle.map(([x, y]) => [c[0] + x * SCENE_R, c[1] + y * SCENE_R]);
  const sceneGround = [];
  for (const f of ground) {
    if (f.bb[2] < c[0] - SCENE_R || f.bb[0] > c[0] + SCENE_R || f.bb[3] < c[1] - SCENE_R || f.bb[1] > c[1] + SCENE_R) continue;
    if (f.poly) {
      let r = clipRing(f.poly, clipPoly);
      if (r.length >= 3 && Math.abs(ringArea(r)) > 2) sceneGround.push([f.kind, flat(r, c)]);
    } else {
      for (const l of clipLine(f.line, c, SCENE_R)) sceneGround.push([f.kind, flat(l, c), f.w]);
    }
  }
  const scene = {
    b: shown.map((i) => { const b = buildings[i]; return [Math.round(b.h * 10), flat(b.outer, c), ...b.inner.map((r) => flat(r, c))]; }),
    g: sceneGround,
  };
  fs.writeFileSync(path.join(OUT, "g", id + ".json"), JSON.stringify(scene));

  const t = g.t;
  list.push({
    id, name: g.name, osm: g.osm,
    x: Math.round(c[0]), y: Math.round(c[1]),
    area: g.poly ? flat(g.poly, c) : null,
    approx: g.poly ? 0 : Math.round(g.approxR),
    pts: pts.flatMap(([x, y]) => [dm(x - c[0]), dm(y - c[1])]),
    h: hOffset,
    info: Object.fromEntries(Object.entries({
      hours: t.opening_hours, seats: t.capacity || t.seats || t["capacity:seats"], web: t.website || t["contact:website"],
      brewery: t.brewery, street: t["addr:street"] ? `${t["addr:street"]} ${t["addr:housenumber"] || ""}`.trim() : undefined,
      suburb: districtOf(c) || t["addr:suburb"] || t["addr:city"],
    }).filter(([, v]) => v)),
  });
  hOffset += pts.length;
  process.stdout.write(`\r${list.length}/${gardens.length} ${id.padEnd(40)} pts=${pts.length} bld=${blds.length}   `);
}
console.log();
const bin = new Uint8Array(hOffset * 360);
horizonChunks.forEach((h, i) => bin.set(h, i * 360));
// Raw bytes with a .txt name: Cloudflare only compresses text-like content types (2.2 MB → ~0.4 MB brotli);
// the page reads it with arrayBuffer(), so the bytes arrive untouched.
fs.rmSync(path.join(OUT, "horizon.bin"), { force: true });
fs.writeFileSync(path.join(OUT, "horizon.u8.txt"), bin);
const osmStamp = JSON.parse(fs.readFileSync(path.join(RAW, "bg.json"), "utf8")).osm3s?.timestamp_osm_base;
fs.writeFileSync(path.join(OUT, "gardens.json"), JSON.stringify({ origin: [LAT0, LON0], osm: osmStamp, sceneR: SCENE_R, gardens: list }));
console.log("points", hOffset, "horizon bytes", bin.length);

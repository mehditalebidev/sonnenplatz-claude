"""Extract beer gardens + their surroundings from a Munich OSM extract into Overpass-style JSON.

    curl -o data-raw/Muenchen.osm.pbf https://download.bbbike.org/osm/bbbike/Muenchen/Muenchen.osm.pbf
    python tools/extract.py            (needs `pip install -r tools/requirements.txt`)

Writes data-raw/bg.json (beer gardens), data-raw/places.json (district names) and
data-raw/cells/pbf.json (buildings + ground features within ~350 m of a garden).
build.mjs reads these.
"""
import json, math, os, re, sys
import osmium

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
RAW = os.path.join(ROOT, "data-raw")
PBF = os.path.join(RAW, "Muenchen.osm.pbf")
LAT0, LON0 = 48.1374, 11.5755
KY = 111132.92 - 559.82 * math.cos(2 * math.radians(LAT0))
KX = 111412.84 * math.cos(math.radians(LAT0))
CELL, PAD = 150.0, 360.0

def xy(lat, lon): return ((lon - LON0) * KX, (lat - LAT0) * KY)
def tags_of(o): return {t.k: t.v for t in o.tags}
def is_garden(t):
    return (t.get("amenity") == "biergarten" or t.get("beer_garden") == "yes" or t.get("biergarten") == "yes"
            or (t.get("leisure") == "outdoor_seating" and "biergarten" in t.get("name", "").lower()))

GREEN = re.compile(r"^(park|garden|pitch|playground)$")
LANDUSE = re.compile(r"^(grass|forest|meadow|recreation_ground|village_green|allotments|cemetery)$")
NATURAL = re.compile(r"^(wood|water|scrub|grassland)$")
HIGHWAY = re.compile(r"^(motorway|trunk|primary|secondary|tertiary|residential|unclassified|living_street|pedestrian|service|footway|path|cycleway|motorway_link|trunk_link|primary_link|secondary_link)$")
def is_ground_area(t):
    return bool(GREEN.match(t.get("leisure", "")) or LANDUSE.match(t.get("landuse", "")) or NATURAL.match(t.get("natural", ""))
                or t.get("waterway") == "riverbank" or (t.get("highway") == "pedestrian" and t.get("area") == "yes"))
def is_line(t):
    return bool(HIGHWAY.match(t.get("highway", "")) or t.get("railway") in ("rail", "tram", "light_rail")
                or t.get("waterway") in ("river", "stream", "canal"))

def ring_geom(ring): return [{"lat": round(n.lat, 7), "lon": round(n.lon, 7)} for n in ring]
def area_element(a, t):
    """Area -> Overpass-like way (closed) or multipolygon relation."""
    outers = list(a.outer_rings())
    if a.from_way() and len(outers) == 1 and not list(a.inner_rings(outers[0])):
        return {"type": "way", "id": a.orig_id(), "tags": t, "geometry": ring_geom(outers[0])}
    members = []
    for o in outers:
        members.append({"type": "way", "role": "outer", "geometry": ring_geom(o)})
        for i in a.inner_rings(o): members.append({"type": "way", "role": "inner", "geometry": ring_geom(i)})
    return {"type": "relation" if not a.from_way() else "way_mp", "id": a.orig_id(), "tags": t, "members": members}

# ---------- pass 1: gardens + places ----------
gardens, places = [], []
for o in osmium.FileProcessor(PBF).with_locations().with_areas():
    if o.is_node():
        t = tags_of(o)
        if not t: continue
        if is_garden(t): gardens.append({"type": "node", "id": o.id, "lat": o.location.lat, "lon": o.location.lon, "tags": t})
        if t.get("place") in ("suburb", "quarter", "neighbourhood", "village", "town", "hamlet") and t.get("name"):
            places.append({"name": t["name"], "place": t["place"], "lat": o.location.lat, "lon": o.location.lon})
    elif o.is_area():
        t = tags_of(o)
        if is_garden(t):
            e = area_element(o, t)
            if e["type"] == "way_mp": e["type"] = "relation"
            gardens.append(e)
print("gardens", len(gardens), "places", len(places), file=sys.stderr)

# cells within PAD of any garden
near = set()
def mark(x0, y0, x1, y1):
    for cx in range(int((x0 - PAD) // CELL), int((x1 + PAD) // CELL) + 1):
        for cy in range(int((y0 - PAD) // CELL), int((y1 + PAD) // CELL) + 1): near.add((cx, cy))
for g in gardens:
    pts = [(g["lat"], g["lon"])] if g["type"] == "node" else [(p["lat"], p["lon"]) for p in (g.get("geometry") or [q for m in g["members"] for q in m["geometry"]])]
    xs, ys = zip(*[xy(*p) for p in pts])
    mark(min(xs), min(ys), max(xs), max(ys))
def is_near(pts):
    for lat, lon in pts:
        x, y = xy(lat, lon)
        if (int(x // CELL), int(y // CELL)) in near: return True
    return False

# ---------- pass 2: buildings, ground areas, lines ----------
out, nb = [], 0
for o in osmium.FileProcessor(PBF).with_locations().with_areas():
    if o.is_way():
        t = tags_of(o)
        if not is_line(t): continue
        try: pts = [(n.lat, n.lon) for n in o.nodes]
        except osmium.InvalidLocationError: continue
        if len(pts) < 2 or not is_near(pts): continue
        out.append({"type": "way", "id": o.id, "tags": t, "geometry": [{"lat": round(a, 7), "lon": round(b, 7)} for a, b in pts]})
    elif o.is_area():
        t = tags_of(o)
        b = t.get("building")
        if not ((b and b != "no") or is_ground_area(t)): continue
        if b and t.get("highway"): continue
        outers = list(o.outer_rings())
        if not outers or not is_near([(n.lat, n.lon) for r in outers for n in r]): continue
        e = area_element(o, t)
        if e["type"] == "way_mp": e["type"] = "relation"; e["id"] = -e["id"]  # keep ids distinct from ways
        out.append(e)
        nb += bool(b)
print("features", len(out), "buildings", nb, file=sys.stderr)

os.makedirs(os.path.join(RAW, "cells"), exist_ok=True)
# data date: replication timestamp from the PBF header, else the file's modification time
import datetime
ts = osmium.io.Reader(PBF, osmium.osm.osm_entity_bits.NOTHING).header().get("osmosis_replication_timestamp")
if not ts: ts = datetime.datetime.fromtimestamp(os.path.getmtime(PBF), datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
stamp = {"timestamp_osm_base": ts, "source": "download.bbbike.org Muenchen.osm.pbf"}
json.dump({"osm3s": stamp, "elements": gardens}, open(os.path.join(RAW, "bg.json"), "w"))
json.dump({"elements": places}, open(os.path.join(RAW, "places.json"), "w"))
json.dump({"elements": out}, open(os.path.join(RAW, "cells", "pbf.json"), "w"))

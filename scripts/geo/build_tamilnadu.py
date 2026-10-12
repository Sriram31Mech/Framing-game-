#!/usr/bin/env python3
"""Build the compact Tamil Nadu map used by the game from DataMeet boundaries.

Inputs (download first, see docs/DATA.md):
  ac.geojson       Assembly constituencies of India (DataMeet, CC BY 2.5 IN)
  dists11.geojson  Census 2011 districts of India (DataMeet, CC BY 2.5 IN)

Output: packages/domain/src/data/tamilnadu-geo.json
  Coordinates are projected to local metres (x east, y south) around ORIGIN and simplified.

Usage: python3 scripts/geo/build_tamilnadu.py <ac.geojson> <dists11.geojson> <out.json>
"""
import hashlib
import json
import math
import re
import sys

ORIGIN_LAT, ORIGIN_LON = 10.9, 78.4
M_PER_DEG_LAT = 110_574.0
M_PER_DEG_LON = 111_320.0 * math.cos(math.radians(ORIGIN_LAT))
SEGMENT_TOLERANCE_M = 600.0
DISTRICT_TOLERANCE_M = 900.0
ROUND_M = 50


def project(lon, lat):
    x = (lon - ORIGIN_LON) * M_PER_DEG_LON
    y = -(lat - ORIGIN_LAT) * M_PER_DEG_LAT
    return [round(x / ROUND_M) * ROUND_M, round(y / ROUND_M) * ROUND_M]


def perp_dist(p, a, b):
    (x, y), (x1, y1), (x2, y2) = p, a, b
    dx, dy = x2 - x1, y2 - y1
    if dx == 0 and dy == 0:
        return math.hypot(x - x1, y - y1)
    t = max(0.0, min(1.0, ((x - x1) * dx + (y - y1) * dy) / (dx * dx + dy * dy)))
    return math.hypot(x - (x1 + t * dx), y - (y1 + t * dy))


def simplify(points, tol):
    """Iterative Douglas-Peucker."""
    if len(points) < 4:
        return points
    keep = [False] * len(points)
    keep[0] = keep[-1] = True
    stack = [(0, len(points) - 1)]
    while stack:
        s, e = stack.pop()
        best, idx = 0.0, -1
        for i in range(s + 1, e):
            d = perp_dist(points[i], points[s], points[e])
            if d > best:
                best, idx = d, i
        if best > tol and idx > 0:
            keep[idx] = True
            stack += [(s, idx), (idx, e)]
    return [p for p, k in zip(points, keep) if k]


def area(ring):
    return 0.5 * sum(ring[i - 1][0] * ring[i][1] - ring[i][0] * ring[i - 1][1] for i in range(len(ring)))


def outer_rings(geom):
    polys = geom["coordinates"] if geom["type"] == "MultiPolygon" else [geom["coordinates"]]
    return [poly[0] for poly in polys]


def clean_ring(raw, tol):
    ring = [project(lon, lat) for lon, lat in raw]
    if ring[0] == ring[-1]:
        ring = ring[:-1]
    dedup = [p for i, p in enumerate(ring) if i == 0 or p != ring[i - 1]]
    simp = simplify(dedup + [dedup[0]], tol)[:-1]
    if len(simp) < 3:
        return None
    if area(simp) < 0:  # make counter-clockwise in x-right / y-up sense, matching the domain
        simp.reverse()
    return simp


def centroid(ring):
    a = area(ring)
    cx = cy = 0.0
    for i in range(len(ring)):
        x0, y0 = ring[i - 1]
        x1, y1 = ring[i]
        f = x0 * y1 - x1 * y0
        cx += (x0 + x1) * f
        cy += (y0 + y1) * f
    return [cx / (6 * a), cy / (6 * a)]


def contains(ring, p):
    x, y = p
    inside = False
    for i in range(len(ring)):
        x0, y0 = ring[i - 1]
        x1, y1 = ring[i]
        if (y0 > y) != (y1 > y) and x < (x1 - x0) * (y - y0) / (y1 - y0) + x0:
            inside = not inside
    return inside


DIST_ALIASES = {"nagapattinam": "nagappattinam", "virudhunagar": "virudunagar"}


def slug(name):
    name = re.sub(r"\(.*?\)", "", name).replace("*", "").strip().lower()
    return re.sub(r"[^a-z0-9]+", "-", name).strip("-")


def main(ac_path, dist_path, out_path):
    districts = []
    for f in json.load(open(dist_path))["features"]:
        p = f["properties"]
        if p["ST_NM"] != "Tamil Nadu":
            continue
        rings = [r for r in (clean_ring(raw, DISTRICT_TOLERANCE_M) for raw in outer_rings(f["geometry"])) if r]
        rings = [r for r in rings if abs(area(r)) > 2e6]  # drop slivers/islets < 2 km²
        districts.append({"id": slug(p["DISTRICT"]), "name": p["DISTRICT"].strip(), "rings": rings})
    districts.sort(key=lambda d: d["id"])

    segments = []
    for f in json.load(open(ac_path))["features"]:
        p = f["properties"]
        if p["ST_NAME"] != "TAMIL NADU":
            continue
        raws = outer_rings(f["geometry"])
        main_raw = max(raws, key=lambda r: abs(area([project(*pt) for pt in r])))
        ring = clean_ring(main_raw, SEGMENT_TOLERANCE_M)
        # Centroid from the full-detail outline: simplification can make thin rings degenerate.
        full = [project(*pt) for pt in main_raw]
        c = centroid(full)
        # The constituency layer predates the 2009 creation of Ariyalur and Tiruppur districts, so
        # trust its district name except where the centroid falls inside one of those two.
        district_id = DIST_ALIASES.get(slug(p["DIST_NAME"]), slug(p["DIST_NAME"]))
        for newer in ("ariyalur", "tiruppur"):
            d = next(d for d in districts if d["id"] == newer)
            if any(contains(r, c) for r in d["rings"]):
                district_id = newer
        district = next(d for d in districts if d["id"] == district_id)
        name = re.sub(r"\s*\((SC|ST)\)\s*", "", p["AC_NAME"]).strip()
        segments.append({
            "id": f"tn-ac-{int(p['AC_NO']):03d}",
            "name": name,
            "acNo": int(p["AC_NO"]),
            "districtId": district["id"],
            "ring": ring,
            "centroid": [round(c[0]), round(c[1])],
            "areaHa": round(abs(area(ring)) / 10_000),
        })
    segments.sort(key=lambda s: s["acNo"])

    out = {
        "source": "DataMeet maps (https://github.com/datameet/maps): Census 2011 districts and assembly constituencies, CC BY 2.5 IN",
        "origin": {"lat": ORIGIN_LAT, "lon": ORIGIN_LON},
        "districts": districts,
        "segments": segments,
    }
    text = json.dumps(out, separators=(",", ":"))
    open(out_path, "w").write(text)
    print(f"{len(districts)} districts, {len(segments)} segments, {len(text)/1024:.0f} KB, sha256 {hashlib.sha256(text.encode()).hexdigest()[:16]}")
    for d in districts:
        print(f"  {d['id']}: {sum(1 for s in segments if s['districtId']==d['id'])} segments")


if __name__ == "__main__":
    main(*sys.argv[1:4])

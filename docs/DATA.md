# Reference data — Tamil Nadu world

The playable world is the real map of Tamil Nadu. All reference data is bundled, versioned with
`RULESET_VERSION`, and never fetched live during play.

| Data | Source | Licence | Where |
| --- | --- | --- | --- |
| District boundaries (Census 2011, 32 districts) | DataMeet `maps` — `dists11.geojson` | CC BY 2.5 India | `packages/domain/src/data/tamilnadu-geo.json` |
| Map segments (234 assembly-constituency areas) | DataMeet `maps` — `ac.geojson` | CC BY 2.5 India | same file |
| Agro-climatic zones, dominant soils, irrigation sources | TNAU Agritech Portal district profiles (summarised) | facts, re-expressed | `packages/domain/src/tamilnadu.ts` |
| Annual rainfall normals per district | IMD district normals (approximate) | facts, re-expressed | `packages/domain/src/tamilnadu.ts` |
| Mandi locations | District headquarters (approximate lat/lon) | facts | `packages/domain/src/region.ts` |
| Highways, River Kaveri | Approximate waypoints | facts | `packages/domain/src/region.ts` |

Attribution (required by CC BY 2.5 IN): *Boundaries © DataMeet contributors, CC BY 2.5 India.*

## Rebuilding the map

```bash
mkdir -p /tmp/bh-geo && cd /tmp/bh-geo
curl -LO https://raw.githubusercontent.com/datameet/maps/master/website/docs/data/geojson/ac.geojson
curl -LO https://raw.githubusercontent.com/datameet/maps/master/website/docs/data/geojson/dists11.geojson
cd - && python3 scripts/geo/build_tamilnadu.py /tmp/bh-geo/ac.geojson /tmp/bh-geo/dists11.geojson \
  packages/domain/src/data/tamilnadu-geo.json
```

The script projects WGS84 to local metres around 10.9°N 78.4°E, simplifies outlines
(Douglas–Peucker, 600 m segments / 900 m districts) and assigns each constituency to its 2011
district (constituency layer predates Ariyalur/Tiruppur, resolved geometrically).

## How land works

- Each rural segment holds 3–12 farm **holdings** (1–15 acres; starter plots 1–2.5 acres, two per
  district). Players buy or lease holdings; the map is not cut into tiles.
- A holding's soil, irrigation source, elevation and slope are drawn from its district profile;
  holdings near the Kaveri get canal/river water. Climate and daily weather are per district
  (zone rainfall shape scaled to the district's annual normal; north-east monsoon dominates the
  delta and the east coast).
- Seasons are shown with Tamil Nadu names: Kuruvai (Jun–Aug), Samba/Thaladi (Sep–Nov),
  Navarai (Dec–Feb), Kodai (Mar–May).
- Values are calibrated for gameplay. They are a simulation, not agronomic advice.

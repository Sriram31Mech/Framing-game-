-- Tamil Nadu has ONE price per crop. Every mandi row of an item in a region now holds the same
-- state: price and supply pressure from the item's first mandi (by market_id, the canonical row
-- the game reads) and statewide demand = the sum of every mandi's demand for the item.
WITH canonical AS (
  SELECT DISTINCT ON (m.region_id, s.item_id)
         m.region_id, s.item_id, s.price_paise_per_kg, s.supply_pressure_kg
  FROM market_item_states s JOIN markets m ON m.id = s.market_id
  ORDER BY m.region_id, s.item_id, s.market_id
),
demand AS (
  SELECT m.region_id, s.item_id, SUM(s.demand_kg_per_day)::bigint AS demand_kg_per_day
  FROM market_item_states s JOIN markets m ON m.id = s.market_id
  GROUP BY m.region_id, s.item_id
)
UPDATE market_item_states s
SET price_paise_per_kg = c.price_paise_per_kg,
    supply_pressure_kg = c.supply_pressure_kg,
    demand_kg_per_day = d.demand_kg_per_day,
    version = s.version + 1
FROM markets m, canonical c, demand d
WHERE m.id = s.market_id
  AND c.region_id = m.region_id AND c.item_id = s.item_id
  AND d.region_id = m.region_id AND d.item_id = s.item_id;

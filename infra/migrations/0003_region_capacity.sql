-- The world is now the whole of Tamil Nadu. The "~16 concurrent players per region" design
-- target is about simultaneous load, not total companies, so allow many more companies to join.
-- Companies beyond the reserved starter plots receive NO_STARTER_PLOT_BONUS cash instead.
ALTER TABLE regions ALTER COLUMN max_human_companies SET DEFAULT 1000;
UPDATE regions SET max_human_companies = 1000 WHERE max_human_companies < 1000;

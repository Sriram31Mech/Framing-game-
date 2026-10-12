-- Holdings are grouped into real map segments (assembly-constituency areas of Tamil Nadu).
-- The segment id lives in land_parcels.env; index it for per-segment browsing and stats.
CREATE INDEX land_parcels_segment_idx ON land_parcels ((env->>'segmentId'));

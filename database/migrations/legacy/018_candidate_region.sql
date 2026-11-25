-- =============================================================================
-- 018_candidate_region.sql
--
-- Give candidates their own region (entity), like clients/vendors/placements.
-- Previously a candidate was tied to a region only indirectly through their
-- placements, so the region switcher couldn't scope them directly.
--
-- Backfills each existing candidate's region from their most recent placement;
-- candidates with no placements are left NULL (they show only under "All regions").
-- Idempotent.
-- =============================================================================
BEGIN;

ALTER TABLE candidates
  ADD COLUMN IF NOT EXISTS region_id integer REFERENCES regions(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_candidates_region ON candidates (region_id);

-- Backfill from the candidate's latest placement (by start date, then id).
UPDATE candidates c
   SET region_id = sub.region_id
  FROM (
    SELECT DISTINCT ON (candidate_id) candidate_id, region_id
      FROM placements
     WHERE region_id IS NOT NULL
     ORDER BY candidate_id, start_date DESC NULLS LAST, id DESC
  ) sub
 WHERE c.id = sub.candidate_id
   AND c.region_id IS NULL;

COMMIT;

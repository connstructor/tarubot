-- Existing reviews retain their IDs, decisions, and controls; legacy answers are explicitly absent.
ALTER TABLE guest_applications
  ADD COLUMN introduction text,
  ADD COLUMN interest text,
  ADD CONSTRAINT guest_application_answers CHECK (
    (introduction IS NULL AND interest IS NULL) OR
    (introduction IS NOT NULL AND interest IS NOT NULL AND
      length(btrim(introduction)) BETWEEN 10 AND 300 AND
      length(btrim(interest)) BETWEEN 10 AND 300)
  );

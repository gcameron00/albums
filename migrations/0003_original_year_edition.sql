-- original_year: set by hand (edit page or MCP) when Apple's date is a
-- reissue's. `year` stays the year shown, sorted and filtered on: the
-- original year when set, otherwise the year of release_date.
-- edition: label taken out of Apple's title ("Remastered"), shown with the
-- edition's release_date on the album page only.
ALTER TABLE albums ADD COLUMN original_year INTEGER;
ALTER TABLE albums ADD COLUMN edition TEXT;

-- Titles stored before labels were split off. New albums are split on add
-- (src/edition.ts); only the common "Remastered" forms exist so far.
UPDATE albums SET edition = 'Remastered', title = substr(title, 1, length(title) - length(' ((Remastered))'))
  WHERE title LIKE '% ((Remastered))';
UPDATE albums SET edition = 'Remastered', title = substr(title, 1, length(title) - length(' (Remastered)'))
  WHERE title LIKE '% (Remastered)';

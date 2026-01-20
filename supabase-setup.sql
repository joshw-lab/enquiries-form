-- Create the postcode_zones table
CREATE TABLE postcode_zones (
  postcode_prefix TEXT PRIMARY KEY,
  map_url TEXT NOT NULL,
  calendar_url TEXT NOT NULL
);

-- Enable Row Level Security
ALTER TABLE postcode_zones ENABLE ROW LEVEL SECURITY;

-- Create a policy that allows public read access
CREATE POLICY "Allow public read access" ON postcode_zones
  FOR SELECT USING (true);

-- Seed data
INSERT INTO postcode_zones (postcode_prefix, map_url, calendar_url) VALUES
(
  '6000',
  'https://www.google.com/maps/d/u/3/viewer?mid=1ZlMJEtBVIJP7b1jIAwQBHifxjvwBQdnQ&ll=-32.098357557959496%2C115.90999040539053&z=9',
  'https://calendar.google.com/calendar/u/0?cid=Y29tcGxldGVob21lZmlsdHJhdGlvbi5jb20uYXVfYWYzNDBtb2QxMGhhbTNpaDk3ODFjaW5kN2tAZ3JvdXAuY2FsZW5kYXIuZ29vZ2xlLmNvbQ'
),
(
  '2000',
  'https://www.google.com/maps/d/u/3/viewer?mid=1ZlMJEtBVIJP7b1jIAwQBHifxjvwBQdnQ&ll=-33.6668732734025%2C151.02175790802502&z=9',
  'https://calendar.google.com/calendar/u/0?cid=Y29tcGxldGVob21lZmlsdHJhdGlvbi5jb20uYXVfNGhrcHExbnVkZ3JzY2NwcTJwbGF1MjRhbjBAZ3JvdXAuY2FsZW5kYXIuZ29vZ2xlLmNvbQ'
);

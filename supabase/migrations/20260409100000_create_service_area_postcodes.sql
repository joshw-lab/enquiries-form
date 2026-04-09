-- Service area postcodes table — replaces hardcoded TypeScript Set
-- Admin users can edit these from the reports UI
CREATE TABLE IF NOT EXISTS service_area_postcodes (
  id SERIAL PRIMARY KEY,
  state TEXT NOT NULL,
  postcode TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(postcode)
);

CREATE INDEX idx_service_area_postcodes_state ON service_area_postcodes(state);

-- Seed data from supabase/functions/_shared/service-area-postcodes.ts

-- WA
INSERT INTO service_area_postcodes (state, postcode)
SELECT 'WA', p::text FROM generate_series(6000, 6039) p
UNION ALL SELECT 'WA', p::text FROM generate_series(6050, 6071) p
UNION ALL SELECT 'WA', '6076'
UNION ALL SELECT 'WA', '6077'
UNION ALL SELECT 'WA', '6084'
UNION ALL SELECT 'WA', '6090'
UNION ALL SELECT 'WA', p::text FROM generate_series(6100, 6112) p
UNION ALL SELECT 'WA', '6121'
UNION ALL SELECT 'WA', '6122'
UNION ALL SELECT 'WA', '6123'
UNION ALL SELECT 'WA', '6125'
UNION ALL SELECT 'WA', p::text FROM generate_series(6147, 6176) p
UNION ALL SELECT 'WA', p::text FROM generate_series(6180, 6182) p
UNION ALL SELECT 'WA', '6207'
UNION ALL SELECT 'WA', '6208'
UNION ALL SELECT 'WA', '6209'
UNION ALL SELECT 'WA', '6210'
UNION ALL SELECT 'WA', '6211'
UNION ALL SELECT 'WA', '6224'
UNION ALL SELECT 'WA', p::text FROM generate_series(6226, 6233) p
UNION ALL SELECT 'WA', '6237'
UNION ALL SELECT 'WA', '6271'
UNION ALL SELECT 'WA', '6280'
UNION ALL SELECT 'WA', '6281'
ON CONFLICT (postcode) DO NOTHING;

-- VIC
INSERT INTO service_area_postcodes (state, postcode)
SELECT 'VIC', p::text FROM generate_series(3000, 3228) p
UNION ALL SELECT 'VIC', '3331'
UNION ALL SELECT 'VIC', p::text FROM generate_series(3335, 3338) p
UNION ALL SELECT 'VIC', '3428'
UNION ALL SELECT 'VIC', p::text FROM generate_series(3750, 3757) p
UNION ALL SELECT 'VIC', '3765'
UNION ALL SELECT 'VIC', '3766'
UNION ALL SELECT 'VIC', '3767'
UNION ALL SELECT 'VIC', p::text FROM generate_series(3785, 3790) p
UNION ALL SELECT 'VIC', '3796'
UNION ALL SELECT 'VIC', p::text FROM generate_series(3800, 3811) p
UNION ALL SELECT 'VIC', p::text FROM generate_series(3901, 3912) p
UNION ALL SELECT 'VIC', p::text FROM generate_series(3915, 3929) p
UNION ALL SELECT 'VIC', '3931'
UNION ALL SELECT 'VIC', '3933'
UNION ALL SELECT 'VIC', '3934'
UNION ALL SELECT 'VIC', p::text FROM generate_series(3936, 3978) p
UNION ALL SELECT 'VIC', p::text FROM generate_series(3980, 3999) p
ON CONFLICT (postcode) DO NOTHING;

-- NSW/ACT
INSERT INTO service_area_postcodes (state, postcode)
SELECT 'NSW/ACT', p::text FROM generate_series(2000, 2234) p
UNION ALL SELECT 'NSW/ACT', p::text FROM generate_series(2250, 2263) p
UNION ALL SELECT 'NSW/ACT', p::text FROM generate_series(2500, 2533) p
UNION ALL SELECT 'NSW/ACT', p::text FROM generate_series(2555, 2574) p
UNION ALL SELECT 'NSW/ACT', p::text FROM generate_series(2600, 2621) p
UNION ALL SELECT 'NSW/ACT', p::text FROM generate_series(2745, 2775) p
UNION ALL SELECT 'NSW/ACT', p::text FROM generate_series(2900, 2914) p
ON CONFLICT (postcode) DO NOTHING;

-- QLD
INSERT INTO service_area_postcodes (state, postcode)
SELECT 'QLD', p::text FROM generate_series(4000, 4014) p
UNION ALL SELECT 'QLD', p::text FROM generate_series(4017, 4022) p
UNION ALL SELECT 'QLD', '4029'
UNION ALL SELECT 'QLD', p::text FROM generate_series(4030, 4032) p
UNION ALL SELECT 'QLD', p::text FROM generate_series(4034, 4037) p
UNION ALL SELECT 'QLD', '4051'
UNION ALL SELECT 'QLD', '4053'
UNION ALL SELECT 'QLD', '4054'
UNION ALL SELECT 'QLD', '4055'
UNION ALL SELECT 'QLD', '4059'
UNION ALL SELECT 'QLD', '4060'
UNION ALL SELECT 'QLD', '4061'
UNION ALL SELECT 'QLD', p::text FROM generate_series(4064, 4070) p
UNION ALL SELECT 'QLD', p::text FROM generate_series(4072, 4078) p
UNION ALL SELECT 'QLD', p::text FROM generate_series(4101, 4133) p
UNION ALL SELECT 'QLD', p::text FROM generate_series(4151, 4161) p
UNION ALL SELECT 'QLD', p::text FROM generate_series(4163, 4165) p
UNION ALL SELECT 'QLD', '4169'
UNION ALL SELECT 'QLD', p::text FROM generate_series(4170, 4174) p
UNION ALL SELECT 'QLD', '4178'
UNION ALL SELECT 'QLD', '4179'
UNION ALL SELECT 'QLD', '4205'
UNION ALL SELECT 'QLD', p::text FROM generate_series(4207, 4228) p
UNION ALL SELECT 'QLD', '4230'
UNION ALL SELECT 'QLD', '4270'
UNION ALL SELECT 'QLD', '4280'
UNION ALL SELECT 'QLD', p::text FROM generate_series(4300, 4306) p
UNION ALL SELECT 'QLD', p::text FROM generate_series(4500, 4579) p
ON CONFLICT (postcode) DO NOTHING;

-- SA
INSERT INTO service_area_postcodes (state, postcode)
SELECT 'SA', p::text FROM generate_series(5000, 5126) p
UNION ALL SELECT 'SA', p::text FROM generate_series(5131, 5133) p
UNION ALL SELECT 'SA', '5140'
UNION ALL SELECT 'SA', '5141'
UNION ALL SELECT 'SA', p::text FROM generate_series(5150, 5174) p
UNION ALL SELECT 'SA', '5242'
UNION ALL SELECT 'SA', p::text FROM generate_series(5245, 5252) p
ON CONFLICT (postcode) DO NOTHING;

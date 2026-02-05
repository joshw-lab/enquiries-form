/**
 * Script to check HubSpot property definitions and allowed values
 * Run with: node check-hubspot-properties.js
 */

const HUBSPOT_API_BASE = "https://api.hubapi.com";
const ACCESS_TOKEN = process.env.HUBSPOT_ACCESS_TOKEN;

if (!ACCESS_TOKEN) {
  console.error("HUBSPOT_ACCESS_TOKEN environment variable not set");
  process.exit(1);
}

// Properties we're using in the Book Water Test form
const PROPERTIES_TO_CHECK = [
  "n1__home_owner_",
  "n1__mains_water_",
  "n1__number_of_people_in_the_house",
  "type_of_property",
  "n1__strata",
  "n1__referred_",
  "n1__how_did_you_find_out_about_us_",
  "water_concerns",
  "hs_lead_status",
  "water_test_time",
  "water_test_date",
];

async function getPropertyDefinition(propertyName) {
  try {
    const response = await fetch(
      `${HUBSPOT_API_BASE}/crm/v3/properties/contacts/${propertyName}`,
      {
        headers: {
          Authorization: `Bearer ${ACCESS_TOKEN}`,
        },
      }
    );

    if (!response.ok) {
      console.error(`Failed to fetch ${propertyName}: ${response.statusText}`);
      return null;
    }

    return await response.json();
  } catch (error) {
    console.error(`Error fetching ${propertyName}:`, error);
    return null;
  }
}

async function main() {
  console.log("Fetching HubSpot property definitions...\n");

  for (const propertyName of PROPERTIES_TO_CHECK) {
    console.log(`\n${"=".repeat(60)}`);
    console.log(`Property: ${propertyName}`);
    console.log("=".repeat(60));

    const definition = await getPropertyDefinition(propertyName);

    if (definition) {
      console.log(`Label: ${definition.label}`);
      console.log(`Type: ${definition.type}`);
      console.log(`Field Type: ${definition.fieldType}`);

      if (definition.options && definition.options.length > 0) {
        console.log(`\nAllowed Options (${definition.options.length}):`);
        definition.options.forEach((opt) => {
          console.log(`  - "${opt.label}" (internal value: "${opt.value}")`);
        });
      }

      if (definition.description) {
        console.log(`\nDescription: ${definition.description}`);
      }
    }

    // Small delay to avoid rate limiting
    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  console.log("\n" + "=".repeat(60));
  console.log("Property check complete!");
  console.log("=".repeat(60));
}

main().catch(console.error);

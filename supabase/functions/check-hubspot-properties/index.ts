import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const HUBSPOT_API_BASE = "https://api.hubapi.com";

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
  "new_advised_not_interested__classification_",
  "n1__amberlist___not_ready_now",
  "n1__greylist___advised_not_interested",
  "n1__blacklist___do_not_contact",
];

async function getPropertyDefinition(propertyName: string, accessToken: string) {
  try {
    const response = await fetch(
      `${HUBSPOT_API_BASE}/crm/v3/properties/contacts/${propertyName}`,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      }
    );

    if (!response.ok) {
      return {
        error: `Failed to fetch: ${response.statusText}`,
        propertyName,
      };
    }

    return await response.json();
  } catch (error) {
    return {
      error: error.message,
      propertyName,
    };
  }
}

serve(async (req) => {
  const accessToken = Deno.env.get("HUBSPOT_ACCESS_TOKEN");

  if (!accessToken) {
    return new Response(
      JSON.stringify({ error: "HubSpot access token not configured" }),
      {
        headers: { "Content-Type": "application/json" },
        status: 500,
      }
    );
  }

  const results: Record<string, any> = {};

  for (const propertyName of PROPERTIES_TO_CHECK) {
    results[propertyName] = await getPropertyDefinition(propertyName, accessToken);
    // Small delay to avoid rate limiting
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  return new Response(JSON.stringify(results, null, 2), {
    headers: { "Content-Type": "application/json" },
    status: 200,
  });
});

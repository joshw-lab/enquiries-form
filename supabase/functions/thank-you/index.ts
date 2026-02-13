import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const HUBSPOT_API_BASE = "https://api.hubapi.com";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

/**
 * Fetch compiled_notes from HubSpot for a given contact
 */
async function fetchCompiledNotes(
  contactId: string,
  accessToken: string
): Promise<{ success: boolean; compiledNotes?: string; contactName?: string; error?: string }> {
  try {
    const properties = "compiled_notes,firstname,lastname";
    const response = await fetch(
      `${HUBSPOT_API_BASE}/crm/v3/objects/contacts/${contactId}?properties=${properties}`,
      {
        method: "GET",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${accessToken}`,
        },
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      console.error("HubSpot fetch failed:", errorText);
      return { success: false, error: "Could not fetch contact data" };
    }

    const data = await response.json();
    const props = data.properties || {};
    const contactName = [props.firstname, props.lastname].filter(Boolean).join(" ");

    return {
      success: true,
      compiledNotes: props.compiled_notes || "",
      contactName,
    };
  } catch (error) {
    console.error("HubSpot API error:", error);
    return { success: false, error: error.message };
  }
}

serve(async (req) => {
  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const url = new URL(req.url);
  const contactId =
    url.searchParams.get("contactId") || url.searchParams.get("contact_id");
  const isAjax = url.searchParams.get("fetch") === "true";

  // AJAX mode: return JSON with compiled notes (used by client-side retry)
  if (isAjax) {
    if (!contactId) {
      return new Response(
        JSON.stringify({ success: false, error: "contactId is required" }),
        {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
          status: 400,
        }
      );
    }

    const hubspotAccessToken = Deno.env.get("HUBSPOT_ACCESS_TOKEN");
    if (!hubspotAccessToken) {
      return new Response(
        JSON.stringify({ success: false, error: "HubSpot not configured" }),
        {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
          status: 500,
        }
      );
    }

    const result = await fetchCompiledNotes(contactId, hubspotAccessToken);
    return new Response(JSON.stringify(result), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      status: result.success ? 200 : 500,
    });
  }

  // HTML mode: serve the thank-you page
  return new Response(buildHTML(contactId), {
    headers: { "Content-Type": "text/html; charset=utf-8" },
    status: 200,
  });
});

function buildHTML(contactId: string | null): string {
  if (!contactId) {
    return errorPage(
      "No contact ID was provided. Please check the link you were given."
    );
  }

  // The page calls back to itself with ?fetch=true for data
  const fetchURL = `?contactId=${contactId}&fetch=true`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Thank You - Submission Complete</title>
  <style>${getStyles()}</style>
</head>
<body>
  <div class="container">
    <div class="card">
      <div class="icon success-icon" id="headerIcon">&#10003;</div>
      <h1>Submission Complete</h1>
      <p class="subtitle" id="statusText">Compiling notes, please wait...</p>

      <div id="loadingSection" class="loading-section">
        <div class="spinner"></div>
        <p class="loading-text">Fetching compiled notes from HubSpot...</p>
      </div>

      <div id="notesSection" class="notes-section" style="display: none;">
        <label for="compiledNotes">Compiled Notes</label>
        <div class="notes-wrapper">
          <pre id="compiledNotes" class="notes-content"></pre>
        </div>
        <button id="copyBtn" class="copy-btn" onclick="copyNotes()">
          <span id="copyIcon" class="btn-icon">&#128203;</span>
          <span id="copyText">Copy to Clipboard</span>
          <span id="copySuccess" style="display: none;">
            <span class="btn-icon">&#10003;</span> Copied!
          </span>
        </button>
      </div>

      <div id="emptySection" class="empty-section" style="display: none;">
        <p>No compiled notes are available for this contact yet.</p>
        <button class="retry-btn" onclick="startFetch()">Try Again</button>
      </div>

      <div id="errorSection" class="error-section" style="display: none;">
        <p id="errorText" class="error-message"></p>
        <button class="retry-btn" onclick="startFetch()">Retry</button>
      </div>
    </div>
  </div>

  <script>
    var FETCH_URL = "${fetchURL}";
    var INITIAL_DELAY = 5000;
    var RETRY_DELAY = 3000;
    var MAX_RETRIES = 3;
    var retryCount = 0;

    function showSection(sectionId) {
      ['loadingSection', 'notesSection', 'emptySection', 'errorSection'].forEach(function(id) {
        document.getElementById(id).style.display = 'none';
      });
      document.getElementById(sectionId).style.display = 'block';
    }

    function startFetch() {
      retryCount = 0;
      fetchNotes();
    }

    function fetchNotes() {
      showSection('loadingSection');
      document.getElementById('statusText').textContent = retryCount > 0
        ? 'Notes still compiling... (attempt ' + (retryCount + 1) + '/' + (MAX_RETRIES + 1) + ')'
        : 'Compiling notes, please wait...';

      fetch(FETCH_URL)
        .then(function(resp) { return resp.json(); })
        .then(function(data) {
          if (!data.success) {
            throw new Error(data.error || 'Failed to fetch contact');
          }

          var notes = data.compiledNotes;

          if (notes && notes.trim() !== '') {
            document.getElementById('compiledNotes').textContent = notes;
            document.getElementById('statusText').textContent =
              data.contactName ? 'Notes for ' + data.contactName : 'Your notes are ready.';
            showSection('notesSection');
            retryCount = 0;
          } else if (retryCount < MAX_RETRIES) {
            retryCount++;
            document.getElementById('statusText').textContent =
              'Notes still compiling... (attempt ' + (retryCount + 1) + '/' + (MAX_RETRIES + 1) + ')';
            setTimeout(fetchNotes, RETRY_DELAY);
          } else {
            document.getElementById('statusText').textContent = 'Notes not available.';
            showSection('emptySection');
            retryCount = 0;
          }
        })
        .catch(function(err) {
          document.getElementById('errorText').textContent = err.message;
          document.getElementById('statusText').textContent = 'Error loading notes.';
          showSection('errorSection');
          retryCount = 0;
        });
    }

    function copyNotes() {
      var text = document.getElementById('compiledNotes').textContent;
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(showCopied).catch(fallbackCopy);
      } else {
        fallbackCopy();
      }

      function fallbackCopy() {
        var textarea = document.createElement('textarea');
        textarea.value = text;
        textarea.style.position = 'fixed';
        textarea.style.opacity = '0';
        document.body.appendChild(textarea);
        textarea.select();
        try { document.execCommand('copy'); showCopied(); }
        catch(e) { /* silent */ }
        document.body.removeChild(textarea);
      }

      function showCopied() {
        var btn = document.getElementById('copyBtn');
        var copyText = document.getElementById('copyText');
        var copyIcon = document.getElementById('copyIcon');
        var copySuccess = document.getElementById('copySuccess');
        copyText.style.display = 'none';
        copyIcon.style.display = 'none';
        copySuccess.style.display = 'inline';
        btn.classList.add('copied');
        setTimeout(function() {
          copyText.style.display = 'inline';
          copyIcon.style.display = 'inline';
          copySuccess.style.display = 'none';
          btn.classList.remove('copied');
        }, 2000);
      }
    }

    // Start fetching after initial delay to let HubSpot workflow compile notes
    setTimeout(fetchNotes, INITIAL_DELAY);
  </script>
</body>
</html>`;
}

function errorPage(message: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Thank You</title>
  <style>${getStyles()}</style>
</head>
<body>
  <div class="container">
    <div class="card">
      <div class="icon error-icon">!</div>
      <h1>Something went wrong</h1>
      <p class="error-message">${message}</p>
    </div>
  </div>
</body>
</html>`;
}

function getStyles(): string {
  return `
    * { margin: 0; padding: 0; box-sizing: border-box; }

    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, sans-serif;
      background: #f0f2f5;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 20px;
    }

    .container {
      width: 100%;
      max-width: 640px;
    }

    .card {
      background: #fff;
      border-radius: 12px;
      padding: 40px 32px;
      box-shadow: 0 2px 12px rgba(0, 0, 0, 0.08);
      text-align: center;
    }

    .icon {
      width: 56px;
      height: 56px;
      border-radius: 50%;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      font-size: 28px;
      font-weight: bold;
      margin-bottom: 16px;
    }

    .success-icon {
      background: #e6f4ea;
      color: #1e7e34;
    }

    .error-icon {
      background: #fce8e6;
      color: #c62828;
    }

    h1 {
      font-size: 22px;
      color: #1a1a1a;
      margin-bottom: 8px;
      font-weight: 600;
    }

    .subtitle {
      color: #666;
      font-size: 14px;
      margin-bottom: 28px;
    }

    .loading-section {
      padding: 24px 0;
    }

    .spinner {
      width: 36px;
      height: 36px;
      border: 3px solid #e0e0e0;
      border-top-color: #1a73e8;
      border-radius: 50%;
      animation: spin 0.8s linear infinite;
      margin: 0 auto 16px;
    }

    @keyframes spin {
      to { transform: rotate(360deg); }
    }

    .loading-text {
      color: #888;
      font-size: 13px;
    }

    .notes-section {
      text-align: left;
    }

    .notes-section label {
      display: block;
      font-size: 12px;
      font-weight: 600;
      color: #555;
      margin-bottom: 8px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }

    .notes-wrapper {
      background: #f8f9fa;
      border: 1px solid #e0e0e0;
      border-radius: 8px;
      max-height: 400px;
      overflow-y: auto;
      margin-bottom: 16px;
    }

    .notes-content {
      padding: 16px;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, sans-serif;
      font-size: 14px;
      line-height: 1.6;
      color: #333;
      white-space: pre-wrap;
      word-wrap: break-word;
      margin: 0;
    }

    .copy-btn {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 10px 24px;
      font-size: 14px;
      font-weight: 500;
      color: #fff;
      background: #1a73e8;
      border: none;
      border-radius: 6px;
      cursor: pointer;
      transition: background 0.2s;
    }

    .copy-btn:hover {
      background: #1557b0;
    }

    .copy-btn.copied {
      background: #1e7e34;
    }

    .btn-icon {
      font-size: 16px;
    }

    .retry-btn {
      padding: 10px 24px;
      font-size: 14px;
      font-weight: 500;
      color: #1a73e8;
      background: #e8f0fe;
      border: none;
      border-radius: 6px;
      cursor: pointer;
      transition: background 0.2s;
    }

    .retry-btn:hover {
      background: #d2e3fc;
    }

    .error-message {
      color: #c62828;
      font-size: 14px;
      margin-bottom: 16px;
    }

    .empty-section {
      text-align: center;
    }

    .empty-section p {
      color: #666;
      font-size: 14px;
      margin-bottom: 16px;
    }

    .error-section {
      padding: 16px 0;
      text-align: center;
    }
  `;
}

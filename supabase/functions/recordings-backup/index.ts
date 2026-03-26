import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

// Max recordings to process per invocation
const BATCH_SIZE = 50;

// Dispositions where no meaningful conversation occurred — skip recording backup
const SKIP_DISPOSITIONS = new Set([
  "No Answer",
  "No-Answer",
  "Busy",
  "Dead Air",
  "Dead-Air",
  "Hang Up",
  "Hang-Up",
  "Machine",
  "Answering Machine",
  "Answering-Machine",
  "Left Voicemail",
]);

/**
 * Triage pending call_recordings:
 *   - Skip dispositions (No Answer, Busy, etc.) → no_recording
 *   - No recording URL → no_recording
 *   - Valid recording → awaiting_gdrive (picked up by recordings-backfill once SFTP delivers the WAV)
 */
serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const supabaseClient = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SB_SERVICE_ROLE_KEY") ?? ""
    );

    // Fetch pending recordings
    const { data: pendingRecordings, error: fetchError } = await supabaseClient
      .from("call_recordings")
      .select("id, call_id, disposition, ringcx_recording_url")
      .eq("backup_status", "pending")
      .order("call_start", { ascending: false })
      .limit(BATCH_SIZE);

    if (fetchError) {
      throw new Error(`Failed to fetch pending recordings: ${fetchError.message}`);
    }

    if (!pendingRecordings || pendingRecordings.length === 0) {
      return new Response(
        JSON.stringify({ success: true, message: "No pending recordings to process", processed: 0 }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    console.log(`Triaging ${pendingRecordings.length} pending recordings...`);

    let processed = 0;
    let awaitingGdrive = 0;
    let noRecording = 0;
    const results: Array<{ call_id: string; status: string }> = [];

    for (const recording of pendingRecordings) {
      // Skip non-conversation dispositions
      if (recording.disposition && SKIP_DISPOSITIONS.has(recording.disposition)) {
        await supabaseClient
          .from("call_recordings")
          .update({ backup_status: "no_recording" })
          .eq("id", recording.id);
        results.push({ call_id: recording.call_id, status: "no_recording" });
        noRecording++;
        processed++;
        continue;
      }

      if (!recording.ringcx_recording_url) {
        await supabaseClient
          .from("call_recordings")
          .update({ backup_status: "no_recording" })
          .eq("id", recording.id);
        results.push({ call_id: recording.call_id, status: "no_recording" });
        noRecording++;
        processed++;
        continue;
      }

      // Valid recording — mark as awaiting GDrive match.
      // The SFTP pipeline delivers WAV files to GDrive, and
      // recordings-backfill matches them to this row.
      await supabaseClient
        .from("call_recordings")
        .update({ backup_status: "awaiting_gdrive" })
        .eq("id", recording.id);

      results.push({ call_id: recording.call_id, status: "awaiting_gdrive" });
      awaitingGdrive++;
      processed++;
    }

    console.log(`Triage complete: ${awaitingGdrive} awaiting GDrive, ${noRecording} no recording, ${processed} total`);

    return new Response(
      JSON.stringify({
        success: true,
        processed,
        awaitingGdrive,
        noRecording,
        results,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error) {
    console.error("Recordings backup error:", error);
    return new Response(
      JSON.stringify({ success: false, error: error.message }),
      {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
        status: 500,
      }
    );
  }
});

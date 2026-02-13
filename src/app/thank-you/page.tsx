"use client";

import { useSearchParams } from "next/navigation";
import { useEffect, useState, useCallback, Suspense } from "react";

const SUPABASE_FUNCTION_URL =
  "https://rzvuzdwhvahwqqhzmuli.supabase.co/functions/v1/thank-you";
const INITIAL_DELAY = 5000;
const RETRY_DELAY = 3000;
const MAX_RETRIES = 3;

type Status = "loading" | "success" | "empty" | "error";

function ThankYouContent() {
  const searchParams = useSearchParams();
  const contactId = searchParams.get("contactId") || searchParams.get("contact_id");

  const [status, setStatus] = useState<Status>("loading");
  const [compiledNotes, setCompiledNotes] = useState("");
  const [contactName, setContactName] = useState("");
  const [errorMessage, setErrorMessage] = useState("");
  const [retryCount, setRetryCount] = useState(0);
  const [copied, setCopied] = useState(false);

  const fetchNotes = useCallback(
    async (attempt: number) => {
      if (!contactId) return;

      setStatus("loading");

      try {
        const resp = await fetch(
          `${SUPABASE_FUNCTION_URL}?contactId=${contactId}&fetch=true`
        );
        const data = await resp.json();

        if (!data.success) {
          throw new Error(data.error || "Failed to fetch contact");
        }

        const notes = data.compiledNotes;

        if (notes && notes.trim() !== "") {
          setCompiledNotes(notes);
          setContactName(data.contactName || "");
          setStatus("success");
          setRetryCount(0);
        } else if (attempt < MAX_RETRIES) {
          setRetryCount(attempt + 1);
          setTimeout(() => fetchNotes(attempt + 1), RETRY_DELAY);
        } else {
          setStatus("empty");
          setRetryCount(0);
        }
      } catch (err) {
        setErrorMessage(err instanceof Error ? err.message : "Unknown error");
        setStatus("error");
        setRetryCount(0);
      }
    },
    [contactId]
  );

  useEffect(() => {
    if (!contactId) return;
    const timer = setTimeout(() => fetchNotes(0), INITIAL_DELAY);
    return () => clearTimeout(timer);
  }, [contactId, fetchNotes]);

  const copyToClipboard = async () => {
    try {
      await navigator.clipboard.writeText(compiledNotes);
    } catch {
      // Fallback
      const textarea = document.createElement("textarea");
      textarea.value = compiledNotes;
      textarea.style.position = "fixed";
      textarea.style.opacity = "0";
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand("copy");
      document.body.removeChild(textarea);
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  if (!contactId) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center p-5">
        <div className="w-full max-w-xl bg-white rounded-xl p-10 shadow-sm text-center">
          <div className="w-14 h-14 rounded-full bg-red-50 text-red-700 flex items-center justify-center text-2xl font-bold mx-auto mb-4">
            !
          </div>
          <h1 className="text-xl font-semibold text-gray-900 mb-2">
            Something went wrong
          </h1>
          <p className="text-red-600 text-sm">
            No contact ID was provided. Please check the link you were given.
          </p>
        </div>
      </div>
    );
  }

  const statusText =
    status === "loading" && retryCount > 0
      ? `Notes still compiling... (attempt ${retryCount + 1}/${MAX_RETRIES + 1})`
      : status === "loading"
        ? "Compiling notes, please wait..."
        : status === "success"
          ? contactName
            ? `Notes for ${contactName}`
            : "Your notes are ready."
          : status === "empty"
            ? "Notes not available."
            : "Error loading notes.";

  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center p-5">
      <div className="w-full max-w-xl bg-white rounded-xl p-10 shadow-sm text-center">
        <div className="w-14 h-14 rounded-full bg-green-50 text-green-700 flex items-center justify-center text-2xl font-bold mx-auto mb-4">
          &#10003;
        </div>
        <h1 className="text-xl font-semibold text-gray-900 mb-2">
          Submission Complete
        </h1>
        <p className="text-gray-500 text-sm mb-7">{statusText}</p>

        {/* Loading */}
        {status === "loading" && (
          <div className="py-6">
            <div className="w-9 h-9 border-3 border-gray-200 border-t-blue-600 rounded-full animate-spin mx-auto mb-4" />
            <p className="text-gray-400 text-xs">
              Fetching compiled notes from HubSpot...
            </p>
          </div>
        )}

        {/* Success */}
        {status === "success" && (
          <div className="text-left">
            <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">
              Compiled Notes
            </label>
            <div className="bg-gray-50 border border-gray-200 rounded-lg max-h-96 overflow-y-auto mb-4">
              <pre className="p-4 font-sans text-sm leading-relaxed text-gray-700 whitespace-pre-wrap break-words m-0">
                {compiledNotes}
              </pre>
            </div>
            <button
              onClick={copyToClipboard}
              className={`inline-flex items-center gap-1.5 px-6 py-2.5 text-sm font-medium text-white rounded-md cursor-pointer transition-colors ${
                copied
                  ? "bg-green-700 hover:bg-green-700"
                  : "bg-blue-600 hover:bg-blue-700"
              }`}
            >
              {copied ? (
                <>
                  <span>&#10003;</span> Copied!
                </>
              ) : (
                <>
                  <span>&#128203;</span> Copy to Clipboard
                </>
              )}
            </button>
          </div>
        )}

        {/* Empty */}
        {status === "empty" && (
          <div className="text-center">
            <p className="text-gray-500 text-sm mb-4">
              No compiled notes are available for this contact yet.
            </p>
            <button
              onClick={() => fetchNotes(0)}
              className="px-6 py-2.5 text-sm font-medium text-blue-600 bg-blue-50 rounded-md cursor-pointer hover:bg-blue-100 transition-colors"
            >
              Try Again
            </button>
          </div>
        )}

        {/* Error */}
        {status === "error" && (
          <div className="text-center py-4">
            <p className="text-red-600 text-sm mb-4">{errorMessage}</p>
            <button
              onClick={() => fetchNotes(0)}
              className="px-6 py-2.5 text-sm font-medium text-blue-600 bg-blue-50 rounded-md cursor-pointer hover:bg-blue-100 transition-colors"
            >
              Retry
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

export default function ThankYouPage() {
  return (
    <Suspense
      fallback={
        <div className="min-h-screen bg-gray-50 flex items-center justify-center p-5">
          <div className="w-full max-w-xl bg-white rounded-xl p-10 shadow-sm text-center">
            <div className="w-9 h-9 border-3 border-gray-200 border-t-blue-600 rounded-full animate-spin mx-auto" />
          </div>
        </div>
      }
    >
      <ThankYouContent />
    </Suspense>
  );
}

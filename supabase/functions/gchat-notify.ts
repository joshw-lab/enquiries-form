/**
 * Google Chat Error Notification Utility
 * Sends error notifications to Google Chat webhook
 */

const GCHAT_WEBHOOK_URL = Deno.env.get("GCHAT_ERROR_WEBHOOK_URL");

interface ErrorNotification {
  source: string;
  error: string;
  details?: Record<string, unknown>;
  timestamp?: string;
}

/**
 * Send error notification to Google Chat
 */
export async function notifyGChatError(
  notification: ErrorNotification
): Promise<void> {
  if (!GCHAT_WEBHOOK_URL) {
    console.error("GCHAT_ERROR_WEBHOOK_URL not configured");
    return;
  }

  try {
    const message = {
      text: `🚨 *Error in ${notification.source}*\n\n` +
        `*Error:* ${notification.error}\n` +
        `*Time:* ${notification.timestamp || new Date().toISOString()}\n` +
        (notification.details ? `\n*Details:*\n\`\`\`${JSON.stringify(notification.details, null, 2)}\`\`\`` : ""),
    };

    const response = await fetch(GCHAT_WEBHOOK_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(message),
    });

    if (!response.ok) {
      console.error("Failed to send Google Chat notification:", await response.text());
    }
  } catch (error) {
    console.error("Error sending Google Chat notification:", error);
  }
}

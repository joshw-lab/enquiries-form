// Resend free tier: can only send to account owner until domain is verified.
// Change to ringcentral-alerts-monitoring@completehomefiltration.com.au after domain verification.
const ALERT_EMAIL = 'josh.w@completehomefiltration.com.au';
const SENDER_EMAIL = 'onboarding@resend.dev';

async function sendEmailAlert(params: {
  source: string;
  error: string;
  details?: Record<string, any>;
}): Promise<void> {
  const resendApiKey = Deno.env.get('RESEND_API_KEY') || Deno.env.get('RESEND_API_Key');
  if (!resendApiKey) {
    console.warn('RESEND_API_KEY not configured, skipping email notification');
    return;
  }

  const detailsBlock = params.details && Object.keys(params.details).length > 0
    ? `\nDetails: ${JSON.stringify(params.details, null, 2)}`
    : '';

  const text = `Source: ${params.source}\nError: ${params.error}${detailsBlock}\nTimestamp: ${new Date().toISOString()}`;

  const html = `
    <div style="font-family: sans-serif; max-width: 600px;">
      <h2 style="color: #d32f2f; margin-bottom: 16px;">RingCX-HubSpot Integration Error</h2>
      <table style="border-collapse: collapse; width: 100%;">
        <tr><td style="padding: 8px; font-weight: bold; border-bottom: 1px solid #eee;">Source</td><td style="padding: 8px; border-bottom: 1px solid #eee;">${params.source}</td></tr>
        <tr><td style="padding: 8px; font-weight: bold; border-bottom: 1px solid #eee;">Error</td><td style="padding: 8px; border-bottom: 1px solid #eee;">${params.error.substring(0, 500)}</td></tr>
        ${params.details ? `<tr><td style="padding: 8px; font-weight: bold; border-bottom: 1px solid #eee;">Details</td><td style="padding: 8px; border-bottom: 1px solid #eee;"><pre style="margin:0; white-space: pre-wrap;">${JSON.stringify(params.details, null, 2).substring(0, 500)}</pre></td></tr>` : ''}
        <tr><td style="padding: 8px; font-weight: bold;">Timestamp</td><td style="padding: 8px;">${new Date().toISOString()}</td></tr>
      </table>
    </div>`;

  try {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${resendApiKey}`,
      },
      body: JSON.stringify({
        from: SENDER_EMAIL,
        to: ALERT_EMAIL,
        subject: `[Error] ${params.source}: ${params.error.substring(0, 80)}`,
        text,
        html,
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error('Resend email failed:', response.status, errText);
    }
  } catch (emailError) {
    console.error('Failed to send email notification:', emailError);
  }
}

export async function notifyGChatError(params: {
  source: string;
  error: string;
  details?: Record<string, any>;
}): Promise<void> {
  // Send both GChat and email in parallel — fire and forget
  const promises: Promise<void>[] = [];

  // Google Chat notification
  const webhookUrl = Deno.env.get('GOOGLE_CHAT_WEBHOOK_URL');
  if (webhookUrl) {
    const widgets = [
      { keyValue: { topLabel: 'Source', content: params.source } },
      { keyValue: { topLabel: 'Error', content: params.error.substring(0, 500) } },
    ];

    if (params.details && Object.keys(params.details).length > 0) {
      widgets.push({
        keyValue: { topLabel: 'Details', content: JSON.stringify(params.details).substring(0, 500) },
      });
    }

    widgets.push({
      keyValue: { topLabel: 'Timestamp', content: new Date().toISOString() },
    });

    const gchatPayload = {
      cards: [{
        header: { title: 'RingCX-HubSpot Integration Error' },
        sections: [{ widgets }],
      }],
    };

    promises.push(
      fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(gchatPayload),
      }).then(() => {}).catch((err) => {
        console.error('Failed to send Google Chat notification:', err);
      })
    );
  }

  // Email notification via Resend
  promises.push(sendEmailAlert(params));

  await Promise.allSettled(promises);
}

export async function notifyGChatSuccess(message: string): Promise<void> {
  const webhookUrl = Deno.env.get('GOOGLE_CHAT_WEBHOOK_URL');

  if (!webhookUrl) return;

  const payload = { text: message };

  try {
    await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  } catch (gchatError) {
    console.error('Failed to send Google Chat notification:', gchatError);
  }
}

import { env } from "./env";

/**
 * Magic-link delivery.
 *
 * D6 is emphatic that this is worth care: "magic links landing in spam is the
 * single most likely cause of a broken activation funnel". It also says to use
 * a provider API rather than SMTP, because we block outbound port 25 on our own
 * infrastructure and should not then depend on SMTP.
 *
 * Three transports, chosen with EMAIL_PROVIDER:
 *
 *   console  (default in dev) — prints the link. Sends nothing.
 *   resend                    — HTTPS API. Works with no domain of your own:
 *                               Resend's onboarding@resend.dev sender can post
 *                               to your own verified address. This is the one
 *                               to use before a domain exists.
 *   smtp                      — Gmail or any SMTP server, via an app password.
 *                               Testing only: personal-Gmail send limits are
 *                               low and a gmail.com From address to strangers
 *                               lands in spam. Never point production at this.
 *
 * EMAIL_ALLOWLIST is a safety catch while testing: when set, anything addressed
 * outside the list is logged and dropped rather than sent, so a stray signup
 * cannot email a real stranger from a half-configured account.
 */

export interface SendResult {
  delivered: boolean;
  transport: string;
  detail?: string;
}

function allowed(to: string): boolean {
  if (env.EMAIL_ALLOWLIST.length === 0) return true;
  return env.EMAIL_ALLOWLIST.includes(to.toLowerCase());
}

function magicLinkUrl(token: string): string {
  // Deliberately a link to the app, not to a GET endpoint that consumes the
  // token. Corporate mail scanners follow links in messages; a GET that
  // verified the token would let a scanner burn it before the customer clicks.
  // The page reads the token from the fragment and POSTs it to /auth/verify.
  return `${env.APP_URL}/#token=${encodeURIComponent(token)}`;
}

function renderText(url: string): string {
  return [
    "Here's your TickVPN sign-in link.",
    "",
    url,
    "",
    `It works once and expires in ${env.LOGIN_TOKEN_TTL_MINUTES} minutes.`,
    "If you didn't ask to sign in, you can ignore this — nothing has changed.",
  ].join("\n");
}

function renderHtml(url: string): string {
  return `<!doctype html><html><body style="margin:0;padding:32px;background:#f4f6f5;font-family:-apple-system,Segoe UI,sans-serif;color:#131b19">
<div style="max-width:480px;margin:0 auto;background:#fff;border:1px solid #d5ddda;border-radius:6px;padding:32px">
<h1 style="margin:0 0 16px;font-size:20px">Sign in to TickVPN</h1>
<p style="margin:0 0 24px;line-height:1.6;color:#4d5b56">Tap the button below. It works once and expires in ${env.LOGIN_TOKEN_TTL_MINUTES} minutes.</p>
<p style="margin:0 0 24px"><a href="${url}" style="display:inline-block;background:#0f5468;color:#fff;text-decoration:none;padding:12px 22px;border-radius:4px;font-weight:600">Sign in</a></p>
<p style="margin:0;font-size:13px;line-height:1.6;color:#6b7975">If the button doesn't work, paste this into your browser:<br><span style="word-break:break-all">${url}</span></p>
<p style="margin:24px 0 0;font-size:13px;color:#6b7975">If you didn't ask to sign in, ignore this — nothing has changed.</p>
</div></body></html>`;
}

async function sendViaResend(to: string, url: string): Promise<SendResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: env.EMAIL_FROM,
        to: [to],
        subject: "Your TickVPN sign-in link",
        text: renderText(url),
        html: renderHtml(url),
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return { delivered: false, transport: "resend", detail: `HTTP ${res.status} ${body.slice(0, 200)}` };
    }
    const json: any = await res.json().catch(() => ({}));
    return { delivered: true, transport: "resend", detail: json.id };
  } catch (err: any) {
    return {
      delivered: false,
      transport: "resend",
      detail: err?.name === "AbortError" ? "timed out after 10s" : err?.message,
    };
  } finally {
    clearTimeout(timer);
  }
}

async function sendViaSmtp(to: string, url: string): Promise<SendResult> {
  // Imported lazily so the dependency is only needed if you actually use SMTP.
  const nodemailer = await import("nodemailer");
  const transport = nodemailer.createTransport({
    host: env.SMTP_HOST,
    port: env.SMTP_PORT,
    secure: env.SMTP_PORT === 465,
    auth: { user: env.SMTP_USER, pass: env.SMTP_PASSWORD },
  });
  try {
    const info = await transport.sendMail({
      from: env.EMAIL_FROM,
      to,
      subject: "Your TickVPN sign-in link",
      text: renderText(url),
      html: renderHtml(url),
    });
    return { delivered: true, transport: "smtp", detail: info.messageId };
  } catch (err: any) {
    return { delivered: false, transport: "smtp", detail: err?.message };
  } finally {
    transport.close();
  }
}

export async function sendMagicLink(to: string, token: string): Promise<SendResult> {
  const url = magicLinkUrl(token);

  if (!allowed(to)) {
    console.warn(`[email] ${to} is not in EMAIL_ALLOWLIST — not sending`);
    return { delivered: false, transport: "blocked", detail: "not in allowlist" };
  }

  switch (env.EMAIL_PROVIDER) {
    case "resend": {
      const result = await sendViaResend(to, url);
      if (!result.delivered) console.error(`[email] resend failed for ${to}: ${result.detail}`);
      return result;
    }
    case "smtp": {
      const result = await sendViaSmtp(to, url);
      if (!result.delivered) console.error(`[email] smtp failed for ${to}: ${result.detail}`);
      return result;
    }
    default:
      // Never in production: assertConfigValid refuses to start that way.
      console.log(`[email:console] sign-in link for ${to}\n            ${url}`);
      return { delivered: false, transport: "console" };
  }
}

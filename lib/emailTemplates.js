/**
 * Transactional HTML emails — table layout + inline CSS for broad client support.
 */

function escapeHtml(s) {
  if (s == null || s === "") return "";
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function brandName() {
  return "Qrixa.net";
}

// Brand colors (keep as simple hex/rgba strings for email client compatibility)
const SYSTEM_SAGE = "#e3dbbb";
const SYSTEM_SAGE_SOFT = "rgba(188, 217, 162, 0.3)";
const SYSTEM_PRIMARY = "#41431b";

const ACCENT = SYSTEM_PRIMARY;
const BG = SYSTEM_SAGE_SOFT;
const CARD = "#ffffff";
const TEXT = SYSTEM_PRIMARY;
const MUTED = SYSTEM_PRIMARY;
const BORDER = SYSTEM_SAGE;
const HEADER_GRADIENT = "linear-gradient(135deg," + SYSTEM_SAGE + "," + SYSTEM_PRIMARY + ")";

/**
 * @param {object} opts
 * @param {string} opts.preheader - Hidden preview line.
 * @param {string} opts.title - Main heading inside the card.
 * @param {string} opts.lead - Intro paragraph (trusted HTML allowed).
 * @param {string} [opts.ctaUrl]
 * @param {string} [opts.ctaLabel]
 * @param {string} opts.footerNote
 * @param {string} [opts.fallbackUrl]
 */
function layout({ preheader, title, lead, ctaUrl, ctaLabel, footerNote, fallbackUrl }) {
  const safePre = escapeHtml(preheader);
  const safeTitle = escapeHtml(title);
  const safeCtaUrl = ctaUrl ? escapeHtml(ctaUrl) : "";
  const safeFallbackUrl = escapeHtml(fallbackUrl || ctaUrl || "");

  const buttonRow =
    ctaUrl && ctaLabel
      ? `
          <tr>
            <td align="center" style="padding:0 32px 28px;">
              <table role="presentation" cellpadding="0" cellspacing="0" border="0">
                <tr>
                  <td align="center" bgcolor="${ACCENT}" style="border-radius:10px;">
                    <a
                      href="${safeCtaUrl}"
                      target="_blank"
                      rel="noopener noreferrer"
                      style="
                        display:inline-block;
                        padding:16px 34px;
                        font-family:system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;
                        font-size:16px;
                        font-weight:700;
                        color:#ffffff;
                        text-decoration:none;
                        border-radius:10px;
                        background-color:${ACCENT};
                      "
                    >
                      ${escapeHtml(ctaLabel)}
                    </a>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
        `
      : "";

  const fallback =
    fallbackUrl || ctaUrl
      ? `
          <tr>
            <td style="padding:0 32px 24px;font-family:system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;font-size:13px;color:${MUTED};line-height:1.7;">
              If the button doesn’t work, copy and paste this link into your browser:<br/>
              <a href="${safeFallbackUrl}" style="color:${ACCENT};word-break:break-all;text-decoration:none;">${safeFallbackUrl}</a>
            </td>
          </tr>
        `
      : "";

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta http-equiv="x-ua-compatible" content="ie=edge">
  <title>${safeTitle}</title>
  <!--[if mso]>
  <style type="text/css">
    table { border-collapse: collapse; }
    .btn a { padding: 16px 34px !important; }
  </style>
  <![endif]-->
</head>
<body style="margin:0;padding:0;background-color:${BG};">
  <span style="display:none !important;visibility:hidden;opacity:0;color:transparent;height:0;width:0;overflow:hidden;mso-hide:all;">
    ${safePre}
  </span>

  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:${BG};padding:40px 16px;">
    <tr>
      <td align="center">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;background-color:${CARD};border-radius:16px;border:1px solid ${BORDER};overflow:hidden;">
          
          <tr>
            <td align="center" style="padding:32px 24px;background:${HEADER_GRADIENT};font-family:system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#ffffff;">
              <div style="font-size:24px;font-weight:800;letter-spacing:0.3px;">Qrixa</div>
              <div style="margin-top:6px;font-size:13px;line-height:1.5;opacity:0.92;">Smart business platform</div>
            </td>
          </tr>

          <tr>
            <td style="padding:32px 32px 10px;font-family:system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;">
              <p style="margin:0 0 8px;font-size:13px;font-weight:700;letter-spacing:0.08em;color:${ACCENT};text-transform:uppercase;">
                ${brandName()}
              </p>
              <h1 style="margin:0 0 18px;font-size:26px;font-weight:800;line-height:1.3;color:${TEXT};">
                ${safeTitle}
              </h1>
              <p style="margin:0 0 22px;font-size:16px;line-height:1.8;color:${TEXT};">
                ${lead}
              </p>
            </td>
          </tr>

          ${buttonRow}

          ${fallback}

          <tr>
            <td style="padding:0 32px 28px;font-family:system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;font-size:13px;line-height:1.7;color:${MUTED};border-top:1px solid ${BORDER};">
              <p style="margin:20px 0 0;">${footerNote}</p>
              <p style="margin:16px 0 0;">
                This email was sent by <strong>${brandName()}</strong>. If you did not request this, you can safely ignore this message.
              </p>
            </td>
          </tr>
        </table>

        <p style="margin:24px 0 0;font-family:system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;font-size:12px;color:${MUTED};max-width:600px;">
          © ${new Date().getFullYear()} ${brandName()} — All rights reserved
        </p>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

/**
 * @param {{ verifyUrl: string, recipientName?: string | null }} opts
 */
export function buildVerificationEmail({ verifyUrl, recipientName }) {
  const first = recipientName ? String(recipientName).trim().split(/\s+/)[0] : "";
  const greetingHtml = first ? `Hi ${escapeHtml(first)},` : "Hi there,";
  const greetingText = first ? `Hi ${first},` : "Hi there,";

  const subject = `Activate your Qrixa account 🚀`;

  const html = layout({
    preheader: "Confirm your email address to activate your Qrixa account.",
    title: "Welcome to Qrixa 🎉",
    lead: `${greetingHtml}<br/><br/>We’re excited to have you on Qrixa. To activate your account and start using your dashboard, please confirm that this email address belongs to you.`,
    ctaUrl: verifyUrl,
    ctaLabel: "Verify email address",
    fallbackUrl: verifyUrl,
    footerNote:
      "This secure verification link expires in <strong>48 hours</strong>. For your security, please do not share it with anyone.",
  });

  const text = `${greetingText}

Welcome to Qrixa.

To activate your account, please verify your email by opening the link below:
${verifyUrl}

This link expires in 48 hours.

If you did not create an account, you can safely ignore this message.`;

  return { subject, html, text };
}

/**
 * @param {{ resetUrl: string, recipientName?: string | null }} opts
 */
export function buildPasswordResetEmail({ resetUrl, recipientName }) {
  const first = recipientName ? String(recipientName).trim().split(/\s+/)[0] : "";
  const greetingHtml = first ? `Hi ${escapeHtml(first)},` : "Hi there,";
  const greetingText = first ? `Hi ${first},` : "Hi there,";

  const subject = `Reset your Qrixa password`;

  const html = layout({
    preheader: "Reset your Qrixa password using the secure link below.",
    title: "Reset your password",
    lead: `${greetingHtml}<br/><br/>We received a request to reset the password for your Qrixa account. Click the button below to choose a new password. If you didn’t request this, you can ignore this email and your password will remain unchanged.`,
    ctaUrl: resetUrl,
    ctaLabel: "Reset password",
    fallbackUrl: resetUrl,
    footerNote:
      "This secure reset link expires in <strong>1 hour</strong> and can only be used once.",
  });

  const text = `${greetingText}

We received a request to reset your Qrixa password.

Use the link below to choose a new password:
${resetUrl}

This link expires in 1 hour and can only be used once.

If you did not request this, you can safely ignore this message.`;

  return { subject, html, text };
}
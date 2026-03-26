import nodemailer from "nodemailer";

let transporter = null;

function getTransporter() {
  if (transporter) return transporter;
  const host = process.env.SMTP_HOST;
  const port = Number(process.env.SMTP_PORT || "587");
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  if (!host || !user || !pass) return null;
  transporter = nodemailer.createTransport({
    host,
    port,
    secure: port === 465,
    auth: { user, pass },
  });
  return transporter;
}

/**
 * Sends email when SMTP is configured; otherwise logs (dev-friendly).
 */
export async function sendMail({ to, subject, html, text }) {
  const from = process.env.SMTP_FROM || process.env.SMTP_USER;
  const t = getTransporter();
  if (!t || !from) {
    console.log(
      "[mail:skipped — set SMTP_HOST, SMTP_USER, SMTP_PASS, SMTP_FROM]",
      {
        to,
        subject,
        preview: (text || html || "").slice(0, 400),
      },
    );
    return;
  }
  await t.sendMail({ from, to, subject, html, text });
}

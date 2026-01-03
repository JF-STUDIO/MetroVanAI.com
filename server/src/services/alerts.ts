import nodemailer from 'nodemailer';

const smtpHost = process.env.SMTP_HOST || '';
const smtpPort = Number(process.env.SMTP_PORT || 465);
const smtpUser = process.env.SMTP_USER || '';
const smtpPass = process.env.SMTP_PASS || '';
const alertFrom = process.env.ALERT_FROM || '';
const alertTo = process.env.ALERT_TO || '';
const enabled = smtpHost && smtpPort && smtpUser && smtpPass && alertFrom && alertTo;

const transporter = enabled
  ? nodemailer.createTransport({
      host: smtpHost,
      port: smtpPort,
      secure: smtpPort === 465,
      auth: { user: smtpUser, pass: smtpPass }
    })
  : null;

export const sendAlert = async (subject: string, text: string, html?: string) => {
  if (!enabled || !transporter) {
    console.warn('Alert skipped: SMTP not configured');
    return;
  }
  try {
    await transporter.sendMail({
      from: alertFrom,
      to: alertTo,
      subject,
      text,
      html: html || `<pre>${text}</pre>`
    });
  } catch (error) {
    console.warn('Alert send failed', (error as Error).message);
  }
};

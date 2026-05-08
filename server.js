import express from "express";
import axios from "axios";
import FormData from "form-data";
import { google } from "googleapis";

const app = express();
app.use(express.json({ limit: "2mb" }));

const MAX_FILE_MB = Number(process.env.MAX_FILE_MB || 20);
const TIMEOUT_MS = Number(process.env.TIMEOUT_MS || 45000);
const GOTENBERG_URL = process.env.GOTENBERG_URL || "http://gotenberggotenberg8.railway.internal:3000";

function bytesToMB(b) {
  return Math.round((b / (1024 * 1024)) * 10) / 10;
}

function isPdfBuffer(buf) {
  return buf && buf.length >= 4 && buf[0] === 0x25 && buf[1] === 0x50 && buf[2] === 0x44 && buf[3] === 0x46;
}

function extractDriveFileId(url) {
  if (!url) return null;
  try {
    const u = new URL(url);
    const m = u.pathname.match(/\/file\/d\/([^/]+)/);
    if (m?.[1]) return m[1];
    const idQ = u.searchParams.get("id");
    if (idQ) return idQ;
    return null;
  } catch {
    return null;
  }
}

// --------- Drive API (서비스 계정 인증) ---------
let _driveClient = null;
function getDriveClient() {
  if (_driveClient) return _driveClient;
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!raw) throw new Error("Missing GOOGLE_SERVICE_ACCOUNT_JSON env variable");

  let credentials;
  try {
    credentials = JSON.parse(raw);
  } catch (e) {
    throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON is not valid JSON");
  }

  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ["https://www.googleapis.com/auth/drive.readonly"]
  });
  _driveClient = google.drive({ version: "v3", auth });
  return _driveClient;
}

async function downloadDrivePdf(fileId) {
  const drive = getDriveClient();

  const response = await drive.files.get(
    { fileId, alt: "media", supportsAllDrives: true },
    { responseType: "arraybuffer", timeout: TIMEOUT_MS }
  );

  const buf = Buffer.from(response.data);

  if (!isPdfBuffer(buf)) {
    throw new Error(`Drive file is not a PDF (size: ${bytesToMB(buf.length)}MB)`);
  }
  if (buf.length > MAX_FILE_MB * 1024 * 1024) {
    throw new Error(`PDF too large: ${bytesToMB(buf.length)}MB`);
  }
  return buf;
}

async function downloadDrivePdfWithRetry(fileId, maxRetries = 2) {
  let lastErr;
  for (let i = 0; i <= maxRetries; i++) {
    try {
      return await downloadDrivePdf(fileId);
    } catch (e) {
      lastErr = e;
      if (i < maxRetries) {
        await new Promise(r => setTimeout(r, 1000 * (i + 1))); // 1s, 2s 백오프
      }
    }
  }
  throw lastErr;
}

// --------- Gotenberg PDF 합치기 ---------
async function mergeWithGotenberg(buffers) {
  const form = new FormData();
  buffers.forEach((buf, idx) => {
    form.append("files", buf, { filename: `part-${idx + 1}.pdf`, contentType: "application/pdf" });
  });

  const resp = await axios.post(`${GOTENBERG_URL}/forms/pdfengines/merge`, form, {
    responseType: "arraybuffer",
    timeout: TIMEOUT_MS,
    headers: form.getHeaders(),
    validateStatus: (s) => s >= 200 && s < 300
  });

  return Buffer.from(resp.data);
}

// --------- Brevo 이메일 발송 ---------
async function sendBrevoEmail({ toEmail, subject, html, attachmentName, attachmentB64 }) {
  const apiKey = process.env.BREVO_API_KEY;
  if (!apiKey) throw new Error("Missing BREVO_API_KEY");

  const payload = {
    sender: {
      email: process.env.BREVO_SENDER_EMAIL,
      name: process.env.BREVO_SENDER_NAME || "Sender",
    },
    to: [{ email: toEmail }],
    subject,
    htmlContent: html,
    attachment: [{ name: attachmentName, content: attachmentB64 }],
  };

  try {
    const resp = await axios.post("https://api.brevo.com/v3/smtp/email", payload, {
      headers: { "api-key": apiKey, "content-type": "application/json" },
      timeout: TIMEOUT_MS,
      validateStatus: (s) => s >= 200 && s < 300,
    });
    return resp.data;
  } catch (err) {
    const status = err?.response?.status;
    const data = err?.response?.data;
    throw new Error(`Brevo error ${status}: ${typeof data === "string" ? data : JSON.stringify(data)}`);
  }
}

// --------- Routes ---------
app.get("/health", (_, res) => res.status(200).send("ok"));

app.post("/send", async (req, res) => {
  try {
    const { toEmail, emailSubject, emailHtml, driveLink1, driveLink2, mergedFileName } = req.body || {};
    if (!toEmail || !emailSubject || !emailHtml || !driveLink1 || !driveLink2) {
      return res.status(400).json({ ok: false, message: "Missing required fields" });
    }

    const id1 = extractDriveFileId(driveLink1);
    const id2 = extractDriveFileId(driveLink2);
    if (!id1 || !id2) {
      return res.status(400).json({ ok: false, message: "Could not extract Drive fileId", detail: { id1, id2 } });
    }

    const [pdf1, pdf2] = await Promise.all([
      downloadDrivePdfWithRetry(id1),
      downloadDrivePdfWithRetry(id2)
    ]);
    const merged = await mergeWithGotenberg([pdf1, pdf2]);

    const b64 = merged.toString("base64");
    const name = mergedFileName || `merged-${Date.now()}.pdf`;

    const brevoResp = await sendBrevoEmail({
      toEmail,
      subject: emailSubject,
      html: emailHtml,
      attachmentName: name,
      attachmentB64: b64
    });

    return res.status(200).json({ ok: true, mergedSizeMB: bytesToMB(merged.length), brevo: brevoResp });
  } catch (e) {
    return res.status(500).json({ ok: false, message: "Send failed", error: String(e?.message || e) });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`send-bridge listening on ${port}`));

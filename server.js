import express from "express";
import axios from "axios";
import FormData from "form-data";

const app = express();
app.use(express.json({ limit: "2mb" }));

const MAX_FILE_MB = Number(process.env.MAX_FILE_MB || 20);
const TIMEOUT_MS = Number(process.env.TIMEOUT_MS || 45000);
// Railway private networking DNS 권장: SERVICE_NAME.railway.internal
const GOTENBERG_URL = process.env.GOTENBERG_URL || "http://gotenberg.railway.internal:3000";

function bytesToMB(b) {
  return Math.round((b / (1024 * 1024)) * 10) / 10;
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

function buildDriveDownloadUrl(fileId) {
  return `https://drive.google.com/uc?export=download&id=${encodeURIComponent(fileId)}`;
}

// 큰 파일 confirm 처리 포함
async function downloadDrivePdf(fileId) {
  const url = buildDriveDownloadUrl(fileId);

  const first = await axios.get(url, {
    responseType: "arraybuffer",
    timeout: TIMEOUT_MS,
    maxRedirects: 5,
    validateStatus: (s) => s >= 200 && s < 400,
    headers: { "User-Agent": "Mozilla/5.0" }
  });

  const ct = (first.headers["content-type"] || "").toLowerCase();
  const setCookie = first.headers["set-cookie"] || [];
  const cookieHeader = Array.isArray(setCookie)
    ? setCookie.map(c => c.split(";")[0]).join("; ")
    : "";

  if (ct.includes("application/pdf")) {
    const buf = Buffer.from(first.data);
    if (buf.length > MAX_FILE_MB * 1024 * 1024) throw new Error(`PDF too large: ${bytesToMB(buf.length)}MB`);
    return buf;
  }

  // confirm 토큰 파싱
  const html = Buffer.from(first.data).toString("utf-8");
  const confirmMatch = html.match(/confirm=([0-9A-Za-z_]+)&/);
  if (!confirmMatch?.[1]) {
    throw new Error(`Not PDF and confirm token not found (content-type: ${ct || "unknown"})`);
  }

  const secondUrl = `${url}&confirm=${encodeURIComponent(confirmMatch[1])}`;

  const second = await axios.get(secondUrl, {
    responseType: "arraybuffer",
    timeout: TIMEOUT_MS,
    maxRedirects: 5,
    validateStatus: (s) => s >= 200 && s < 400,
    headers: {
      "User-Agent": "Mozilla/5.0",
      ...(cookieHeader ? { Cookie: cookieHeader } : {})
    }
  });

  const ct2 = (second.headers["content-type"] || "").toLowerCase();
  if (!ct2.includes("application/pdf")) throw new Error(`Confirm download still not PDF (content-type: ${ct2 || "unknown"})`);

  const buf2 = Buffer.from(second.data);
  if (buf2.length > MAX_FILE_MB * 1024 * 1024) throw new Error(`PDF too large: ${bytesToMB(buf2.length)}MB`);
  return buf2;
}

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

async function sendBrevoEmail({ toEmail, subject, html, attachmentName, attachmentB64 }) {
  const apiKey = process.env.BREVO_API_KEY;
  if (!apiKey) throw new Error("Missing BREVO_API_KEY");

  const payload = {
    sender: {
      email: process.env.BREVO_SENDER_EMAIL,
      name: process.env.BREVO_SENDER_NAME || "Sender"
    },
    to: [{ email: toEmail }],
    subject,
    htmlContent: html,
    attachment: [{ name: attachmentName, content: attachmentB64 }]
  };

  const resp = await axios.post("https://api.brevo.com/v3/smtp/email", payload, {
    headers: { "api-key": apiKey, "content-type": "application/json" },
    timeout: TIMEOUT_MS,
    validateStatus: (s) => s >= 200 && s < 300
  });

  return resp.data;
}

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

    const [pdf1, pdf2] = await Promise.all([downloadDrivePdf(id1), downloadDrivePdf(id2)]);
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

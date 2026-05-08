import express from "express";
import axios from "axios";
import FormData from "form-data";

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

const DRIVE_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
  "Accept-Language": "ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7",
  "Sec-Ch-Ua": '"Not_A Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"',
  "Sec-Ch-Ua-Mobile": "?0",
  "Sec-Ch-Ua-Platform": '"Windows"',
  "Sec-Fetch-Dest": "document",
  "Sec-Fetch-Mode": "navigate",
  "Sec-Fetch-Site": "none",
  "Sec-Fetch-User": "?1",
  "Upgrade-Insecure-Requests": "1",
  "Referer": "https://drive.google.com/"
};

async function downloadDrivePdf(fileId) {
  // 새 endpoint + confirm=t (100MB+ 경고도 우회)
  const primaryUrl = `https://drive.usercontent.google.com/download?id=${encodeURIComponent(fileId)}&export=download&confirm=t`;

  const first = await axios.get(primaryUrl, {
    responseType: "arraybuffer",
    timeout: TIMEOUT_MS,
    maxRedirects: 5,
    validateStatus: (s) => s >= 200 && s < 400,
    headers: DRIVE_HEADERS
  });

  const ct = (first.headers["content-type"] || "").toLowerCase();
  const setCookie = first.headers["set-cookie"] || [];
  const cookieHeader = Array.isArray(setCookie)
    ? setCookie.map(c => c.split(";")[0]).join("; ")
    : "";

  const firstBuf = Buffer.from(first.data);

  // PDF면 바로 반환
  if (ct.includes("application/pdf") || isPdfBuffer(firstBuf)) {
    if (firstBuf.length > MAX_FILE_MB * 1024 * 1024) {
      throw new Error(`PDF too large: ${bytesToMB(firstBuf.length)}MB`);
    }
    return firstBuf;
  }

  // HTML이면 form에서 confirm + uuid 추출
  const text = firstBuf.toString("utf-8");

  const confirm =
    text.match(/name="confirm"\s+value="([^"]+)"/)?.[1] ||
    text.match(/confirm=([0-9A-Za-z_-]+)/)?.[1];

  const uuid = text.match(/name="uuid"\s+value="([^"]+)"/)?.[1];

  if (!confirm) {
    const preview = text.slice(0, 400).replace(/\s+/g, " ");
    throw new Error(`Drive returned HTML, no confirm token (ct: ${ct}) | preview: ${preview}`);
  }

  const params = new URLSearchParams({ id: fileId, export: "download", confirm });
  if (uuid) params.set("uuid", uuid);

  const secondUrl = `https://drive.usercontent.google.com/download?${params.toString()}`;

  const second = await axios.get(secondUrl, {
    responseType: "arraybuffer",
    timeout: TIMEOUT_MS,
    maxRedirects: 5,
    validateStatus: (s) => s >= 200 && s < 400,
    headers: {
      ...DRIVE_HEADERS,
      ...(cookieHeader ? { Cookie: cookieHeader } : {})
    }
  });

  const ct2 = (second.headers["content-type"] || "").toLowerCase();
  const buf2 = Buffer.from(second.data);

  if (!(ct2.includes("application/pdf") || isPdfBuffer(buf2))) {
    const preview = buf2.toString("utf-8").slice(0, 400).replace(/\s+/g, " ");
    throw new Error(`Drive download still not PDF (content-type: ${ct2 || "unknown"}) | preview: ${preview}`);
  }

  if (buf2.length > MAX_FILE_MB * 1024 * 1024) {
    throw new Error(`PDF too large: ${bytesToMB(buf2.length)}MB`);
  }
  return buf2;
}

// 간헐적 실패 대응: 최대 2회 자동 재시도
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

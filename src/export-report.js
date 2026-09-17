// export-report.js — generate branded PDF/HTML reports for customers
import { spawn } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, mkdirSync, writeFileSync, unlinkSync } from "node:fs";
import { renderCustomerReport } from "./report-standalone.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── PDF export via headless Chrome ──────────────────────────────────────────

function chromePath() {
  const paths = [
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium-browser",
    "/usr/bin/chromium",
  ];
  for (const p of paths) {
    try {
      existsSync(p);
      return p;
    } catch {
      /* not found */
    }
  }
  return null;
}

async function pdfFromHtml(html, outPath) {
  const chrome = chromePath();
  if (!chrome) throw new Error("No headless Chrome found — cannot generate PDF. Install google-chrome or chromium.");
  const tmpHtml = resolve(__dirname, "tmp", "report.html");
  if (!existsSync(resolve(__dirname, "tmp"))) mkdirSync(resolve(__dirname, "tmp"), { recursive: true });
  writeFileSync(tmpHtml, html, "utf8");

  return new Promise((resolve, reject) => {
    const proc = spawn(chrome, [
      "--headless",
      "--disable-gpu",
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--disable-software-rasterizer",
      "--print-to-pdf=" + outPath,
      "--print-to-pdf-no-header",
      tmpHtml,
    ], { stdio: ["ignore", "pipe", "pipe"] });

    let err = "";
    proc.stderr.on("data", (c) => (err += c));
    proc.on("close", (code) => {
      try { unlinkSync(tmpHtml); } catch {}
      if (code === 0) resolve(outPath);
      else reject(new Error(`Chrome exited ${code}: ${err.slice(0, 300)}`));
    });
    proc.on("error", (e) => {
      try { unlinkSync(tmpHtml); } catch {}
      reject(e);
    });
  });
}

export async function generatePdf(audit, outPath, opts = {}) {
  const html = renderCustomerReport(audit, opts);
  const pdfPath = outPath || resolve(__dirname, "tmp", "report.pdf");
  await pdfFromHtml(html, pdfPath);
  return pdfPath;
}

// server.js — lightweight web UI for the Website Audit Tool + Universal Audit Agent
import express from "express";
import { createServer } from "node:http";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { renderCustomerReport } from "./src/report-standalone.js";
import { generatePdf } from "./src/export-report.js";
import { runUniversalAudit } from "./src/universal-audit-agent.js";
import { auditUrl } from "./src/audit.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPORT_DIR = join(__dirname, "public", "reports");
mkdirSync(REPORT_DIR, { recursive: true });

const app = express();
app.use(express.json({ limit: "5mb" }));
app.use(express.urlencoded({ extended: true }));

// --- HTML routes FIRST (with no-cache headers so browsers never cache stale client code) ---

// Homepage — render the audit tool UI
app.get("/", (_req, res) => {
  res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
  res.send(readFileSync(join(__dirname, "public", "index.html"), "utf8"));
});

// Universal Audit Agent — render server-side from URL
app.get("/universal-report", async (req, res) => {
  const { url, dataPath } = req.query;
  if (url) {
    try {
      const r = await runUniversalAudit(url, {
        timeoutMs: 25000,
        json: true,
        authorizedScope: "Public, passive inspection only — no login, no form submission, no interactive content testing.",
      });
      res.setHeader("Content-Type", "text/markdown; charset=utf-8");
      res.send(r.markdown ?? "");
      return;
    } catch (err) {
      res.status(500).send("Error generating report: " + err.message);
      return;
    }
  }
  // Serve the interactive page (loads artifact from dataPath if present)
  res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(readFileSync(join(__dirname, "public", "universal-report.html"), "utf8"));
});

// Universal Audit Agent — run audit and return JSON + save artifact
app.post("/universal-report/run", async (req, res) => {
  const { url, timeoutMs } = req.body ?? {};
  if (!url || typeof url !== "string") {
    res.status(400).json({ error: "url is required" });
    return;
  }
  try {
    const r = await runUniversalAudit(url, {
      timeoutMs: Number(timeoutMs) || 25000,
      json: true,
      authorizedScope: "Public, passive inspection only — no login, no form submission, no interactive content testing.",
    });
    // Always write a JSON artifact so the interactive page can reload by dataPath.
    // Merge markdown from r.markdown into the artifact (r.json has sections/score/etc
    // but not the markdown string).
    const artifact = r.json
      ? { ...r.json, markdown: r.markdown || "" }
      : { markdown: r.markdown || "", sections: r.sections, status: r.status };
    const fname = `ua-${Date.now()}.json`;
    const fpath = join(REPORT_DIR, fname);
    writeFileSync(fpath, JSON.stringify(artifact, null, 2), "utf8");
    res.json({ ok: true, markdown: r.markdown, dataPath: "/reports/" + fname });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Serve the full audit report page (in-app view)
// Renders server-side when URL params are present; serves blank template otherwise
app.get("/report", async (req, res) => {
  const { url, score, issues, passed, passedIds, stats, date, clientName, examiner, certValid, sslExpired } = req.query;
  if (url) {
    const audit = {
      score: parseInt(score ?? "0", 10),
      url,
      reachable: true,
      issues: JSON.parse(issues ?? "[]"),
      passed: { count: parseInt(passed ?? "0", 10), total: 21, ids: (passedIds ?? "").split(",").filter(Boolean) },
      stats: JSON.parse(stats ?? '{"responseMs":0,"htmlKB":0,"wordCount":0,"httpStatus":0}'),
      notes: [],
      certValid: certValid === "true" ? true : certValid === "false" ? false : undefined,
      sslExpired: sslExpired === "true",
    };
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(renderCustomerReport(audit, { date, clientName, examiner }));
    return;
  }
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(readFileSync(join(__dirname, "public", "report.html"), "utf8"));
});

// Export standalone HTML report (for viewing in a new tab)
app.get("/api/report/html", async (req, res) => {
  const { url, score, issues, passed, passedIds, stats, date, clientName, examiner, certValid, sslExpired } = req.query;
  if (!url) { res.status(400).send("url required"); return; }
  const audit = {
    score: parseInt(score ?? "0", 10),
    url,
    reachable: true,
    issues: JSON.parse(issues ?? "[]"),
    passed: { count: parseInt(passed ?? "0", 10), total: 21, ids: (passedIds ?? "").split(",").filter(Boolean) },
    stats: JSON.parse(stats ?? '{"responseMs":0,"htmlKB":0,"wordCount":0,"httpStatus":0}'),
    notes: [],
    certValid: certValid === "true" ? true : certValid === "false" ? false : undefined,
    sslExpired: sslExpired === "true",
  };
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Content-Disposition", `inline; filename="audit-report-${date || "latest"}.html"`);
  res.send(renderCustomerReport(audit, { date, clientName, examiner }));
});

// Export PDF report (generates on server via headless Chrome)
app.get("/api/report/pdf", async (req, res) => {
  const { url, score, issues, passed, passedIds, stats, date, clientName, examiner, certValid, sslExpired } = req.query;
  if (!url) { res.status(400).send("url required"); return; }
  const audit = {
    score: parseInt(score ?? "0", 10),
    url,
    reachable: true,
    issues: JSON.parse(issues ?? "[]"),
    passed: { count: parseInt(passed ?? "0", 10), total: 21, ids: (passedIds ?? "").split(",").filter(Boolean) },
    stats: JSON.parse(stats ?? '{"responseMs":0,"htmlKB":0,"wordCount":0,"httpStatus":0}'),
    notes: [],
    certValid: certValid === "true" ? true : certValid === "false" ? false : undefined,
    sslExpired: sslExpired === "true",
  };
  try {
    const pdfPath = await generatePdf(audit, undefined, { date, clientName, examiner });
    res.download(pdfPath, `audit-report-${date || "latest"}.pdf`);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Static assets LAST (so HTML routes with no-cache headers always win) ---

// Serve static assets (JS, CSS, images) from public/
app.use(express.static(join(__dirname, "public")));

// Serve saved report JSON artifacts (for the interactive page to load)
app.use("/reports", express.static(join(__dirname, "public", "reports")));

// Run a standard audit and return JSON (used by the UI "Audit Site" button)
app.post("/api/audit", async (req, res) => {
  const { url, timeoutMs } = req.body ?? {};
  if (!url || typeof url !== "string") {
    res.status(400).json({ error: "url is required" });
    return;
  }
  try {
    const a = await auditUrl(url, { timeoutMs: Number(timeoutMs) || 20000 });
    res.json(a);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = Number(process.env.PORT) || 3000;
const server = createServer(app);

server.listen(PORT, () => {
  console.log(`\nWebsite Audit Tool UI → http://localhost:${PORT}`);
  console.log("Press Ctrl+C to stop\n");
});

// renderCustomerHTML — standalone HTML report renderer (dark theme, no CHECKS import needed).
// Used by server.js /api/report/html, /report, and PDF generation.
//
// Exports:
//   renderCustomerHTML(audit, opts?) → { html: string, clientName: string, score: number,
//     scoreBand: string, color: string, issues: Issue[], passed: {count,total,ids},
//     stats: object, certValid: boolean|undefined, sslExpired: boolean, date: string,
//     examiner: string, passedIds: string }
//
// opts: { date?, clientName?, examiner?, certValid?, sslExpired? }
import { statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import * as cheerio from "cheerio";

const __dirname = dirname(fileURLToPath(import.meta.url));

function scoreColor(s) {
  if (s >= 80) return "#16a34a";
  if (s >= 60) return "#ca8a04";
  if (s >= 40) return "#ea580c";
  return "#dc2626";
}

function scoreBand(s) {
  if (s >= 80) return "Excellent";
  if (s >= 60) return "Fair";
  if (s >= 40) return "Needs Work";
  return "Poor";
}

function esc(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function splitDomainName(raw) {
  if (!raw) return "";
  let s = raw.replace(/^https?:\/\//, "").replace(/\/.*/, "").replace(/\.[^.]+$/, "");
  s = s.toUpperCase();
  const tokens = [];
  let i = 0;
  const chars = s.split("");
  const len = chars.length;
  while (i < len) {
    let found = null;
    const maxLen = Math.min(len - i, 22);
    for (let l = maxLen; l >= 1; l--) {
      const cand = chars.slice(i, i + l).join("");
      if (WORD_LIST.has(cand)) { found = cand; break; }
    }
    if (found) { tokens.push(found); i += found.length; }
    else {
      let j = i;
      let chunk = "";
      while (j < len) {
        chunk += chars[j];
        if (WORD_LIST.has(chunk) || j - i >= 8) break;
        j++;
      }
      if (chunk.length > 0) { tokens.push(chunk); i += chunk.length; }
      else { tokens.push(chars[i]); i++; }
    }
  }
  let result = tokens.join(" ").replace(/\s+/g, " ").trim();
  result = result.replace(/\b\w/g, (c) => c.toUpperCase());
  return result;
}

const WORD_LIST = new Set([
  "AR","MAINTENANCE","MAINTANCE","MAINT","MAINTAN","SOLUTIONS","SOLUTION","SERVICES","SERVICE",
  "GROUP","INC","LLC","COMPANY","CONTRACTING","CONSTRUCTION","PROPERTIES","PROPERTY",
  "MANAGEMENT","LANDSCAPING","LANDSCAPE","LAWN","REPAIR","INSTALLATION","INSTALL",
  "TREE","TREES","IRRIGATION","ENGINEERING","TECHNOLOGY","TECHNOLOGIES","SECURITY",
  "ROOFING","PLUMBING","HVAC","ELECTRICAL","ELECTRIC","PAINTING","GUTTERS","SIDING",
  "FLOORING","REMODEL","REMODELING","DESIGN","BUILD","BUILDER","BUILDERS","SOLAR",
  "EXTERIOR","INTERIOR","CLEANING","PRESSURE","WINDOW","DOORS","GARAGE","FENCE",
  "DRIVEWAY","PATIO","PAVERS","POOL","MIAMI","BROWARD","PALM","BEACH","FORT",
  "LAUDERDALE","LAKES","CORAL","SPRINGS","WESTON","MIRAMAR","HOLLYWOOD",
  "DAVIE","PLANTATION","SUNRISE","BOCA","RATON","DELRAY","BOYNTON","SOUTH","FLORIDA",
  "FL","COUNTY","COUNTIES","AREA","AREAS","SERVING","AC","HEATING",
  "AIR","CONDITIONING","CONDITIONER","COOLING","ROOF","SIDING","GUTTER","PAINT",
  "PEST","CONTROL","TERMITE","TERMITES","TREE","TRIMMING","REMOVAL","REMOVE",
  "STUMP","GRINDING","FERTILIZATION","FERTILIZER","SOD","WEED","GRAVEL",
  "HARDSCAPE","SOFTSCAPE","SPRINKLER","DRAINAGE","RETAINING","WALL","PATIO","PATIOS",
  "CONCRETE","ASPHALT","SEALCOAT","SEALING","PAVING","PAVER","BRICK","STONE","FLAGSTONE",
  "FLAGSTONES","MARBLE","GRANITE","SLATE","LIMESTONE","SAND","GRAVEL","MULCH","TOPSOIL",
  "COMPOST","MOWING","MOWER","MOWED","EDGING","PRUNING","PRUNE","NEEDLE","PINE",
  "OAK","MAPLE","PALMS","PALM","TROPICAL","EXOTIC","SHRUB","SHRUBS","BUSH","BUSHES",
  "PLANT","PLANTS","FLOWER","FLOWERS","BED","BEDS","MULCH","BARK","ROCK","ROCKS",
  "DECORATIVE","SYSTEMS","SYSTEM","ZONE","ZONES","VALVE",
  "HEAD","HEADS","SPRAY","SPRAYS","DRIP","MICRO","WATER","WATERS","FLOW","FLOWS",
  "PRESSURE","PSI","GPM","FORECAST","WEATHER","RAIN","STORM","CLEANUP","TRUNK","TREES",
  "SAW","CHAINSAW","BOBCAT","SKID","STEER","EXCAVATOR","LOADER","TRUCK","TRUCKS",
  "VAN","VANS","EQUIPMENT","EQUIP","TOOLS","TOOL","SAFETY","CERTIFIED","CERTIFICATION",
  "LICENSE","LICENSED","LICENSES","CONTRACTOR","BONDED","INSURANCE","INSURED",
  "GENERAL","LIABILITY","WORKERS","COMP","COMPENSATION","PHYSICAL","ADDRESS","PHONE",
  "EMAIL","WEB","SITE","WEBSITE","ONLINE","MOBILE","RESPONSIVE","SEO","RANKING",
  "GOOGLE","FACEBOOK","YELP","RATING","REVIEWS","TESTIMONIAL",
  "TESTIMONIALS","FEEDBACK","FEEDBACKS","CUSTOMER","CUSTOMERS","CLIENT","CLIENTS",
  "SATISFACTION","SATISFIED","HAPPY","LOVED","TRUST","TRUSTED","EXPERT","EXPERTS",
  "PRO","PROS","PROFESSIONAL","PROFESSIONALS","QUALITY","RELIABLE","FAST","SAME-DAY",
  "EMERGENCY","24-HOUR","24/7","AVAILABLE","AFTER-HOURS","NIGHT","WEEKEND","WEEKENDS",
  "HOLIDAY","HOLIDAYS","SEASON","SEASONAL","SPECIAL","OFFER","OFFERING","OFFERINGS",
  "PACKAGE","PACKAGES","SERVICE","SERVICES","PLANS","PLAN","OPTIONS","OPTION","CHOICES",
  "CHOICE","PRICING","PRICE","COSTS","COST","DEALS","DISCOUNT","SAVE","SAVINGS",
  "BUDGET","AFFORDABLE","COMPETITIVE","COMPETITIVENESS","COMPETITOR","COMPETITORS",
  "RESEARCH","COMPARISON","COMPOUND","MIXED","BLEND","BLENDING","AGE","AGED","AGING",
].map((w) => w.toUpperCase()));

function severityClass(text) {
  const t = (text || "").toLowerCase();
  if (/cannot|unreachable|fail|error|blocked|expir|missing|no http|no https|no <|no <h1>|no click|no review|not mobile|not found|no credential|no testimonial|no blog|no service area|no phone|no address|only 1|thin content|low content|too short|too long|no analytics|no structured|no open graph|no canonical/i.test(t)) return "severity-high";
  if (/could|weak|limited|fewer|outdated|stale|generic|couldn't|not leveraged|underutil|only 2|only 4|4\/6/i.test(t)) return "severity-med";
  return "severity-low";
}

/**
 * Render an HTML report from an audit result object + optional overrides.
 */
export function renderCustomerHTML(audit, opts = {}) {
  const {
    date = new Date().toISOString().slice(0, 10),
    clientName: clientNameOverride,
    examiner = "Website Audit Tool",
    certValid: certValidOverride,
    sslExpired: sslExpiredOverride,
  } = opts;

  const score = audit.score != null ? audit.score : 0;
  const color = scoreColor(score);
  const band = scoreBand(score);
  const url = audit.url ?? "";
  const issues = audit.issues || [];
  const passed = audit.passed || { count: 0, total: 21, ids: [] };
  const totalChecks = passed.total || 21;
  const passedCount = passed.count != null ? passed.count : 0;
  const stats = audit.stats || { responseMs: 0, htmlKB: 0, wordCount: 0, httpStatus: 0 };
  const certValid = certValidOverride != null ? certValidOverride : (audit.certValid != null ? audit.certValid : undefined);
  const sslExpired = sslExpiredOverride != null ? sslExpiredOverride : (audit.sslExpired === true);
  const notes = audit.notes || [];

  const clientName = clientNameOverride || splitDomainName(url);

  // Passed IDs list
  const passedIds = (passed.ids && passed.ids.length) ? passed.ids.join(",") : "";

  // cert warning block
  const certWarning = sslExpired
    ? `<div class="cert-warn"><b>⚠ SSL certificate expired or invalid.</b> This site's security certificate has expired or is invalid. Browsers will show a "Not Secure" warning to visitors, and HTTPS is broken until the certificate is renewed. Renew the certificate (Let's Encrypt is free) as soon as possible.</div>`
    : "";

  // issues table
  const issueRows = issues.length === 0
    ? `<div class="note-item clean">No issues found — this site is in great shape.</div>`
    : issues.map((i) => {
        const cls = severityClass(i.repair || i.fix || "");
        const fixCell = i.fix ? `<code>${esc(i.fix)}</code>` : "";
        return `<tr class="${cls}">
          <td class="col-label">${esc(i.label)}</td>
          <td class="issue-text">${esc(i.issue)}</td>
          <td class="issue-fix">${fixCell}</td>
        </tr>`;
      }).join("");

  const issuesSection = issues.length === 0
    ? `<div class="card soft"><h3>Audit Results</h3>${issueRows}</div>`
    : `<div class="card"><h3>Issues Found & Recommended Fixes</h3>
        <div class="table-wrap"><table>
          <thead><tr><th class="col-label">Check</th><th class="issue-text">Issue</th><th class="issue-fix">Recommended fix</th></tr></thead>
          <tbody>${issueRows}</tbody>
        </table></div></div>`;

  // passed checks
  const passedLabels = (passed.ids && passed.ids.length)
    ? passed.ids.map((id) => `<li>${esc(id)}</li>`).join("")
    : `<li>No checks passed yet</li>`;
  const passedSection = `<div class="card"><h3>Checks That Passed (${passedCount}/${totalChecks})</h3>
    <ul class="passed-list${passed.ids && passed.ids.length ? "" : " single-col"}">${passedLabels}</ul></div>`;

  // notes
  const notesSection = notes.length
    ? `<div class="card"><h3>Notes</h3>` + notes.map((n) => `<p class="note">• ${esc(n)}</p>`).join("") + `</div>`
    : "";

  return {
    html: `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Website Audit Report — ${esc(clientName)}</title>
<style>
  :root { --bg:#0f172a; --card:#1e293b; --fg:#f8fafc; --muted:#94a3b8; --border:#334155; --accent:#38bdf8; }
  * { box-sizing:border-box; margin:0; padding:0; }
  body { background:var(--bg); color:var(--fg); font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif; line-height:1.55; min-height:100vh; }
  .wrap { max-width:980px; margin:0 auto; padding:24px; }
  .topbar { display:flex; align-items:center; gap:14px; margin-bottom:16px; }
  .back-btn { background:transparent; color:var(--muted); border:1px solid var(--border); border-radius:8px; padding:6px 14px; font-size:0.8rem; cursor:pointer; text-decoration:none; font-family:inherit; transition:color 0.15s, border-color 0.15s; }
  .back-btn:hover { color:var(--fg); border-color:var(--accent); }
  .topbar-title { font-size:0.72rem; color:var(--muted); text-transform:uppercase; letter-spacing:0.07em; font-weight:600; }
  .topbar-badge { color:var(--accent); font-weight:600; font-size:0.72rem; text-transform:uppercase; letter-spacing:0.07em; }
  .print-bar { display:flex; gap:10px; justify-content:flex-end; margin-bottom:16px; }
  .print-btn { background:transparent; color:var(--muted); border:1px solid var(--border); padding:6px 14px; border-radius:6px; font-size:0.78rem; cursor:pointer; font-family:inherit; transition:color 0.15s, border-color 0.15s; }
  .print-btn:hover { color:var(--fg); border-color:var(--accent); }
  .cover { background:linear-gradient(135deg,#0f172a 0%,#1e293b 100%); border:1px solid var(--border); border-radius:14px; padding:32px 36px; margin-bottom:24px; position:relative; overflow:hidden; }
  .cover::before { content:""; position:absolute; top:-60px; right:-60px; width:200px; height:200px; background:radial-gradient(circle,rgba(56,189,248,0.08) 0%,transparent 70%); border-radius:50%; }
  .cover-badge { display:inline-block; background:rgba(56,189,248,0.1); color:var(--accent); border:1px solid rgba(56,189,248,0.2); padding:4px 14px; border-radius:999px; font-size:0.7rem; font-weight:700; text-transform:uppercase; letter-spacing:0.08em; margin-bottom:16px; }
  .cover h1 { font-size:1.9rem; font-weight:800; line-height:1.2; margin-bottom:4px; }
  .cover-sub { color:var(--muted); font-size:0.88rem; margin-bottom:18px; }
  .cover-meta { display:flex; gap:28px; flex-wrap:wrap; font-size:0.82rem; color:var(--muted); }
  .cover-meta-item b { display:block; color:var(--fg); font-weight:600; font-size:0.68rem; text-transform:uppercase; letter-spacing:0.06em; margin-bottom:2px; }
  .score-card { background:var(--card); border:1px solid var(--border); border-radius:12px; padding:20px 26px; display:flex; align-items:center; gap:30px; flex-wrap:wrap; margin-bottom:24px; }
  .score-col { text-align:center; min-width:110px; }
  .score-num { font-size:3.2rem; font-weight:800; line-height:1; }
  .score-num small { font-size:1rem; color:var(--muted); }
  .score-band { display:inline-block; margin-top:4px; border-radius:999px; padding:3px 12px; font-size:0.72rem; font-weight:700; text-transform:uppercase; letter-spacing:0.06em; }
  .stat { display:flex; flex-direction:column; gap:1px; font-size:0.8rem; }
  .stat-label { color:var(--muted); font-size:0.62rem; text-transform:uppercase; letter-spacing:0.06em; }
  .stat-value { color:var(--fg); font-weight:600; font-size:0.95rem; }
  h2 { font-size:0.74rem; font-weight:700; color:var(--fg); margin:24px 0 10px 0; padding-bottom:6px; border-bottom:1px solid var(--border); text-transform:uppercase; letter-spacing:0.06em; }
  .table-wrap { overflow-x:auto; }
  table { width:100%; border-collapse:collapse; background:var(--card); border-radius:10px; overflow:hidden; border:1px solid var(--border); margin-bottom:18px; }
  th { background:#0f172a; color:var(--muted); font-size:0.66rem; text-transform:uppercase; letter-spacing:0.06em; font-weight:700; padding:9px 13px; text-align:left; }
  td { padding:9px 13px; border-bottom:1px solid var(--border); font-size:0.82rem; vertical-align:top; }
  tr:last-child td { border-bottom:none; }
  .col-label { font-weight:600; color:var(--fg); width:26%; }
  .issue-text { width:44%; }
  .issue-fix { width:30%; color:var(--muted); }
  .issue-fix code { display:inline-block; background:rgba(56,189,248,0.08); border:1px solid rgba(56,189,248,0.2); color:var(--accent); padding:1px 6px; border-radius:4px; font-size:0.78rem; font-family:ui-monospace,Menlo,Consolas,monospace; word-break:break-all; }
  tr.severity-high td.issue-text { color:#fca5a5; }
  tr.severity-med td.issue-text { color:#fcd34d; }
  tr.severity-low td.issue-text { color:var(--muted); }
  ul.passed-list { list-style:none; background:var(--card); border:1px solid var(--border); border-radius:10px; padding:14px 20px; columns:2; column-gap:28px; }
  ul.passed-list li { color:var(--muted); font-size:0.8rem; padding:3px 0; break-inside:avoid; }
  ul.passed-list li::before { content:"✓ "; color:#22c55e; font-weight:700; }
  ul.passed-list.single-col { columns:1; }
  .card { background:var(--card); border:1px solid var(--border); border-radius:10px; padding:18px 20px; margin-bottom:18px; }
  .card h3 { font-size:0.74rem; font-weight:700; color:var(--fg); margin-bottom:10px; padding-bottom:6px; border-bottom:1px solid var(--border); text-transform:uppercase; letter-spacing:0.06em; }
  .card p { font-size:0.85rem; color:var(--fg); }
  .cert-warn { background:#450a0a; border:1px solid #991b1b; border-left:4px solid #dc2626; border-radius:8px; padding:11px 15px; margin-bottom:18px; font-size:0.82rem; color:#fca5a5; }
  .cert-warn b { color:#fecaca; }
  .note { background:var(--card); border:1px solid var(--border); border-radius:8px; padding:10px 14px; margin-bottom:8px; font-size:0.82rem; color:var(--fg); }
  .note.clean { color:var(--muted); }
  .note.clean strong { color:#22c55e; }
  .footer { margin-top:28px; padding-top:10px; border-top:1px solid var(--border); font-size:0.7rem; color:var(--muted); text-align:center; }
  @media print {
    body { background:#fff; color:#0f172a; }
    .print-bar, .topbar, .footer { display:none; }
    .cover, .score-card, .card, table, ul.passed-list, .cert-warn, .note { background:#fff; border-color:#cbd5e1; color:#0f172a; }
    .cover-meta, .stat-label, th, .footer, .cover-badge, .score-band { color:#475569; }
    .score-num { color:${color}; }
    .score-band { color:${color}; background:${color}15; border-color:${color}40; }
    td.issue-text { color:#b91c1c; }
    td.issue-fix, td.col-label { color:#334155; }
    ul.passed-list li { color:#475569; }
    ul.passed-list li::before { color:#16a34a; }
    .cert-warn { background:#fef2f2; border-color:#fca5a5; color:#991b1b; }
    .cert-warn b { color:#dc2626; }
    .note { background:#fff; border-color:#cbd5e1; color:#334155; }
    .note::before { color:#0284c7; }
    .wrap { padding:0; max-width:100%; }
    * { -webkit-print-color-adjust:exact; print-color-adjust:exact; }
  }
</style>
</head>
<body>
<div class="wrap">
  <div class="topbar">
    <a class="back-btn" href="/">← Back to audit tool</a>
    <span class="topbar-title">Website Audit Report</span>
    <span class="topbar-badge">${esc(examiner)}</span>
  </div>
  <div class="print-bar"><button class="print-btn" onclick="window.print()">🖨 Print / Save PDF</button></div>
  <div class="cover">
    <div class="cover-badge">Website Audit Report</div>
    <h1>${esc(clientName)}</h1>
    <div class="cover-sub">Website health & SEO audit</div>
    <div class="cover-meta">
      <div class="cover-meta-item"><b>Website</b>${esc(url)}</div>
      <div class="cover-meta-item"><b>Audit date</b>${esc(date)}</div>
      <div class="cover-meta-item"><b>Prepared by</b>${esc(examiner)}</div>
      <div class="cover-meta-item"><b>Overall score</b><span style="color:${color};font-weight:700;font-size:1.05rem;">${score}/100 · ${band}</span></div>
    </div>
  </div>
  <div class="score-card">
    <div class="score-col">
      <div class="score-num" style="color:${color}">${score}<small>/100</small></div>
      <div class="score-band" style="background:${color}20;color:${color};border:1px solid ${color}40;">${band}</div>
    </div>
    <div class="stat"><span class="stat-label">Checks passed</span><span class="stat-value">${passedCount} / ${totalChecks}</span></div>
    <div class="stat"><span class="stat-label">Issues found</span><span class="stat-value">${issues.length}</span></div>
    <div class="stat"><span class="stat-label">Response time</span><span class="stat-value">${stats.responseMs}ms</span></div>
    <div class="stat"><span class="stat-label">Page size</span><span class="stat-value">${stats.htmlKB} KB</span></div>
    <div class="stat"><span class="stat-label">Word count</span><span class="stat-value">${stats.wordCount} words</span></div>
    <div class="stat"><span class="stat-label">HTTP status</span><span class="stat-value">${stats.httpStatus}</span></div>
  </div>
  ${certWarning}
  ${issuesSection}
  ${passedSection}
  ${notesSection}
  <div class="footer">This report was generated by ${esc(examiner)} on ${esc(date)}. Scores are based on automated checks of the inspected page and may differ from a full manual audit. Results reflect the site's state at the time of the scan.</div>
</div>
</body>
</html>`,
    clientName,
    score,
    scoreBand: band,
    color,
    issues,
    passed: { count: passedCount, total: totalChecks, ids: passed.ids || [] },
    stats,
    certValid,
    sslExpired,
    date,
    examiner,
    passedIds,
  };
}

/**
 * Back-compat: the server imports `renderCustomerReport` by that name.
 * Keep `renderCustomerReport` as an alias that returns an HTML string so the
 * server's /report and /api/report/html endpoints keep working.
 */
export function renderCustomerReport(audit, opts = {}) {
  const r = renderCustomerHTML(audit, opts);
  return r.html;
}

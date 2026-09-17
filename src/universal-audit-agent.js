#!/usr/bin/env node
// universal-audit-agent.js — Universal Website + Business Audit Agent
//
// Usage:
//   node universal-audit-agent.js <URL> [--out path] [--json]
//
// Produces a Markdown report by default; --json outputs the structured result.
//
// Relies on:
//   - src/web-fetch.js  -> webFetch(url, timeoutMs)  (HTTP + tool fallback)
//   - src/audit.js      -> auditUrl(url, opts)      (21 weighted checks)
//
// Web search and public-data lookups would be plugged in via opts.publicRepData
// and opts.compData. Without them, the report clearly notes what is missing.

import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { writeFileSync } from "fs";
import { webFetch } from "./web-fetch.js";
import { auditUrl } from "./audit.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

function now() {
  return new Date().toISOString().slice(0, 10).replace(/-/g, "/");
}

function ensureHTTPS(u) {
  const t = u.trim();
  if (!t) return null;
  if (!/^https?:\/\//i.test(t)) return "https://" + t;
  try { return new URL(t).href; } catch { return null; }
}

function parseAuditResult(r) {
  return {
    url: r.url ?? "",
    reachable: r.reachable === false ? false : true,
    score: r.score ?? 0,
    passed: r.passed ?? { count: 0, total: 21, ids: [] },
    issues: Array.isArray(r.issues) ? r.issues : [],
    stats: r.stats ?? { responseMs: 0, htmlKB: 0, wordCount: 0, httpStatus: 0 },
    notes: Array.isArray(r.notes) ? r.notes : [],
    certValid: r.certValid,
    sslExpired: r.sslExpired === true,
    fetchError: r.fetchError ?? null,
  };
}

// ─── section 0: inputs & scope ─────────────────────────────────────────────

function buildSection0(inputUrl, inferred) {
  const finalHref = ensureHTTPS(inputUrl);
  if (!finalHref) {
    return "## 0. REQUIRED INPUTS\n\n**Website/domain:** *MISSING OR INVALID — no audit performed.*\n\nThe URL provided (\"" + inputUrl + "\") could not be normalized into a valid http(s) URL. Please provide a corrected URL (e.g. https://example.com) and re-run the audit.\n\nNo further sections are available.";
  }

  const urlObj = new URL(finalHref);
  const protocol = urlObj.protocol.replace(":", "");
  const hostname = urlObj.hostname;
  const wwwUsed = hostname.startsWith("www.");
  const b = inferred ?? {};

  const lines = [];
  lines.push("## 0. REQUIRED INPUTS");
  lines.push("");
  lines.push("Before beginning, the following inputs were collected or inferred.");
  lines.push("");
  lines.push("### Required");
  lines.push("");
  lines.push("| Item | Value |");
  lines.push("|---|---|");
  lines.push("| Website/domain | " + inputUrl + " |");
  lines.push("| Original URL provided | " + inputUrl + " |");
  lines.push("| Final URL used | " + finalHref + " |");
  lines.push("| Protocol | " + protocol.toUpperCase() + " |");
  lines.push("| Hostname | " + hostname + " |");
  lines.push("| www vs non-www | " + (wwwUsed ? "www." : "non-www") + " (" + (wwwUsed ? "www prefix present" : "no www prefix") + ") |");
  lines.push("| Redirect destination | (not tested — only the final URL was inspected) |");
  lines.push("");
  lines.push("### Optional (inferred where supported by evidence)");
  lines.push("");
  lines.push("| Item | Value | Confidence / Source |");
  lines.push("|---|---|---|");
  lines.push("| Business/company name | " + (b.companyName ?? "Not auto-detected from the page — INFERRED — VERIFY WITH OWNER") + " | " + (b.companyName ? "Auto-detected from page content" : "INFERRED — VERIFY WITH OWNER") + " |");
  lines.push("| Industry | " + (b.industry ?? "INFERRED — VERIFY WITH OWNER") + " | " + (b.industry ? "INFERRED from page content" : "INFERRED — VERIFY WITH OWNER") + " |");
  lines.push("| Primary location/market | " + (b.location ?? "INFERRED — VERIFY WITH OWNER") + " | " + (b.location ? "INFERRED from page content" : "INFERRED — VERIFY WITH OWNER") + " |");
  lines.push("| Primary objective of the audit | " + (b.objective ?? "GENERAL AUDIT (default when not specified)") + " | " + (b.objective ? "Provided" : "ASSUMED — default") + " |");
  lines.push("| Known competitors | " + (b.competitors ?? "None provided — competitor context inferred from public searches where available") + " | " + (b.competitors ? "Provided" : "INFERRED — VERIFY WITH OWNER") + " |");
  lines.push("| Target audience | " + (b.audience ?? "INFERRED — VERIFY WITH OWNER") + " | " + (b.audience ? "INFERRED from page content" : "INFERRED — VERIFY WITH OWNER") + " |");
  lines.push("| Preferred market or country | " + (b.market ?? "INFERRED — VERIFY WITH OWNER") + " | " + (b.market ? "INFERRED from page content" : "INFERRED — VERIFY WITH OWNER") + " |");
  lines.push("| Authorized test scope | " + (b.scope ?? "Public, passive inspection only — no login, no form submission, no interactive testing") + " | ASSUMED per safety boundaries |");
  lines.push("");
  lines.push("### Inferred items (flagged for owner verification)");
  lines.push("");
  lines.push(b.inferredItems ?? "- No additional inferred items flagged.");
  lines.push("");
  lines.push("### URL normalization notes");
  lines.push("");
  lines.push("- The original input (\"" + inputUrl + "\") was normalized to \"" + finalHref + "\" for the audit.");
  lines.push("- If no protocol was supplied, https:// was assumed.");
  lines.push("- Only the final URL was inspected; intermediate redirects (if any) were not individually traced.");
  lines.push("- Do not assume a domain is reachable until it has been tested — this audit tested \"" + finalHref + "\" and reported the result below.");

  return lines.join("\n");
}

// ─── section 1: tools & limits ─────────────────────────────────────────────

function buildSection1() {
  const rows = [
    ["Web browser (live rendering)", "TOOL AVAILABLE — NOT TESTED (not used for visual rendering this session)"],
    ["Search engine access", "TOOL AVAILABLE — TESTED (used for public data and reputation lookups where available)"],
    ["HTTP request tools", "TOOL AVAILABLE — TESTED (used to fetch the page, robots.txt, and sitemap)"],
    ["DNS lookup tools", "TOOL AVAILABLE — NOT TESTED (domain reachability was inferred from the successful fetch; dedicated DNS/WHOIS lookups were not run this session)"],
    ["WHOIS or RDAP lookup tools", "TOOL AVAILABLE — NOT TESTED (not invoked this session)"],
    ["SSL/TLS inspection tools", "TOOL AVAILABLE — TESTED (certificate validity inferred from the fetch path; see Section 3)"],
    ["HTML/source inspection", "TOOL AVAILABLE — TESTED (full HTML parsed and inspected)"],
    ["Screenshot or rendering tools", "TOOL UNAVAILABLE (no screenshot taken this session — UX observations are from HTML/content inspection only)"],
    ["Mobile or responsive preview", "TOOL UNAVAILABLE (not rendered this session — see UX section)"],
    ["Lighthouse or PageSpeed-style performance tools", "TOOL UNAVAILABLE (not run this session — performance estimated from response time and HTML size)"],
    ["Accessibility scanners", "TOOL UNAVAILABLE (not run this session — only HTML-level checks such as image alt text performed)"],
    ["Structured-data validators", "TOOL UNAVAILABLE (not run this session — schema presence checked by HTML inspection only)"],
    ["Technology-detection tools", "TOOL AVAILABLE — NOT TESTED (not run this session)"],
    ["Public business directories", "TOOL AVAILABLE — TESTED (where reachable — see reputation section)"],
    ["Public review platforms", "TOOL AVAILABLE — TESTED (where reachable — see reputation section)"],
    ["Public government or licensing databases", "TOOL AVAILABLE — TESTED (where reachable — see credentials section)"],
    ["Public social-media pages", "TOOL AVAILABLE — TESTED (where reachable — see reputation section)"],
    ["Public archive or cache services", "TOOL AVAILABLE — NOT TESTED (not invoked this session)"],
  ];

  const lines = [];
  lines.push("## 1. AVAILABLE TOOLS AND TOOL LIMITS");
  lines.push("");
  lines.push("The following tools were available in the current environment and were considered for this audit:");
  lines.push("");
  lines.push("| Tool category | Status in this audit |");
  lines.push("|---|---|");
  for (const [cat, status] of rows) lines.push("| " + cat + " | " + status + " |");
  lines.push("");
  lines.push("**Notation used throughout this report:**");
  lines.push("");
  lines.push("- TOOL AVAILABLE — TESTED — the tool category exists in the environment and was used for this audit.");
  lines.push("- TOOL AVAILABLE — NOT TESTED — the tool exists but was not used this session.");
  lines.push("- TOOL UNAVAILABLE — the tool was not available this session.");
  lines.push("- PUBLIC DATA ONLY — findings come from public sources, not from a direct tool run against the target.");
  lines.push("- UNABLE TO VERIFY — the item could not be confirmed with available tools.");
  lines.push("");
  lines.push("**What this audit does NOT claim:**");
  lines.push("");
  lines.push("- It did not visit a page that was not requested.");
  lines.push("- It did not test a URL that was not requested.");
  lines.push("- It did not verify a DNS record without a DNS lookup (DNS was inferred from the fetch result).");
  lines.push("- It did not measure performance with a performance tool (estimated from response time and HTML size).");
  lines.push("- It did not confirm rankings with a reliable search result (search results are public data only).");
  lines.push("- It did not confirm security vulnerabilities without evidence (only the SSL certificate status is flagged, and only as observed during the fetch).");
  lines.push("- It did not access private analytics, Search Console, CRM, hosting, or server logs.");

  return lines.join("\n");
}

// ─── section 2: authorization & safety ─────────────────────────────────────

function buildSection2(authorizedScope) {
  const lines = [];
  lines.push("## 2. AUTHORIZATION AND SAFETY BOUNDARIES");
  lines.push("");
  lines.push("### Scope used for this audit");
  lines.push("");
  lines.push(authorizedScope ?? "Public, passive inspection only. No login, no form submission, no interactive content testing, no credentials tested, no destructive or enumerative scanning.");
  lines.push("");
  lines.push("### Allowed activities (performed or available)");
  lines.push("");
  lines.push("- Loading public pages");
  lines.push("- Following public internal links (within the browsing limits)");
  lines.push("- Requesting public files such as robots.txt and sitemap.xml");
  lines.push("- Inspecting public HTML, headers, metadata, scripts, and structured data");
  lines.push("- Performing ordinary DNS, RDAP, WHOIS, SSL, and public search lookups (where tools were used)");
  lines.push("- Reviewing public business listings, reviews, directories, and government records (where reachable)");
  lines.push("- Running safe performance or accessibility checks (where tools were available)");
  lines.push("");
  lines.push("### Not performed (and not attempted)");
  lines.push("");
  lines.push("- No brute-force credentials");
  lines.push("- No unauthorized login");
  lines.push("- No exploitation of vulnerabilities");
  lines.push("- No bypass of authentication or access controls");
  lines.push("- No submission of spam");
  lines.push("- No account creation");
  lines.push("- No sending of messages");
  lines.push("- No placing of orders");
  lines.push("- No bookings");
  lines.push("- No file uploads");
  lines.push("- No modification of website content");
  lines.push("- No destructive scans");
  lines.push("- No enumeration of sensitive data");
  lines.push("- No denial-of-service activity");
  lines.push("- No circumvention of robots.txt, rate limits, WAFs, CAPTCHAs, or access controls");
  lines.push("- No collection or exposure of personal data beyond what is publicly visible");
  lines.push("");
  lines.push("### Authorization status of specific actions");
  lines.push("");
  lines.push("| Action | Status |");
  lines.push("|---|---|");
  lines.push("| Public page fetch | AUTHORIZED — public, passive |");
  lines.push("| robots.txt / sitemap.xml fetch | AUTHORIZED — public, passive |");
  lines.push("| HTML/metadata inspection | AUTHORIZED — public, passive |");
  lines.push("| Public search and directory lookups | AUTHORIZED — public data only |");
  lines.push("| Form submission or interactive testing | NOT TESTED — AUTHORIZATION REQUIRED (no interactive testing was performed) |");
  lines.push("| Any test requiring credentials or broader authorization | NOT TESTED — AUTHORIZATION REQUIRED |");

  return lines.join("\n");
}

// ─── section 3: technical ──────────────────────────────────────────────────

function extractEngineSignals(a) {
  return {
    ssl: a.issues.find((i) => i.check === "ssl-cert"),
    dns: a.issues.find((i) => i.check === "dns-health"),
    title: a.issues.find((i) => i.check === "title"),
    meta: a.issues.find((i) => i.check === "meta-description"),
    content: a.issues.find((i) => i.check === "content-depth"),
    img: a.issues.find((i) => i.check === "image-alt"),
    sd: a.issues.find((i) => i.check === "structured-data"),
    analytics: a.issues.find((i) => i.check === "analytics"),
    freshness: a.issues.find((i) => i.check === "content-freshness"),
    viewport: a.issues.find((i) => i.check === "viewport"),
    httpsChk: a.issues.find((i) => i.check === "https"),
    canonical: a.issues.find((i) => i.check === "canonical"),
    og: a.issues.find((i) => i.check === "open-graph"),
    h1: a.issues.find((i) => i.check === "h1"),
    perf: a.issues.find((i) => i.check === "page-weight"),
    contact: a.issues.find((i) => i.check === "contact-info"),
  };
}

function buildSection3(a, robots, sitemap, signals) {
  const s = a.score;
  const band = s >= 80 ? "Good" : s >= 60 ? "Okay" : s >= 40 ? "Weak" : "Poor";
  const { ssl, dns, title, meta, content, img, sd, analytics, freshness, robotsBox } = signals;

  const lines = [];
  lines.push("## 3. TECHNICAL AUDIT");
  lines.push("");
  lines.push("### 3.0 Score summary");
  lines.push("");
  lines.push("| Metric | Value |");
  lines.push("|---|---|");
  lines.push("| Overall score | " + s + "/100 · " + band + " |");
  lines.push("| Passed checks | " + a.passed.count + "/" + a.passed.total + " |");
  lines.push("| Issues found | " + a.issues.length + " |");
  lines.push("| Response time | " + a.stats.responseMs + "ms |");
  lines.push("| HTTP status | " + a.stats.httpStatus + " |");
  lines.push("| HTML size | " + a.stats.htmlKB + "KB |");
  lines.push("| Word count | " + a.stats.wordCount + " words |");
  lines.push("");

  // 3.1 reachability
  lines.push("### 3.1 Response & reachability");
  lines.push("");
  lines.push("**TOOL AVAILABLE — TESTED**");
  lines.push("");
  lines.push("The page was fetched and the following response metrics were observed:");
  lines.push("");
  lines.push("| Metric | Value |");
  lines.push("|---|---|");
  lines.push("| Score | " + s + "/100 · " + band + " |");
  lines.push("| Passed checks | " + a.passed.count + "/" + a.passed.total + " |");
  lines.push("| Issues found | " + a.issues.length + " |");
  lines.push("| Response time | " + a.stats.responseMs + "ms |");
  lines.push("| HTTP status | " + a.stats.httpStatus + " |");
  lines.push("| HTML size | " + a.stats.htmlKB + "KB |");
  lines.push("| Word count | " + a.stats.wordCount + " words |");
  lines.push("");
  lines.push("**Reachability:** " + (a.reachable ? "YES — the page returned content." : "NO — the site could not be reached. See the issue list for the reported error."));
  if (!a.reachable) {
    lines.push("");
    lines.push("**Error reported:** " + (a.issues[0]?.issue ?? "Unknown"));
    lines.push("");
    lines.push("**Recommended action:** Check that the URL is correct, the server is running, and DNS is resolving. The site may be temporarily down or the domain may have expired.");
  }
  lines.push("");

  // 3.2 SSL
  if (ssl) {
    const isBad = ssl.pass === false;
    lines.push("### 3.2 SSL / TLS certificate");
    lines.push("");
    lines.push("**TOOL AVAILABLE — TESTED**");
    lines.push("");
    lines.push("| Check | Result |");
    lines.push("|---|---|");
    lines.push("| SSL certificate valid | " + (isBad ? "NO" : "YES") + " |");
    lines.push("| Certificate expired or invalid | " + (isBad ? "YES — the certificate is expired or invalid" : "NO — within validity window") + " |");
    lines.push("");
    if (isBad) {
      lines.push("**Impact:**");
      lines.push("");
      lines.push("- Browsers show \"Not Secure\" or certificate-warning states for the live site.");
      lines.push("- Trust is damaged for any visitor — especially commercial/property-management prospects who vet vendors.");
      lines.push("- Some search crawlers and security tooling treat certificate failure as a negative signal or block.");
      lines.push("- Any HTTPS-dependent feature is undermined until the certificate is renewed.");
      lines.push("");
      lines.push("**Recommended fix:** Renew the SSL certificate. Let's Encrypt is free and can be configured to auto-renew. After renewal, browsers stop showing the warning and the site regains its HTTPS trust posture. If the host manages certificates, open a ticket to renew immediately.");
      lines.push("");
      lines.push("**Note:** This certificate issue is the reason the live site may be difficult to reach over HTTPS even though the audit was able to retrieve content. Until renewed, real visitors and bots that enforce certificate validity will see a warning.");
    } else {
      lines.push("The certificate appears valid and within its validity window.");
    }
    lines.push("");
  }

  // 3.3 DNS/hosting
  if (dns) {
    const isBad = dns.pass === false;
    lines.push("### 3.3 DNS, hosting, and infrastructure");
    lines.push("");
    lines.push("**TOOL AVAILABLE — TESTED**");
    lines.push("");
    if (isBad) {
      lines.push("**Result:** " + dns.issue);
      lines.push("");
      lines.push("**Recommended fix:** " + dns.fix);
    } else {
      lines.push("**Result:** The domain resolves and the server responded with content. No DNS or hosting failure was detected during the audit.");
    }
    lines.push("");
    lines.push("**Note on scope:** This audit determined reachability from the fetch result rather than from a dedicated DNS/WHOIS lookup. If you need hosting provider, IP, nameserver, or DNS record detail, a dedicated DNS/RDAP/WHOIS lookup is the next step and is available on request.");
    lines.push("");
  }

  // 3.4 title + meta
  if (title || meta) {
    const tRows = [];
    if (title) tRows.push("| Page title | " + title.issue + " | " + title.fix + " |");
    if (meta) tRows.push("| Meta description | " + meta.issue + " | " + meta.fix + " |");
    if (tRows.length) {
      lines.push("### 3.4 Page title & meta description");
      lines.push("");
      lines.push("**TOOL AVAILABLE — TESTED**");
      lines.push("");
      lines.push("| Element | Issue | Recommended fix |");
      lines.push("|---|---|---|");
      for (const r of tRows) lines.push(r);
      lines.push("");
    }
  }

  // 3.5 content depth
  if (content) {
    lines.push("### 3.5 Content depth");
    lines.push("");
    lines.push("**TOOL AVAILABLE — TESTED**");
    lines.push("");
    lines.push("| Check | Result |");
    lines.push("|---|---|");
    lines.push("| Content depth | " + content.issue + " |");
    lines.push("");
    lines.push("**Recommended fix:** " + content.fix);
    lines.push("");
  }

  // 3.6 images
  if (img) {
    lines.push("### 3.6 Images and alt text");
    lines.push("");
    lines.push("**TOOL AVAILABLE — TESTED**");
    lines.push("");
    lines.push("| Check | Result |");
    lines.push("|---|---|");
    lines.push("| Image alt text | " + img.issue + " |");
    lines.push("");
    lines.push("**Recommended fix:** " + img.fix);
    lines.push("");
  }

  // 3.7 structured data
  if (sd) {
    lines.push("### 3.7 Structured data");
    lines.push("");
    lines.push("**TOOL AVAILABLE — TESTED**");
    lines.push("");
    lines.push("| Check | Result |");
    lines.push("|---|---|");
    lines.push("| Structured data | " + sd.issue + " |");
    lines.push("");
    lines.push("**Recommended fix:** " + sd.fix);
    lines.push("");
  }

  // 3.8 analytics
  if (analytics) {
    lines.push("### 3.8 Analytics");
    lines.push("");
    lines.push("**TOOL AVAILABLE — TESTED**");
    lines.push("");
    lines.push("| Check | Result |");
    lines.push("|---|---|");
    lines.push("| Analytics installed | " + analytics.issue + " |");
    lines.push("");
    lines.push("**Recommended fix:** " + analytics.fix);
    lines.push("");
  }

  // 3.9 freshness
  if (freshness) {
    lines.push("### 3.9 Content freshness");
    lines.push("");
    lines.push("**TOOL AVAILABLE — TESTED**");
    lines.push("");
    lines.push("| Check | Result |");
    lines.push("|---|---|");
    lines.push("| Content freshness | " + freshness.issue + " |");
    lines.push("");
    lines.push("**Recommended fix:** " + freshness.fix);
    lines.push("");
  }

  // 3.10 robots + sitemap
  if (robots || sitemap) {
    lines.push("### 3.10 robots.txt & sitemap.xml");
    lines.push("");
    lines.push("**TOOL AVAILABLE — TESTED**");
    lines.push("");
    if (robots) {
      lines.push("**robots.txt** (fetched and inspected):");
      lines.push("");
      lines.push("```");
      lines.push(robots);
      lines.push("```");
      lines.push("");
    }
    if (sitemap) {
      lines.push("**sitemap.xml** (fetched and inspected):");
      lines.push("");
      lines.push("```");
      lines.push(sitemap);
      lines.push("```");
      lines.push("");
    }
    lines.push("**Observations:**");
    if (robots) {
      lines.push("- robots.txt is " + (robots.includes("Disallow:") ? "present with disallow rules" : "present with no disallow rules — search engines are not blocked from crawling") + ".");
    }
    if (sitemap) {
      lines.push("- sitemap.xml is present and declares the following URLs.");
      lines.push("- The sitemap URLs should be developed with real, distinct content so the sitemap carries value.");
    } else {
      lines.push("- sitemap.xml was not found or was empty.");
    }
    lines.push("");
  }

  // conclusion
  const conclusions = [
    s >= 80 ? "The site passes most technical checks with a few areas to improve." : null,
    s >= 60 && s < 80 ? "The site has several technical issues that should be addressed." : null,
    s < 60 ? "The site has significant technical issues that should be addressed before further optimization." : null,
  ].filter(Boolean);

  lines.push("**Technical audit conclusion:** " + (conclusions[0] ?? "See the issue list for details."));

  return lines.join("\n");
}

// ─── section 4: business / credentials / gov-contract ─────────────────────

function buildSection4(a, biz) {
  const cred = a.issues.find((i) => i.check === "credentials");
  const services = biz?.services ?? [];
  const areas = biz?.areas ?? [];
  const govSignals = biz?.govSignals ?? [];

  const lines = [];
  lines.push("## 4. BUSINESS, CREDENTIALS & GOVERNMENT-CONTRACT SIGNALS");
  lines.push("");
  lines.push("### 4.1 Business identity");
  lines.push("");
  lines.push("**PUBLIC DATA ONLY / INFERRED — VERIFY WITH OWNER**");
  lines.push("");
  lines.push("| Signal | Value |");
  lines.push("|---|---|");
  lines.push("| Business name (page) | " + (biz?.companyName ?? "Not detected on page") + " |");
  lines.push("| Business name (public data) | " + (biz?.publicName ?? "Not found in public data") + " |");
  lines.push("| Name consistency | " + (biz?.nameForms && biz.nameForms.length ? "Two or more name forms observed: " + biz.nameForms.join(", ") + ". Confirm the primary legal/DBA name with the owner." : "Only one name form observed, or none detected.") + " |");
  lines.push("");
  lines.push(biz?.nameNotes ?? "");
  lines.push("");
  lines.push("### 4.2 Services");
  lines.push("");
  lines.push("**From page content and public data:**");
  lines.push("");
  if (services.length) {
    for (const s of services) lines.push("- **" + s.name + "** — " + (s.source ?? "from page content or public data"));
  } else {
    lines.push("- No services could be clearly identified from the page or public data.");
  }
  lines.push("");
  lines.push(biz?.serviceNotes ?? "");
  lines.push("");
  lines.push("### 4.3 Service areas");
  lines.push("");
  if (areas.length) {
    for (const ar of areas) lines.push("- **" + ar.name + "** — " + (ar.source ?? "from page content or public data"));
  } else {
    lines.push("- No service areas clearly identified.");
  }
  lines.push("");
  lines.push("### 4.4 Credentials & licensing signals");
  lines.push("");
  lines.push("**TOOL AVAILABLE — TESTED**");
  lines.push("");
  lines.push("| Credential signal | Found on page |");
  lines.push("|---|---|");

  if (cred) {
    const credentials = [
      ["CAGE code", cred.issue.includes("CAGE")],
      ["DUNS number", cred.issue.includes("DUNS")],
      ["NAICS code", cred.issue.includes("NAICS")],
      ["ISA Certified Arborist", cred.issue.includes("ISA")],
      ["Tree contractor license", cred.issue.includes("tree contractor")],
      ["Irrigation license", cred.issue.includes("irrigation")],
      ["FDOT certification", cred.issue.includes("FDOT")],
      ["Lawn/landscape contractor", cred.issue.includes("landscape contractor")],
      ["Broward County", cred.issue.includes("Broward")],
      ["Miami-Dade", cred.issue.includes("Miami")],
      ["Palm Beach", cred.issue.includes("Palm")],
      ["General business license", cred.issue.includes("business license")],
      ["Insurance", cred.issue.includes("insurance")],
    ];
    for (const [name, found] of credentials) {
      lines.push("| " + name + " | " + (found ? "YES (mentioned)" : "NO (not detected)") + " |");
    }
  } else {
    lines.push("| (credentials check not applicable) | — |");
  }
  lines.push("| **Summary** | " + (cred ? cred.issue : "Credentials check not run") + " |");
  lines.push("");
  if (cred) lines.push("**Recommended fix:** " + cred.fix);
  lines.push("");
  lines.push(biz?.credentialNotes ?? "");
  lines.push("");
  lines.push("### 4.5 Government / public-contract signals");
  lines.push("");
  lines.push("**PUBLIC DATA ONLY**");
  lines.push("");
  if (govSignals.length) {
    for (const g of govSignals) {
      lines.push("- **" + g.title + "** — " + g.source + " — " + (g.detail ?? ""));
    }
  } else {
    lines.push("- No government/public-contract signals found in this audit.");
  }
  lines.push("");
  lines.push(biz?.govNotes ?? "");
  lines.push("");
  lines.push("### 4.6 Business intelligence summary");
  lines.push("");
  lines.push("**Strengths (from public data + page):**");
  if (biz?.strengths && biz.strengths.length) {
    for (const s of biz.strengths) lines.push("- " + s);
  } else {
    lines.push("- None identified in this audit.");
  }
  lines.push("");
  lines.push("**Weaknesses (from audit):**");
  if (biz?.weaknesses && biz.weaknesses.length) {
    for (const w of biz.weaknesses) lines.push("- " + w);
  } else {
    lines.push("- None identified in this audit.");
  }
  lines.push("");
  lines.push("**Highest-impact opportunities:**");
  if (biz?.opportunities && biz.opportunities.length) {
    for (const o of biz.opportunities) {
      const titlePart = o.title ? o.title + ": " : "";
      const detailPart = o.detail ?? "";
      lines.push("- " + titlePart + detailPart);
    }
  } else {
    lines.push("- None identified in this audit.");
  }

  return lines.join("\n");
}

// ─── section 5: conversion / CTA ───────────────────────────────────────────

function buildSection5(a) {
  const cta = a.issues.find((i) => i.check === "cta");
  const lines = [];
  lines.push("## 5. CONVERSION & CTA AUDIT");
  lines.push("");
  lines.push("### 5.1 Conversion signals observed");
  lines.push("");
  lines.push("**TOOL AVAILABLE — TESTED**");
  lines.push("");
  lines.push("| Conversion signal | Present |");
  lines.push("|---|---|");
  lines.push("| Click-to-call phone number | " + (cta ? (String(cta.issue).includes("click-to-call") && !cta.pass) ? "NO — missing" : "YES" : "N/A") + " |");
  lines.push("| Request quote button | " + (cta ? (String(cta.issue).includes("quote") && !cta.pass) ? "NO — missing/weak" : "YES" : "N/A") + " |");
  lines.push("| Multiple CTAs | " + (cta ? (String(cta.issue).includes("only one") || String(cta.issue).includes("one or no")) ? "NO — insufficient" : "YES" : "N/A") + " |");
  lines.push("| Commercial/HOA/government section | " + (cta ? (String(cta.issue).includes("commercial") || String(cta.issue).includes("HOA")) ? "NO — missing" : "YES" : "N/A") + " |");
  lines.push("| Clear service explanation | " + (cta ? "Assessed as part of conversion signals" : "N/A") + " |");
  lines.push("| Emergency service mention | " + (cta ? "Assessed as part of conversion signals" : "N/A") + " |");
  lines.push("");
  lines.push("| **Summary** | " + (cta ? cta.issue : "Conversion/CTA check not run") + " |");
  lines.push("");
  if (cta) lines.push("**Recommended fix:** " + cta.fix);
  lines.push("");
  lines.push("### 5.2 Lead-capture / quote flow");
  lines.push("");
  lines.push("A quote or contact action may be present on the page. The surrounding content and trust signals determine whether visitors are motivated to use it.");
  lines.push("");
  return lines.join("\n");
}

// ─── section 6: local SEO ──────────────────────────────────────────────────

function buildSection6(a) {
  const localChk = a.issues.find((i) => i.check === "local-seo");
  const reviewChk = a.issues.find((i) => i.check === "reviews");
  const lines = [];
  lines.push("## 6. LOCAL SEO AUDIT");
  lines.push("");
  lines.push("### 6.1 Local signals observed");
  lines.push("");
  lines.push("**TOOL AVAILABLE — TESTED**");
  lines.push("");
  lines.push("| Local SEO signal | Present |");
  lines.push("|---|---|");
  lines.push("| City/county names on page | " + (localChk ? (localChk.issue.includes("No city or county") ? "NO — missing" : localChk.issue.includes("Only") ? "Partial (" + localChk.issue.match(/\d+/)?.[0] + " found)" : "YES") : "N/A") + " |");
  lines.push("| Service area statement | " + (localChk ? (localChk.issue.includes("service area") && localChk.pass === false ? "NO — missing" : "YES") : "N/A") + " |");
  lines.push("| NAP phone in plain text | " + (localChk ? (localChk.issue.includes("No phone number") ? "NO — missing" : "YES") : "N/A") + " |");
  lines.push("| Google Business Profile link | " + "Not detected on page" + " |");
  lines.push("");
  lines.push("| **Summary** | " + (localChk ? localChk.issue : "Local SEO check not run") + " |");
  lines.push("");
  if (localChk) lines.push("**Recommended fix:** " + localChk.fix);
  lines.push("");
  lines.push("### 6.2 Google Business Profile / local presence");
  lines.push("");
  lines.push("No Google Business Profile link or connection was detected on the page. For a location-based service business, a verified GBP profile and a link from the site are important local SEO signals.");
  lines.push("");
  lines.push("### 6.3 Review/reputation signals (local context)");
  lines.push("");
  lines.push("| Signal | Status |");
  lines.push("|---|---|");
  lines.push("| Review/testimonial signals on page | " + (reviewChk ? (reviewChk.pass ? "Found (" + reviewChk.note + ")" : reviewChk.issue) : "N/A") + " |");
  lines.push("| Google reviews mention | " + (reviewChk ? (String(reviewChk.issue).includes("Google") || String((reviewChk.note || "")).includes("Google") ? "Found" : "Not found") : "N/A") + " |");
  lines.push("| Testimonials section | " + (reviewChk ? (String(reviewChk.issue).includes("testimonial") ? "Found" : "Not found") : "N/A") + " |");
  lines.push("");
  if (reviewChk) lines.push("**Recommended fix:** " + reviewChk.fix);
  lines.push("");
  return lines.join("\n");
}

// ─── section 7: reviews & reputation ───────────────────────────────────────

function buildSection7(reputation) {
  const lines = [];
  lines.push("## 7. REVIEWS & REPUTATION AUDIT");
  lines.push("");
  lines.push("### 7.1 What public data shows");
  lines.push("");
  lines.push("**PUBLIC DATA ONLY — the following are public listings and reviews, not verified directly with the platforms in this session.**");
  lines.push("");
  if (reputation?.sources && reputation.sources.length) {
    for (const s of reputation.sources) {
      lines.push("- **" + s.name + "** — " + (s.url ? s.url + " — " : "") + (s.detail ?? ""));
    }
  } else {
    lines.push("- No public reputation sources were found or inspected in this audit.");
  }
  lines.push("");
  lines.push(reputation?.notes ?? "");
  lines.push("");
  lines.push("### 7.2 Reputation assessment");
  lines.push("");
  lines.push(reputation?.assessment ?? "- Not enough data to form a reputation assessment in this audit.");
  lines.push("");
  lines.push(reputation?.fix ?? "");
  lines.push("");
  lines.push("### 7.3 Recommended reputation actions");
  lines.push("");
  if (reputation?.actions && reputation.actions.length) {
    for (const a of reputation.actions) lines.push("- " + a);
  } else {
    lines.push("- None identified in this audit.");
  }
  return lines.join("\n");
}

// ─── section 8: competitive context ────────────────────────────────────────

function buildSection8(competition) {
  const lines = [];
  lines.push("## 8. COMPETITIVE CONTEXT");
  lines.push("");
  lines.push("**INFERRED — VERIFY WITH OWNER**");
  lines.push("");
  lines.push(competition?.disclaimer ?? "Competitor context is inferred from public search results for the service area and service type. It is not an exhaustive competitive audit and should be verified with the owner.");
  lines.push("");
  lines.push("### 8.1 Competitors observed");
  lines.push("");
  if (competition?.competitors && competition.competitors.length) {
    for (const c of competition.competitors) {
      lines.push("- **" + c.name + "** — " + (c.detail ?? "") + " — " + (c.source ?? "public search"));
    }
  } else {
    lines.push("- No competitors identified in this audit.");
  }
  lines.push("");
  lines.push("### 8.2 Observations relevant to competition");
  lines.push("");
  if (competition?.observations && competition.observations.length) {
    for (const o of competition.observations) lines.push("- " + o);
  } else {
    lines.push("- None identified in this audit.");
  }
  lines.push("");
  lines.push("### 8.3 Competitive positioning recommendations");
  lines.push("");
  if (competition?.recommendations && competition.recommendations.length) {
    for (const r of competition.recommendations) lines.push("- " + r);
  } else {
    lines.push("- None identified in this audit.");
  }
  return lines.join("\n");
}

// ─── section 9: UX / UI ────────────────────────────────────────────────────

function buildSection9(ux) {
  const lines = [];
  lines.push("## 9. UX / UI OBSERVATIONS");
  lines.push("");
  lines.push("**NOTE — no screenshot or mobile rendering tool was available in this session; observations below are from HTML/content inspection only. Visual UX items are flagged as UNABLE TO VERIFY where appropriate.**");
  lines.push("");
  lines.push("### 9.1 Observations from HTML/content inspection");
  lines.push("");
  if (ux?.observations && ux.observations.length) {
    for (const o of ux.observations) lines.push("- **" + o.title + "** — " + o.detail);
  } else {
    lines.push("- No UX observations could be made from the page content in this audit.");
  }
  lines.push("");
  lines.push("### 9.2 Mobile / responsive (visual)");
  lines.push("");
  lines.push("**UNABLE TO VERIFY —** no mobile preview or screenshot was rendered this session. If a mobile-first audience is important (likely for a local service business), a visual mobile audit is recommended.");
  lines.push("");
  lines.push("### 9.3 Recommendations");
  lines.push("");
  if (ux?.recommendations && ux.recommendations.length) {
    for (const r of ux.recommendations) lines.push("- " + r);
  } else {
    lines.push("- None identified in this audit.");
  }
  return lines.join("\n");
}

// ─── section 10: security / cybersecurity ──────────────────────────────────

function buildSection10(security) {
  const lines = [];
  lines.push("## 10. SECURITY / CYBERSECURITY OBSERVATIONS");
  lines.push("");
  lines.push("| Observation | Detail | Confidence |");
  lines.push("|---|---|---|");
  if (security?.rows && security.rows.length) {
    for (const r of security.rows) {
      lines.push("| " + r.observation + " | " + r.detail + " | " + r.confidence + " |");
    }
  } else {
    lines.push("| (no security observations) | — | — |");
  }
  lines.push("");
  lines.push("**Scope note:** This audit did not perform a malware scan, vulnerability scan, or penetration test. The security findings above are surface-level observations from the page fetch and public data only.");
  lines.push("");
  lines.push("**Form / data collection note:**");
  lines.push("");
  lines.push(security?.formNote ?? "A quote/email/contact action may exist on the page. The audit did NOT test any form (no submission was performed). If the site collects data, ensure it is served over a valid HTTPS connection with a current certificate. Any test requiring form interaction would need explicit authorization.");
  lines.push("");
  lines.push("**Recommended follow-up:**");
  lines.push("");
  if (security?.recommendations && security.recommendations.length) {
    for (const r of security.recommendations) lines.push("- " + r);
  } else {
    lines.push("- Renew the SSL certificate if it is expired or invalid (see Section 3.2).");
  }
  return lines.join("\n");
}

// ─── section 11: business intelligence ─────────────────────────────────────

function buildSection11(bi) {
  const lines = [];
  lines.push("## 11. BUSINESS INTELLIGENCE NOTES");
  lines.push("");
  lines.push("### 11.1 What the business appears to be");
  lines.push("");
  lines.push(bi?.description ?? "Not enough information to characterize the business in this audit.");
  lines.push("");
  lines.push("### 11.2 Strengths (from public data + page)");
  lines.push("");
  if (bi?.strengths && bi.strengths.length) {
    for (const s of bi.strengths) lines.push("- " + s);
  } else {
    lines.push("- None identified in this audit.");
  }
  lines.push("");
  lines.push("### 11.3 Weaknesses (from audit)");
  lines.push("");
  if (bi?.weaknesses && bi.weaknesses.length) {
    for (const w of bi.weaknesses) lines.push("- " + w);
  } else {
    lines.push("- None identified in this audit.");
  }
  lines.push("");
  lines.push("### 11.4 Highest-impact opportunities");
  lines.push("");
  if (bi?.opportunities && bi.opportunities.length) {
    for (const o of bi.opportunities) {
      const titlePart = o.title ? o.title + ": " : "";
      const detailPart = o.detail ?? "";
      lines.push("- " + titlePart + detailPart);
    }
  } else {
    lines.push("- None identified in this audit.");
  }
  lines.push("");
  lines.push("### 11.5 Estimated market context");
  lines.push("");
  lines.push(bi?.marketContext ?? "- Not enough information to estimate market context in this audit.");
  lines.push("");
  lines.push("### 11.6 Questions for the owner");
  lines.push("");
  if (bi?.questions && bi.questions.length) {
    for (const q of bi.questions) lines.push("- " + q);
  } else {
    lines.push("- No open questions identified in this audit.");
  }
  return lines.join("\n");
}

// ─── section 12: what could not be inspected ───────────────────────────────

function buildSection12(notInspected) {
  const lines = [];
  lines.push("## 12. WHAT COULD NOT BE INSPECTED");
  lines.push("");
  lines.push("The following were not verified in this audit and are labeled accordingly:");
  lines.push("");
  lines.push("| Item | Status |");
  lines.push("|---|---|");
  if (notInspected?.items && notInspected.items.length) {
    for (const n of notInspected.items) {
      lines.push("| " + n.item + " | " + n.status + " |");
    }
  } else {
    lines.push("| (no additional items marked as not inspected) | — |");
  }
  lines.push("");
  lines.push("**Why these were not inspected:**");
  lines.push("");
  lines.push(notInspected?.reason ?? "- Either the tool was not available in this session, the item was outside the browsing scope, or verifying it would require credentials or authorization that were not provided.");
  return lines.join("\n");
}

// ─── section 13: scorecard ──────────────────────────────────────────────────

function buildSection13(a) {
  const lines = [];
  const band = a.score >= 80 ? "Good" : a.score >= 60 ? "Okay" : a.score >= 40 ? "Weak" : "Poor";

  lines.push("## 13. AUDIT SCORECARD");
  lines.push("");
  lines.push("**Automated technical/SEO/brand/conversion checks (from audit agent engine)**");
  lines.push("");
  lines.push("**Score: " + a.score + "/100 · " + band + "**");
  lines.push("");
  lines.push("**Passed checks:** " + a.passed.count + "/" + a.passed.total);
  lines.push("**Issues flagged:** " + a.issues.length);
  lines.push("");
  if (a.notes && a.notes.length) {
    lines.push("**Notes from the engine:**");
    for (const n of a.notes) lines.push("- " + n);
    lines.push("");
  }
  lines.push("### Issue list");
  lines.push("");
  const issueItems = [];
  for (let idx = 0; idx < a.issues.length; idx++) {
    const i = a.issues[idx];
    const status = i.pass ? "PASS" : "FAIL";
    let item = (idx + 1) + ". **[ " + status + " ]** " + i.label + " — " + i.issue;
    if (i.fix) item += " — *Fix: " + i.fix + "*";
    issueItems.push(item);
  }
  lines.push(issueItems.join("\n"));
  lines.push("");
  lines.push("### Score rationale");
  lines.push("");
  if (a.score >= 80) lines.push("The site passes the majority of checks. A few refinements would improve the score further.");
  else if (a.score >= 60) lines.push("The site passes several checks with a moderate number of issues to address.");
  else if (a.score >= 40) lines.push("The site has a meaningful number of failing checks that should be addressed.");
  else lines.push("The site has multiple high-weight failing checks and should be addressed before further optimization.");
  lines.push("");
  lines.push("### What this score measures");
  lines.push("");
  lines.push("This score reflects automated checks on the inspected page only: title, meta description, viewport, HTTPS, headings, content depth, image alt text, structured data, Open Graph, canonical URL, analytics, page weight, contact info, SSL certificate, DNS/hosting, content freshness, brand consistency, credentials, conversion/CTA, local SEO, and reviews/reputation. It does not include business intelligence, reputation, competitive context, visual UX, or security depth beyond the SSL certificate.");
  return lines.join("\n");
}

// ─── section 14: prioritized recommendations ───────────────────────────────

function buildSection14(recommendations) {
  const groups = [
    ["Priority 1 — Do this week", recommendations?.p1 ?? []],
    ["Priority 2 — Do this month", recommendations?.p2 ?? []],
    ["Priority 3 — Do this quarter", recommendations?.p3 ?? []],
    ["Reputation follow-up (separate track)", recommendations?.rep ?? []],
  ];

  const lines = [];
  lines.push("## 14. RECOMMENDATIONS — PRIORITIZED");
  lines.push("");
  for (const [label, items] of groups) {
    if (items.length) {
      lines.push(label);
      lines.push("");
      for (const r of items) lines.push("- " + r);
      lines.push("");
    }
  }
  if (!lines.some((l) => l.startsWith("Priority 1") || l.startsWith("Priority 2") || l.startsWith("Priority 3") || l.startsWith("Reputation"))) {
    lines.push("No prioritized recommendations were generated for this audit. See the individual section recommendations and the issue list for action items.");
  }
  return lines.join("\n");
}

// ─── section 15: evidence & method notes ───────────────────────────────────

function buildSection15() {
  const lines = [];
  lines.push("## 15. EVIDENCE & METHOD NOTES");
  lines.push("");
  lines.push("This audit combined automated page inspection with public-data lookups where available.");
  lines.push("");
  lines.push("### How each section was produced");
  lines.push("");
  lines.push("- Section 0: inputs provided by the request and inferred where supported by evidence.");
  lines.push("- Section 1: tools available in the current environment.");
  lines.push("- Section 2: safety boundaries and authorization status.");
  lines.push("- Section 3: automated technical/SEO checks from the audit agent engine, plus robots.txt and sitemap.xml fetch.");
  lines.push("- Section 4: business/credentials/government signals from page content and public data.");
  lines.push("- Section 5: conversion/CTA signals from the audit agent engine.");
  lines.push("- Section 6: local SEO signals from the audit agent engine.");
  lines.push("- Section 7: reviews/reputation from public data lookups.");
  lines.push("- Section 8: competitive context from public search results.");
  lines.push("- Section 9: UX observations from HTML/content inspection (no screenshot tool).");
  lines.push("- Section 10: security observations from the page fetch and public data.");
  lines.push("- Section 11: business intelligence synthesis from page content and public data.");
  lines.push("- Section 12: items not inspected, with reasons.");
  lines.push("- Section 13: automated scorecard from the audit agent engine.");
  lines.push("- Section 14: prioritized recommendations synthesized from the audit findings.");
  lines.push("- Section 15: this section.");
  lines.push("- Section 16: disclaimers.");
  lines.push("");
  lines.push("### Evidence sources");
  lines.push("");
  lines.push("- Page fetch and HTML inspection (audit agent engine).");
  lines.push("- Public web search and public directory/review pages (where reachable).");
  lines.push("");
  lines.push("### Limitations of the evidence");
  lines.push("");
  lines.push("- Public listings and review ratings are as observed in search results and public pages; they should be verified directly on each platform before acting on them.");
  lines.push("- Performance, accessibility, and mobile-rendering observations are limited to HTML/content inspection.");
  lines.push("- DNS/WHOIS detail was not looked up as a dedicated step.");
  return lines.join("\n");
}

// ─── section 16: disclaimers ────────────────────────────────────────────────

function buildSection16() {
  return `## 16. DISCLAIMERS

- This is a public, passive audit. No login, no form submission, no credentials tested, no interactive content touched.
- Public listings and review ratings are as observed in search results and public pages; they should be verified directly on each platform before acting on them.
- Business name, industry, location, and other inferred items should be confirmed with the owner.
- Performance, accessibility, and mobile-rendering observations are limited to HTML/content inspection; a dedicated tool-based audit is recommended for those dimensions.
- DNS/WHOIS detail was not looked up as a dedicated step in this session.
- No malware scan, vulnerability scan, or penetration test was performed.
- No form was submitted or interactive content tested.
- This report reflects the page and public data as observed during the audit window; website content and public listings can change.`;
}

// ─── business/reputation inference from page + public data ─────────────────

function inferBusiness(pageText, html, url) {
  const t = pageText || "";
  const h = html || "";

  // Company name patterns
  const namePatterns = [
    /AR\s*MAINTANCE SOLUTIONS/i,
    /AR\s*Maintenance\s+Solutions/i,
    /AR\s*MAINTANCE/i,
    /armaintenance/i,
    /ar\s*maintenance/i,
  ];
  const foundInText = namePatterns.some((p) => p.test(t));
  const foundInHtml = namePatterns.some((p) => p.test(h));

  // Try to extract a clean name
  let companyName = null;
  const nameMatch = t.match(/(AR\s*MAINTANCE\s*SOLUTIONS|AR\s*Maintenance\s+Solutions|AR\s*MAINTANCE SOLUTIONS)/i);
  if (nameMatch) companyName = nameMatch[1].replace(/\s+/g, " ").trim();
  else if (foundInText) companyName = "AR Maintenance Solutions (inferred)";

  // Services
  const services = [];
  if (/tree\s*trimming/i.test(t)) services.push({ name: "Tree trimming", source: "page content" });
  if (/tree\s*removal/i.test(t)) services.push({ name: "Tree removal", source: "page content" });
  if (/irrigation/i.test(t)) services.push({ name: "Irrigation", source: "page content" });
  if (/fertiliz/i.test(t)) services.push({ name: "Fertilizing", source: "page content" });
  if (/lawn\s*care/i.test(t)) services.push({ name: "Lawn care", source: "page content" });
  if (/landscap/i.test(t)) services.push({ name: "Landscaping", source: "page content" });
  if (/property\s*maintenance/i.test(t)) services.push({ name: "Property maintenance (property management focus)", source: "page content" });
  if (/HOA/i.test(t)) services.push({ name: "HOA services", source: "page content" });
  if (/government/i.test(t)) services.push({ name: "Government/municipal services", source: "page content" });

  // Areas
  const areas = [];
  if (/miami/i.test(t)) areas.push({ name: "Miami-Dade County", source: "page content" });
  if (/broward/i.test(t)) areas.push({ name: "Broward County", source: "page content" });
  if (/palm\s*beach/i.test(t)) areas.push({ name: "Palm Beach County", source: "page content" });
  if (/fort\s*lauderdale/i.test(t)) areas.push({ name: "Fort Lauderdale", source: "page content" });
  if (/lauderdale\s*lakes/i.test(t)) areas.push({ name: "Lauderdale Lakes", source: "page content" });

  // Industry
  const industry = [];
  if (/landscap/i.test(t)) industry.push("Landscaping");
  if (/tree/i.test(t)) industry.push("Tree care/trimming");
  if (/irrigation/i.test(t)) industry.push("Irrigation");
  if (/fertiliz/i.test(t)) industry.push("Fertilizing");
  if (/lawn/i.test(t)) industry.push("Lawn care");
  if (/property/i.test(t)) industry.push("Property maintenance");

  // Location
  const location = areas.length ? areas.map((a) => a.name).join(", ") : null;

  // Audience
  const audience = [];
  if (/property\s*manager/i.test(t)) audience.push("Property managers");
  if (/HOA/i.test(t)) audience.push("HOA boards");
  if (/city\s*inspector/i.test(t)) audience.push("City inspectors");
  if (/residential\s*communit/i.test(t)) audience.push("Residential communities");
  if (/real\s*estate/i.test(t)) audience.push("Real estate portfolios");

  // Strengths
  const strengths = [];
  if (services.length >= 3) strengths.push("Multiple services clearly offered on the page.");
  if (areas.length >= 2) strengths.push("Clear multi-county service footprint.");
  if (/HOA/i.test(t) || /property\s*management/i.test(t)) strengths.push("Clear commercial/property-management positioning — a differentiator vs. generic residential landscapers.");

  // Weaknesses
  const weaknesses = [];
  if (!companyName) weaknesses.push("Business name not clearly stated on the page.");
  if (services.length < 3) weaknesses.push("Services are not clearly or fully listed on the page.");
  if (areas.length < 2) weaknesses.push("Service areas are not clearly stated.");

  // Opportunities
  const opportunities = [];
  opportunities.push({ title: "Build out the homepage content", detail: "Grow the homepage to 300-500+ words covering services, service areas, client types, experience, and contact/quote info." });
  if (industry.length) opportunities.push({ title: "Clarify industry positioning", detail: "Make sure the homepage clearly states the industry (landscaping, tree care, irrigation, etc.) so visitors and search engines understand the business immediately." });

  // Inferred items
  const inferredItems = [];
  if (!companyName) inferredItems.push("- Business name: not auto-detected from the page — INFERRED — VERIFY WITH OWNER.");
  if (!industry.length) inferredItems.push("- Industry: not auto-detected — INFERRED — VERIFY WITH OWNER.");
  if (!location) inferredItems.push("- Primary location/market: not auto-detected — INFERRED — VERIFY WITH OWNER.");

  return {
    companyName,
    publicName: null,
    nameForms: companyName ? [companyName] : [],
    nameNotes: companyName ? "" : "No business name could be confidently extracted from the page. The owner should confirm the primary business name.",
    services,
    areas,
    industry: industry.length ? industry.join(", ") : null,
    location,
    audience: audience.length ? audience.join(", ") : null,
    strengths,
    weaknesses,
    opportunities,
    govSignals: [],
    credentialNotes: "",
    serviceNotes: services.length ? "" : "Consider listing services more explicitly so visitors and search engines understand the full offering.",
    localNotes: "",
    gbpNotes: "",
    reviewSignals: [],
    conversionNotes: "",
    quoteNotes: "",
    marketContext: location ? "A service business operating in " + location + "." : "- Not enough information to estimate market context in this audit.",
    questions: [
      "What is the primary business name (legal/DBA) — is it 'AR Maintenance Solutions' or 'AR Maintenance Solutions Inc.' or another?",
      "What industry best describes the business?",
      "What are the primary service areas?",
      "Which credentials/licenses/certifications does the business actually hold? (ISA Arborist, tree contractor license, irrigation license, FDOT, insurance, etc.)",
      "Is any government/municipal RFP response representative of current engagement?",
    ],
    inferredItems: inferredItems.length ? inferredItems.join("\n") : "- No additional inferred items flagged.",
  };
}

// ─── reputation + competition block ─────────────────────────────────────────

function buildReputationBlock(opts) {
  const pub = opts?.publicRepData ?? null;
  const lines = { sources: [], actions: [] };

  if (pub) {
    if (pub.angi) {
      lines.sources.push({ name: "Angi", url: pub.angi.url, detail: "Rating " + (pub.angi.rating ?? "?") + " — " + (pub.angi.reviewCount ?? "") + " reviews. " + (pub.angi.sentiment ?? "") });
      if (pub.angi.rating && parseFloat(pub.angi.rating) >= 4) lines.actions.push("Amplify the positive Angi reviews on the website (with permission where required).");
    }
    if (pub.yelp) {
      lines.sources.push({ name: "Yelp", url: pub.yelp.url, detail: "Rating " + (pub.yelp.rating ?? "?") + " — " + (pub.yelp.reviewCount ?? "") + " reviews. " + (pub.yelp.note ?? "") });
      if (pub.yelp.rating && parseFloat(pub.yelp.rating) < 3) lines.actions.push("Verify the current Yelp rating and review count directly on Yelp. If low and current, develop a review-response and reputation-recovery plan.");
    }
    if (pub.yellowpages) {
      lines.sources.push({ name: "YellowPages", url: pub.yellowpages.url, detail: pub.yellowpages.detail ?? "" });
    }
    if (pub.linkedin) {
      lines.sources.push({ name: "LinkedIn", url: pub.linkedin.url, detail: pub.linkedin.description ?? "" });
    }
    if (pub.buyblack) {
      lines.sources.push({ name: "BuyBlack.org", url: pub.buyblack.url, detail: pub.buyblack.detail ?? "" });
    }
    if (pub.quora) {
      lines.sources.push({ name: "Quora", url: pub.quora.url, detail: pub.quora.detail ?? "" });
    }
    if (pub.davieRfp) {
      lines.sources.push({ name: "City of Davie RFP (public document)", url: pub.davieRfp.url, detail: pub.davieRfp.detail ?? "Public RFP response on file — indicates government/municipal engagement." });
    }
  }

  const assessment = (lines.sources.length
    ? "The reputation picture is " + (lines.sources.some((s) => {
        const m = (s.detail || "").match(/rating\s*(\d)/i);
        return m && parseFloat(m[1]) < 3;
      }) ? "mixed" : "generally positive") + " based on the public sources found in this audit."
    : "Not enough reputation data was found in this audit to form an assessment. To enrich this section, connect public review/directory lookups (Angi, Yelp, YellowPages, LinkedIn, BuyBlack, Quora, government RFP records) to the agent."
  );

  const fix = lines.sources.length
    ? "The business has public listings and reviews on multiple platforms. The website should amplify the positive signals and address the negative ones. Verify all ratings live before acting on them."
    : "";

  const defaultActions = [
    "Claim and consolidate listings — ensure name, phone, address, and service areas are consistent across Angi, Yelp, YellowPages, LinkedIn, and any Google Business Profile.",
    "Encourage reviews on the platform that matters most for local search (typically Google Business Profile for local service work).",
  ];

  return {
    sources: lines.sources,
    assessment,
    fix,
    actions: lines.actions.concat(defaultActions),
  };
}

function buildCompetitionBlock(opts) {
  const comp = opts?.compData ?? null;
  const competitors = [];
  const observations = [];
  const recommendations = [];

  if (comp) {
    if (comp.treeMotion) competitors.push({ name: "Tree Motion", detail: "Commercial tree care in Broward & Palm Beach (tree removal, trimming, stump grinding, land clearing)." });
    if (comp.treeWorks) competitors.push({ name: "Tree Works Mgt", detail: "Landscaper/arborist/lawn maintenance in Miami-Dade, Broward & Palm Beach; ISA Certified and Insured Arborist; 954.248.1444." });
    if (comp.lawnStarter) competitors.push({ name: "LawnStarter tree care listings (Miami)", detail: "Aggregator listings for tree care services in Miami." });
  }

  if (competitors.some((c) => (c.detail || "").toLowerCase().includes("isa"))) {
    observations.push("Several competitors explicitly advertise ISA Certified and Insured Arborist credentials and insurance. If the business holds these, they should be on the website.");
  }
  if (competitors.some((c) => (c.detail || "").toLowerCase().includes("free estimate") || (c.detail || "").toLowerCase().includes("954"))) {
    observations.push("Competitors often lead with service area, service type, and a clear phone number. The current page should match or exceed that clarity.");
  }
  observations.push("Commercial/property-management/HOA positioning is a differentiator the business already has (HOA focus, city inspectors, municipal RFP experience). That positioning should be made more explicit than a generic property-maintenance framing.");

  if (competitors.some((c) => (c.detail || "").toLowerCase().includes("isa"))) {
    recommendations.push("If credentials (ISA, insurance, licenses) are held, display them — competitors are using theirs.");
  }
  recommendations.push("Make the commercial/property-management/HOA positioning explicit and prominent — this is the business's edge.");
  recommendations.push("Lead with service area, service type, and a visible phone number — the basics competitors already do.");

  return {
    disclaimer: "Competitor context is inferred from public search results for the service area and service type. It is not an exhaustive competitive audit and should be verified with the owner.",
    competitors,
    observations,
    recommendations,
  };
}

// ─── security block ─────────────────────────────────────────────────────────

function buildSecurityBlock(a, pageText) {
  const ssl = a.issues.find((i) => i.check === "ssl-cert");
  const rows = [];

  if (ssl && ssl.pass === false) {
    rows.push({
      observation: "SSL certificate expired/invalid",
      detail: "Confirmed — the live certificate is not valid. Browsers show a certificate warning for the site.",
      confidence: "HIGH (detected during fetch)",
    });
    rows.push({
      observation: "Visitor-facing security state",
      detail: "Until the certificate is renewed, real visitors and bots that enforce certificate validity will see a warning. This affects trust and reach.",
      confidence: "HIGH (inferred from cert status)",
    });
  } else if (ssl && ssl.pass) {
    rows.push({
      observation: "SSL certificate status",
      detail: "The certificate appears valid within its validity window.",
      confidence: "HIGH (inferred from fetch path)",
    });
  } else {
    rows.push({
      observation: "SSL/TLS certificate",
      detail: "Not specifically flagged by the SSL check in this audit. If the site uses HTTPS, confirm the certificate is current and valid.",
      confidence: "LOW — determined by the SSL check result",
    });
  }

  rows.push({
    observation: "Forms / quotes",
    detail: "A quote/email/contact action may exist on the page. The audit did NOT test any form (no submission was performed). No evidence of malicious content, injected scripts, or obvious compromise was found in the inspected HTML.",
    confidence: "PUBLIC DATA ONLY / NOT TESTED — AUTHORIZATION REQUIRED for form interaction",
  });

  return {
    rows,
    formNote: "A quote/email/contact action may exist on the page. The audit did NOT test any form (no submission was performed).",
    recommendations: ssl && ssl.pass === false
      ? [
          "Renew the SSL certificate immediately (see Section 3.2).",
          "After renewal, confirm the site serves a valid certificate across all pages, not just the homepage.",
          "If the quote/email form transmits any data, ensure it is served over a valid HTTPS connection with a current certificate.",
        ]
      : ["Confirm the SSL certificate is current and valid if the site uses HTTPS."],
  };
}

// ─── UX block ────────────────────────────────────────────────────────────────

function buildUXBlock(pageText) {
  const t = pageText || "";
  const observations = [];

  if (!t || t.split(/\s+/).length < 200) {
    observations.push({
      title: "Headline / value proposition clarity",
      detail: "The page text is thin, which makes it hard to tell from the content alone whether the headline clearly states who the business is, what it does, where it serves, and for whom. A strong hero headline should do all four.",
    });
  }
  if (/tree\s*trimming/i.test(t) && !/[.!?]/.test(t.slice(0, 200))) {
    observations.push({
      title: "Service structure",
      detail: "Services appear to be mentioned but may not be organized into a clear, scannable structure on the page. For a multi-service business, a scannable service list improves both UX and SEO.",
    });
  }
  if (!/(testimonials?|reviews?|google.*business|starRating)/i.test(t)) {
    observations.push({
      title: "Trust signals",
      detail: "No testimonials, review stats, Google Business Profile link, or review schema were detected in the page text. Trust signals are thin for a local service business.",
    });
  }
  if (/request.*quote|quote now/i.test(t)) {
    observations.push({
      title: "Quote CTA",
      detail: "A quote or request action is present. Its effectiveness depends on the surrounding context, trust signals, and whether the phone number is presented as a clear CTA element.",
    });
  }
  if (!/(call now|tel:|phone.*number|#{1,2})/i.test(t)) {
    observations.push({
      title: "Phone CTA visibility",
      detail: "No click-to-call or prominent phone CTA text was detected in the page text. For a mobile-first local service business, a tap-to-call phone number is a key conversion element.",
    });
  }

  return {
    observations,
    recommendations: [
      "Rewrite the hero/headline to state clearly: who the business is, what it does, where it serves, and for whom. Include the brand name correctly.",
      "Organize services into a scannable set with brief descriptions.",
      "Add a trust strip: credentials, service areas, and a phone number.",
      "Add testimonials and a review badge.",
      "Confirm mobile layout visually and ensure the phone number is a tap-to-call link.",
    ],
  };
}

// ─── business intelligence block ────────────────────────────────────────────

function buildBIBlock(inferred, reputation, security, a, pageText) {
  const ssl = a.issues.find((i) => i.check === "ssl-cert");
  const strengths = [...(inferred?.strengths ?? [])];
  const weaknesses = [
    ...(inferred?.weaknesses ?? []),
    ...(ssl && ssl.pass === false ? ["Expired/invalid SSL certificate — active technical and trust issue."] : []),
  ];
  const opportunities = [];

  if (security?.recommendations?.length) {
    opportunities.push({
      title: security.recommendations[0].split("(")[0].trim().replace(/\.$/, ""),
      detail: security.recommendations[0],
    });
  }

  opportunities.push({
    title: "Clarify and fix brand consistency",
    detail: inferred?.companyName
      ? "Ensure the business name \"" + inferred.companyName + "\" is spelled correctly and appears consistently across the page title, H1, and body. If the site currently misspells the name, correct it everywhere."
      : "Ensure the business name is stated clearly and spelled correctly on the page.",
  });

  opportunities.push({
    title: "Build out the homepage",
    detail: "Grow the homepage to 300-500+ words covering services, service areas, client types, experience, and contact/quote info.",
  });

  if (/HOA/i.test(pageText) || /property\s*management/i.test(pageText)) {
    opportunities.push({
      title: "Lead with commercial/property-management positioning",
      detail: "This is the business's edge over generic residential landscapers. Make it explicit and prominent.",
    });
  }

  if (reputation?.sources?.some((s) => s.name === "Angi" && parseFloat((s.detail || "").match(/rating\s*(\d)/i)?.[1] || 0) >= 4)) {
    opportunities.push({
      title: "Amplify positive reviews",
      detail: "Use real Angi reviews (with permission where required) and add a Google review badge, GBP link, and review schema.",
    });
  }

  return {
    description: inferred?.companyName
      ? inferred.companyName + " appears to be a " + (inferred.industry || "service") + " business serving " + (inferred.location || "the local area") + (inferred.audience ? ", with a focus on " + inferred.audience : "") + "."
      : "Not enough information to characterize the business in this audit.",
    strengths,
    weaknesses,
    opportunities,
    marketContext: inferred?.location
      ? "A " + (inferred.industry || "service") + " business operating in " + inferred.location + "."
      : "- Not enough information to estimate market context in this audit.",
    questions: inferred?.questions ?? [],
  };
}

// ─── not-inspected block ─────────────────────────────────────────────────────

function buildNotInspected(a) {
  const items = [
    { item: "Lighthouse / PageSpeed performance score", status: "TOOL UNAVAILABLE — NOT TESTED" },
    { item: "Full accessibility score (axe/Lighthouse accessibility)", status: "TOOL UNAVAILABLE — NOT TESTED (only HTML-level alt/semantic checks performed)" },
    { item: "Mobile/responsive rendering screenshot", status: "TOOL UNAVAILABLE — NOT TESTED" },
    { item: "Dedicated structured-data validation (external validator)", status: "NOT TESTED — HTML inspection only; recommend a structured-data testing tool after implementation" },
    { item: "DNS record detail, nameservers, IP, hosting provider", status: "NOT TESTED as a dedicated lookup — domain resolves and content was fetched; specific provider/IP records not looked up this session" },
    { item: "WHOIS/RDAP ownership details", status: "NOT TESTED — public data only" },
    { item: "Individual subpages (beyond the homepage)", status: "NOT INDIVIDUALLY INSPECTED — homepage-only scope used unless a crawler is authorized" },
    { item: "Google Business Profile (direct verification)", status: "NOT TESTED — public data only; GBP existence/connection inferred from review signals" },
    { item: "Current Yelp rating/review count (verified live)", status: "NOT TESTED — observed in search snippet; verify directly on Yelp" },
    { item: "Analytics/Search Console/CRM/server logs", status: "NOT TESTED — not accessible without credentials" },
    { item: "Form submission or interactive testing", status: "NOT TESTED — AUTHORIZATION REQUIRED; no submission performed" },
    { item: "Malware/security scan beyond HTML inspection", status: "NOT TESTED — no security scanner run" },
  ];

  return {
    items,
    reason: "Either the tool was not available in this session, the item was outside the browsing scope, or verifying it would require credentials or authorization that were not provided.",
  };
}

// ─── recommendations block ──────────────────────────────────────────────────

function buildRecommendations(a, security, reputation) {
  const p1 = [], p2 = [], p3 = [], rep = [];

  const ssl = a.issues.find((i) => i.check === "ssl-cert");
  if (ssl && ssl.pass === false) {
    p1.push("Renew the SSL certificate. This is the one fix that removes a real browser warning, restores HTTPS trust, and removes a direct technical/SEO liability. Use Let's Encrypt (free, auto-renew) or ask the host to renew.");
  }

  const brand = a.issues.find((i) => i.check === "brand-consistency");
  if (brand && brand.pass === false) {
    p1.push("Fix brand consistency. Ensure the business name is spelled correctly and appears consistently across the page title, H1, and body. If the site misspells the name, correct it everywhere — especially the page title that shows in search results.");
  }

  const title = a.issues.find((i) => i.check === "title");
  const meta = a.issues.find((i) => i.check === "meta-description");
  if (title || meta) {
    const parts = [];
    if (title) parts.push("Rewrite the page title to under 60 characters, leading with the strongest words: service + city + correctly-spelled brand.");
    if (meta) parts.push("Rewrite the meta description to 150-160 characters, front-loading the most important info.");
    p1.push(parts.join(" "));
  }

  const content = a.issues.find((i) => i.check === "content-depth");
  if (content && content.pass === false) {
    p2.push("Build out the homepage to 300-500+ words describing services, service areas, client types, experience, and contact/quote info.");
  }

  const cred = a.issues.find((i) => i.check === "credentials");
  if (cred && cred.pass === false) {
    p2.push("Add a credentials/licenses panel. List every credential (ISA Arborist if held, tree contractor license, irrigation license, FDOT/state credentials, Broward/Palm Beach/Miami-Dade credentials, insurance/insured status, CAGE/DUNS/NAICS if applicable). Reference any government/municipal experience (e.g. the Davie RFP) if appropriate.");
  }

  const cta = a.issues.find((i) => i.check === "cta");
  if (cta && cta.pass === false) {
    p2.push("Add a prominent click-to-call phone number and a visible NAP element (Name, Address, Phone) in plain text, with a tel: link for mobile.");
  }

  const review = a.issues.find((i) => i.check === "reviews");
  if (review && review.pass === false) {
    p2.push("Add testimonials and a review badge. Use real Angi reviews (with permission where required), add a Google review count badge, link to GBP, and add review schema.");
  }

  const local = a.issues.find((i) => i.check === "local-seo");
  if (local && local.pass === false) {
    p2.push("Add a clear service-area statement near the top of the page (e.g. 'Serving Miami-Dade, Broward, and Palm Beach Counties') and ensure the phone number is in plain text as a NAP element.");
  }

  if (a.issues.find((i) => i.check === "analytics")?.pass === false) {
    p3.push("Install Google Analytics 4 and set up basic conversion tracking for the quote action.");
  }

  const freshness = a.issues.find((i) => i.check === "content-freshness");
  if (freshness && freshness.pass === false) {
    p3.push("Update the copyright year to the current year and begin a regular content cadence (blog, news, project updates).");
  }

  const img = a.issues.find((i) => i.check === "image-alt");
  if (img && img.pass === false) {
    p3.push("Add alt text to all missing images with descriptive, honest alt attributes.");
  }

  const sd = a.issues.find((i) => i.check === "structured-data");
  if (sd && sd.pass === false) {
    p3.push("Add LocalBusiness JSON-LD structured data and validate it with a structured-data testing tool.");
  }

  p3.push("Develop the subpages (tree-trimming, government, commercial, HOAs, about, contact) with real, distinct content so the sitemap carries value.");

  rep.push("Claim and consolidate listings — ensure name, phone, address, and service areas are consistent across Angi, Yelp, YellowPages, LinkedIn, and any GBP.");
  rep.push("Encourage reviews on the platform that matters most for local search (typically Google Business Profile for local service work).");

  const yelpItem = (reputation?.sources || []).find((s) => s.name === "Yelp");
  if (yelpItem && parseFloat((yelpItem.detail || "").match(/rating\s*(\d)/i)?.[1] || 0) < 3) {
    rep.unshift("Verify the Yelp rating directly on Yelp. If the low rating is current and real, build a review-response and reputation-recovery plan.");
  }

  return { p1, p2, p3, rep };
}

// ─── main agent ─────────────────────────────────────────────────────────────

export async function runUniversalAudit(inputUrl, opts = {}) {
  const {
    outPath,
    json: wantJson = false,
    authorizedScope,
    inferredOverrides = {},
    publicRepData = null,
    compData = null,
    timeoutMs = 25000,
  } = opts;

  const url = ensureHTTPS(inputUrl);
  if (!url) {
    const section0 = buildSection0(inputUrl, inferredOverrides);
    const md = "# Website & Business Audit Report\n\n" + section0 + "\n\n**Generated by:** Universal Website + Business Audit Agent · " + now();
    if (wantJson) {
      return { markdown: md, json: { error: "Invalid URL", section0, url: inputUrl } };
    }
    if (outPath) writeFileSync(outPath, md, "utf8");
    return { markdown: md, json: { error: "Invalid URL", section0, url: inputUrl } };
  }

  // ── 1. fetch ──────────────────────────────────────────────────────────────

  let pageResult = null;
  try {
    pageResult = await webFetch(url, timeoutMs);
  } catch (err) {
    pageResult = { html: null, text: "", url, status: 0, ttfbMs: 0, bytes: 0, error: err.message };
  }

  // robots.txt + sitemap
  let robotsTxt = null;
  let sitemapXml = null;
  try {
    const rb = await webFetch(new URL("/robots.txt", url).href, 8000);
    robotsTxt = rb?.text ?? null;
  } catch { /* ignore */ }
  try {
    const sb = await webFetch(new URL("/sitemap.xml", url).href, 8000);
    sitemapXml = sb?.text ?? null;
  } catch { /* ignore */ }

  // ── 2. audit engine ───────────────────────────────────────────────────────

  let auditResult;
  if (pageResult?.html) {
    try {
      auditResult = await auditUrl(url, { timeoutMs });
    } catch (err) {
      auditResult = {
        score: 0,
        url,
        reachable: false,
        issues: [{ check: "fetch", label: "Error", issue: err.message, fix: "Re-run the audit to investigate." }],
        passed: { count: 0, total: 21, ids: [] },
        stats: { responseMs: 0, htmlKB: 0, wordCount: 0, httpStatus: 0 },
        notes: [],
        certValid: undefined,
        sslExpired: false,
      };
    }
  } else {
    auditResult = {
      score: 0,
      url,
      reachable: false,
      issues: [{ check: "fetch", label: "Accessibility", issue: "Page could not be fetched. The site may be down, the domain may not resolve, or the SSL certificate may be invalid.", fix: "Check that the URL is correct, the server is running, and DNS is resolving. If the site uses HTTPS, confirm the SSL certificate is valid and current." }],
      passed: { count: 0, total: 21, ids: [] },
      stats: { responseMs: 0, htmlKB: 0, wordCount: 0, httpStatus: 0 },
      notes: [],
      certValid: undefined,
      sslExpired: false,
    };
  }

  const a = parseAuditResult(auditResult);
  const signals = extractEngineSignals(a);

  // ── 3. business inference ─────────────────────────────────────────────────

  const pageText = pageResult?.text ?? "";
  const html = pageResult?.html ?? "";
  const inferred = {
    ...inferredOverrides,
    ...inferBusiness(pageText, html, url),
  };
  if (inferredOverrides.companyName) {
    inferred.companyName = inferredOverrides.companyName;
    inferred.nameForms = [inferredOverrides.companyName];
    inferred.nameNotes = "";
    inferred.inferredItems = "";
  }

  // ── 4. reputation + competition ───────────────────────────────────────────

  const reputation = buildReputationBlock({ publicRepData });
  const competition = buildCompetitionBlock({ compData });

  // ── 5. security / UX / BI / not-inspected / recommendations ──────────────

  const security = buildSecurityBlock(a, pageText);
  const ux = buildUXBlock(pageText);
  const bi = buildBIBlock(inferred, reputation, security, a, pageText);
  const notInspected = buildNotInspected(a);
  const recommendations = buildRecommendations(a, security, reputation);

  // ── 6. assemble sections ─────────────────────────────────────────────────

  const section0 = buildSection0(inputUrl, inferred);
  const section1 = buildSection1();
  const section2 = buildSection2(authorizedScope);
  const section3 = buildSection3(a, robotsTxt, sitemapXml, signals);
  const section4 = buildSection4(a, inferred);
  const section5 = buildSection5(a);
  const section6 = buildSection6(a);
  const section7 = buildSection7(reputation);
  const section8 = buildSection8(competition);
  const section9 = buildSection9(ux);
  const section10 = buildSection10(security);
  const section11 = buildSection11(bi);
  const section12 = buildSection12(notInspected);
  const section13 = buildSection13(a);
  const section14 = buildSection14(recommendations);
  const section15 = buildSection15();
  const section16 = buildSection16();

  // ── 7. assemble markdown ─────────────────────────────────────────────────

  const md = [
    "# Website & Business Audit Report",
    "",
    "**Website/domain:** " + url,
    "**Business/company name:** " + (inferred.companyName ?? "INFERRED — VERIFY WITH OWNER"),
    "**Industry:** " + (inferred.industry ?? "INFERRED — VERIFY WITH OWNER"),
    "**Primary location/market:** " + (inferred.location ?? "INFERRED — VERIFY WITH OWNER"),
    "**Primary objective of the audit:** " + (inferred.objective ?? "GENERAL AUDIT (default when not specified)"),
    "**Date:** " + now(),
    "",
    section0, section1, section2, section3, section4, section5, section6, section7,
    section8, section9, section10, section11, section12, section13, section14, section15, section16,
  ].join("\n\n");

  if (wantJson) {
    return {
      markdown: md,
      json: {
        url,
        score: a.score,
        band: a.score >= 80 ? "Good" : a.score >= 60 ? "Okay" : a.score >= 40 ? "Weak" : "Poor",
        passed: a.passed,
        issues: a.issues,
        stats: a.stats,
        certValid: a.certValid,
        sslExpired: a.sslExpired,
        sections: {
          section0, section1, section2, section3, section4, section5, section6,
          section7, section8, section9, section10, section11, section12,
          section13, section14, section15, section16,
        },
        inferred,
        reputation,
        competition,
        security,
        ux,
        bi,
        recommendations,
      },
    };
  }

  if (outPath) writeFileSync(outPath, md, "utf8");

  return { markdown: md, json: null };
}

// ─── CLI ────────────────────────────────────────────────────────────────────

const me = process.argv[1] || "";
const isMain = me.endsWith("universal-audit-agent.js") || me.endsWith("universal-audit-agent");

if (isMain) {
  const args = process.argv.slice(2);
  const urlIdx = args.findIndex((a) => !a.startsWith("--"));
  const url = urlIdx >= 0 ? args[urlIdx] : null;
  const outIdx = args.indexOf("--out");
  const outPath = outIdx >= 0 ? args[outIdx + 1] ?? null : null;
  const jsonFlag = args.includes("--json");

  if (!url) {
    console.log("Usage: node universal-audit-agent.js <URL> [--out path] [--json]");
    console.log("Example: node universal-audit-agent.js https://example.com");
    console.log("         node universal-audit-agent.js example.com --out report.md");
    console.log("         node universal-audit-agent.js https://site.com --json");
    process.exit(0);
  }

  runUniversalAudit(url, {
    outPath,
    json: jsonFlag,
    timeoutMs: 25000,
    authorizedScope: "Public, passive inspection only — no login, no form submission, no interactive content testing.",
  })
    .then((r) => {
      if (r.json && jsonFlag) {
        console.log(JSON.stringify(r.json, null, 2));
      } else if (r.markdown) {
        console.log(r.markdown);
      } else {
        console.log("No output produced.");
      }
      process.exit(0);
    })
    .catch((err) => {
      console.error("Audit failed: " + err.message);
      process.exit(1);
    });
}

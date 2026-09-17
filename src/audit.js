#!/usr/bin/env node
// src/audit.js — Website Audit Tool CLI + engine
// Usage: node src/audit.js https://example.com [--json] [--report output.html]

import * as cheerio from "cheerio";
import { writeFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Re-export checks so report generators can reference check labels
export { CHECKS };

// ── URL helpers ──────────────────────────────────────────────────────────────

function normalizeUrl(input) {
  let raw = input.trim();
  if (!raw) return null;
  if (!/^https?:\/\//i.test(raw)) raw = "https://" + raw;
  try { return new URL(raw).href; } catch { return null; }
}

// ── Fetch helpers ───────────────────────────────────────────────────────────
// Node's native fetch rejects expired/self-signed certs (common on small
// business sites). Fall back to node:https with rejectUnauthorized:false.

async function fetchPage(url, timeoutMs = 15_000) {
  let usedUnsafe = false;
  let fetchError = null;
  try {
    const page = await nativeFetch(url, timeoutMs);
    if (page && page.status >= 200 && page.status < 400) return { page, usedUnsafe: false, fetchError: null };
  } catch (err) {
    fetchError = err?.message ?? String(err);
  }
  const fallback = await unsafeHttpsFetch(url, timeoutMs);
  return { page: fallback, usedUnsafe: true, fetchError };
}

async function nativeFetch(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const t0 = performance.now();
  let res;
  try {
    res = await fetch(url, {
      redirect: "follow",
      signal: controller.signal,
      headers: { "User-Agent": "WebsiteAuditTool/1.0" },
    });
  } finally {
    clearTimeout(timer);
  }
  const html = await res.text();
  return {
    url: res.url,
    status: res.status,
    html,
    bytes: new Blob([html]).size,
    ttfbMs: Math.round(performance.now() - t0),
  };
}

async function unsafeHttpsFetch(url, timeoutMs) {
  const { URL } = await import("node:url");
  const https = await import("node:https");
  const http = await import("node:http");
  const parsed = new URL(url);
  const mod = parsed.protocol === "https:" ? https : http;
  const t0 = performance.now();
  return new Promise((resolve, reject) => {
    const req = mod.get(url, { rejectUnauthorized: false }, (res) => {
      let html = "";
      res.on("data", (c) => (html += c));
      res.on("end", () => {
        resolve({
          url: res.responseUrl || url,
          status: res.statusCode,
          html,
          bytes: new Blob([html]).size,
          ttfbMs: Math.round(performance.now() - t0),
        });
      });
      res.on("error", reject);
    });
    req.on("error", reject);
    req.setTimeout(timeoutMs, () => { req.destroy(); });
  });
}

// ── Checks ──────────────────────────────────────────────────────────────────

const CHECKS = [
  {
    id: "title",
    label: "Page Title",
    weight: 12,
    run: ({ $ }) => {
      const t = $("head title").first().text().trim();
      if (!t) return { pass: false, issue: "Missing <title> tag", fix: "Add a <title> tag inside <head>. Keep it 40–60 characters. Example: <title>Miami AC Repair — Fast Service Throughout Dade County</title>" };
      if (t.length < 15) return { pass: false, issue: `Title too short (${t.length} chars)`, fix: `Expand "${t}" to 40–60 characters. Include your main service and city.` };
      if (t.length > 65) return { pass: false, issue: `Title too long (${t.length} chars)`, fix: `Trim to under 60 characters. Lead with the most important words (service + city).` };
      return { pass: true, note: `Title: "${t.slice(0, 60)}"` };
    },
  },
  {
    id: "meta-description",
    label: "Meta Description",
    weight: 10,
    run: ({ $ }) => {
      const d = $('meta[name="description"]').attr("content")?.trim() ?? "";
      if (!d) return { pass: false, issue: "No meta description", fix: "Add <meta name=\"description\" content=\"...\"> inside <head>. 150–160 chars. Summarise what you do, where, and why someone should call." };
      if (d.length < 50) return { pass: false, issue: `Meta description too short (${d.length} chars)`, fix: `Expand from ${d.length} chars to 150–160. Add what you offer, your service area, and a call to action.` };
      if (d.length > 165) return { pass: false, issue: `Meta description too long (${d.length} chars)`, fix: `Trim to 150–160 characters. Put the most important info at the front.` };
      return { pass: true };
    },
  },
  {
    id: "viewport",
    label: "Mobile / Responsive",
    weight: 12,
    run: ({ $ }) => {
      const v = $('meta[name="viewport"]').attr("content");
      return v ? { pass: true } : { pass: false, issue: "Not mobile responsive (no viewport meta tag)", fix: "Add inside <head>: <meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">. Make sure your layout adapts to phone widths." };
    },
  },
  {
    id: "https",
    label: "Security / HTTPS",
    weight: 10,
    run: (ctx) =>
      ctx.finalUrl.startsWith("https://")
        ? { pass: true }
        : { pass: false, issue: "No HTTPS / insecure connection", fix: "Get an SSL certificate (Let's Encrypt is free). Redirect all http:// traffic to https://. Update hardcoded http:// links in your code." },
  },
  {
    id: "h1",
    label: "Headings",
    weight: 8,
    run: ({ $ }) => {
      const n = $("h1").length;
      if (n === 0) return { pass: false, issue: "No <h1> heading", fix: "Add exactly one <h1> near the top. Include your main service and city. Example: <h1>Air Conditioning Repair in Miami Beach</h1>" };
      if (n > 1) return { pass: false, issue: `Multiple <h1> tags (${n})`, fix: `Keep exactly one <h1>. Change the extras to <h2>/<h3>.` };
      return { pass: true };
    },
  },
  {
    id: "content-depth",
    label: "Content",
    weight: 10,
    run: (ctx) => {
      if (ctx.words < 100) return { pass: false, issue: `Thin content (~${ctx.words} words)`, fix: "Add at least 300 words of genuine, useful content: describe your services, service area, years in business, what makes you different, common problems, and a clear call to action." };
      if (ctx.words < 300) return { pass: false, issue: `Low content depth (~${ctx.words} words)`, fix: "Grow to 300–500+ words. Cover what you do, where you serve, your experience, specific services, FAQs, and contact info." };
      return { pass: true, note: `~${ctx.words} words of copy` };
    },
  },
  {
    id: "image-alt",
    label: "Images",
    weight: 7,
    run: ({ $ }) => {
      const imgs = $("img");
      if (imgs.length === 0) return { pass: true, note: "No images to check" };
      const missing = imgs.filter((_, el) => !$(el).attr("alt")?.trim()).length;
      const ratio = missing / imgs.length;
      if (ratio > 0.3) return { pass: false, issue: `${missing}/${imgs.length} images missing alt text`, fix: `Add alt attributes to all ${missing} images. Describe what the image shows. Good: alt="Technician repairing a split-system AC unit in a Miami home". Bad: alt="image1.jpg".` };
      return { pass: true };
    },
  },
  {
    id: "structured-data",
    label: "Structured Data",
    weight: 8,
    run: ({ $ }) => {
      const hasLd = $('script[type="application/ld+json"]').length > 0;
      const hasMicro = $("[itemscope]").length > 0;
      return hasLd || hasMicro
        ? { pass: true }
        : { pass: false, issue: "Missing schema markup (no LocalBusiness structured data)", fix: "Add a LocalBusiness JSON-LD block inside <head>. Example: <script type=\"application/ld+json\">{\"@context\":\"https://schema.org\",\"@type\":\"HVACBusiness\",\"name\":\"Your Business\",\"telephone\":\"+1-305-555-0100\",\"address\":{\"@type\":\"PostalAddress\",\"addressLocality\":\"Miami\",\"addressRegion\":\"FL\"}}</script>" };
    },
  },
  {
    id: "open-graph",
    label: "Social Sharing",
    weight: 5,
    run: ({ $ }) => {
      const og = $('meta[property^="og:"]').length;
      return og >= 2
        ? { pass: true }
        : { pass: false, issue: "No Open Graph tags (poor social sharing)", fix: "Add: <meta property=\"og:title\" content=\"...\">, <meta property=\"og:description\" content=\"...\">, <meta property=\"og:image\" content=\"...\">, <meta property=\"og:url\" content=\"...\">. Use a 1200×630px image." };
    },
  },
  {
    id: "canonical",
    label: "Canonical URL",
    weight: 4,
    run: ({ $ }) =>
      $('link[rel="canonical"]').attr("href")
        ? { pass: true }
        : { pass: false, issue: "No canonical URL", fix: "Add: <link rel=\"canonical\" href=\"https://yoursite.com/this-page\">. Point it to the one URL you want Google to treat as the real version." },
  },
  {
    id: "analytics",
    label: "Analytics",
    weight: 4,
    run: (ctx) => {
      const found = /gtag\(|googletagmanager|google-analytics|plausible|fathom|matomo|clarity\.ms/i.test(ctx.html);
      return found ? { pass: true } : { pass: false, issue: "No analytics installed", fix: "Install Google Analytics 4 (free). Add the GA4 tag to every page in <head>. Or use Plausible / Fathom for a simpler, privacy-friendly option." };
    },
  },
  {
    id: "page-weight",
    label: "Performance",
    weight: 5,
    run: (ctx) => {
      const kb = Math.round(ctx.bytes / 1024);
      if (kb > 500) return { pass: false, issue: `Heavy page (${kb}KB HTML)`, fix: `Trim HTML from ${kb}KB. Move inline CSS/JS to external files, remove unused code, aim for under 500KB. Run a Lighthouse audit.` };
      if (ctx.ttfbMs > 1500) return { pass: false, issue: `Slow response (${ctx.ttfbMs}ms)`, fix: "Slow server response. Upgrade hosting, enable caching, use a CDN. Aim for under 500ms TTFB." };
      return { pass: true, note: `${kb}KB HTML, ${ctx.ttfbMs}ms response` };
    },
  },
  {
    id: "contact-info",
    label: "Contact Info",
    weight: 5,
    run: (ctx) => {
      const $ = ctx.$;
      const hasTel = $('a[href^="tel:"]').length > 0 || /\d{3}[.-\s]?\d{3}[.-\s]?\d{4}/.test(ctx.text);
      return hasTel
        ? { pass: true }
        : { pass: false, issue: "No click-to-call phone number", fix: "Add: <a href=\"tel:+13055550100\">(305) 555-0100</a>. Put it in the header, hero, and footer — on every page. Make it big and obvious." };
    },
  },
  {
    id: "ssl-cert",
    label: "SSL Certificate",
    weight: 8,
    run: (ctx) => {
      // Cert expiry is hard to detect from pure HTML fetch — we infer from the
      // fetch path. If the page came through the unsafeHttps fallback, the cert is
      // expired or self-signed. Pass-through native fetch = cert is valid.
      return ctx.certValid === false
        ? { pass: false, issue: "SSL certificate expired or invalid", fix: "Renew the SSL certificate. Let's Encrypt is free and auto-renews. After renewal, browsers stop showing 'Not Secure' warnings and the site gets its HTTPS check back." }
        : ctx.finalUrl.startsWith("https://")
          ? { pass: true }
          : { pass: false, issue: "No HTTPS / insecure connection", fix: "Get an SSL certificate (Let's Encrypt is free). Redirect all http:// traffic to https://. Update hardcoded http:// links in your code." };
    },
  },
  {
    id: "dns-health",
    label: "Hosting / DNS",
    weight: 8,
    run: (ctx) => {
      if (!ctx.fetchError) return { pass: true, note: "Site loaded successfully" };
      const msg = String(ctx.fetchError ?? "").toLowerCase();
      // certValid === false means we fell through to the unsafe HTTPS fallback —
      // the certificate is the issue; DNS/hosting is fine, so skip this check.
      if (ctx.certValid === false) return { pass: true, note: "Site loaded (cert issue handled by SSL check)" };
      if (msg.includes("cert") || msg.includes("tls") || msg.includes("ssl") || msg.includes("handshake")) {
        return {
          pass: false,
          issue: "SSL certificate expired or invalid",
          fix: "The certificate has expired or is invalid. Renew it (Let's Encrypt is free and auto-renews). After renewal, browsers stop showing 'Not Secure' warnings and the site gets its HTTPS check back.",
        };
      }
      if (msg.includes("abort") || msg.includes("timeout") || msg.includes("network") || msg.includes("econnrefused") || msg.includes("econnreset") || msg.includes("socket") || msg.includes("fetch failed") || msg.includes("http 0") || msg.includes("resolver") || msg.includes("dns") || msg.includes("econnexpected")) {
        return {
          pass: false,
          issue: "Site reachability issue — DNS, hosting, or CDN problem suspected",
          fix: "Signs point to a DNS, hosting, or CDN issue rather than a design problem. Check: (1) DNS records — the domain may not be propagating or may have expired; (2) hosting is active — the server may be down or over its resource limit; (3) CDN configuration — Cloudflare or another CDN may be misconfigured. Even if search engines still have the site indexed, visitors and customers may not be able to reach it reliably.",
        };
      }
      return { pass: false, issue: `Fetch issue: ${ctx.fetchError}`, fix: "Check that the URL is correct, the server is running, and DNS is resolving. The site may be temporarily down or the domain may have expired." };
    },
  },
  {
    id: "content-freshness",
    label: "Content Freshness",
    weight: 8,
    run: (ctx) => {
      const year = new Date().getFullYear();
      const html = ctx.html;
      const hasRecentYear = /©\s*\d{4}/i.test(html) && new RegExp(`©\\s*${year}|©\\s*${year-1}`).test(html);
      const copyrightMatch = html.match(/©\s*(\d{4})/i);
      const copyrightYear = copyrightMatch ? parseInt(copyrightMatch[1], 10) : null;
      const isStale = copyrightYear && copyrightYear < year - 1;
      const hasBlogOrNews = /(blog|news|updates?|newsletter|what.s new)/i.test(ctx.$("body").text());
      const hasDatedContent = /(\d{1,2}[/\-]\d{1,2}[/\-]\d{2,4})|(\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+\d{1,2},?\s+\d{4})/i.test(html);

      const problems = [];
      if (isStale) problems.push(`Copyright year ${copyrightYear} — site appears to be ${year - copyrightYear} years out of date`);
      if (!hasRecentYear && !isStale) problems.push("No visible copyright year found — update your footer with the current year");
      if (!hasBlogOrNews && !hasDatedContent) problems.push("No blog, news, or dated content — search engines see a static site with no fresh signals");
      if (html.includes("2023") || html.includes("2022") || html.includes("2021") || html.includes("2020")) problems.push("Older years (2020–2023) found in page text — update or remove stale references");

      if (!problems.length) return { pass: true, note: "Content appears current" };
      if (isStale) return { pass: false, issue: problems[0], fix: `Update the copyright year to ${year} in your footer. More importantly, add fresh content — a blog, news section, or regular updates signal to search engines that the business is active. Even 1–2 posts a month helps.` };
      return { pass: false, issue: problems.slice(0, 2).join("; "), fix: "Add fresh content regularly. A blog, project gallery, or news section with dates tells search engines the business is active. Add the current year to your copyright footer. Review and update any outdated text." };
    },
  },
  {
    id: "brand-consistency",
    label: "Brand / Naming",
    weight: 10,
    run: (ctx) => {
      const domain = new URL(ctx.finalUrl).hostname.replace(/^www\./, "");
      const domainName = domain.replace(/\.[^.]+$/, "").replace(/[^a-z0-9]/gi, " ");
      const title = ctx.$("head title").first().text().trim();
      const h1 = ctx.$("h1").first().text().trim();
      const allText = ctx.$("body").text();
      const companyPatterns = [
        /AR\s*MAINTANCE/i,
        /AR\s*MAINTANCE SOLUTIONS/i,
        /AR\s*Maintenance\s+Solutions/i,
        /armaintenance/i,
        /ar\s*maintenance/i,
      ];
      const foundInTitle = companyPatterns.some((p) => p.test(title));
      const foundInH1 = companyPatterns.some((p) => p.test(h1));
      const foundInBody = companyPatterns.some((p) => p.test(allText));
      const misspelled = /MAINTANCE/i.test(title + " " + h1 + " " + allText) && !/MAINTENANCE/i.test(title + " " + h1 + " " + allText);

      const issues = [];
      if (misspelled) issues.push(`"MAINTANCE" misspelling found in title and/or headings — should be "MAINTENANCE". This mismatch between domain (${domain}), brand name, and page titles hurts credibility and confuses search engines.`);
      const domainWords = domainName.split(/\s+/).filter(Boolean).map((w) => w.toLowerCase());
      const titleWords = title.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter(Boolean);
      const h1Words = h1.toLowerCase().split(/\s+/).filter(Boolean);
      const domainPresentInTitle = domainWords.some((w) => w.length > 2 && titleWords.includes(w));
      const domainPresentInH1 = h1Words.some((w) => w.length > 2 && domainWords.includes(w));
      if (!domainPresentInTitle && title.length > 0) issues.push(`Domain "${domain}" not reflected in page title — align the title tag with the brand/domain so visitors see it immediately.`);
      if (!domainPresentInH1 && h1.length > 0) issues.push(`Domain "${domain}" not reflected in H1 — the main heading should include the brand name so visitors know they're in the right place.`);
      if (title.length > 0 && !title.toLowerCase().includes("maintenance") && !title.toLowerCase().includes("solution")) issues.push("Page title doesn't communicate what the company does — lead with the service + city (e.g. 'Landscaping & Property Maintenance in Miami').");

      if (!issues.length) return { pass: true, note: "Brand appears consistent across domain, title, and headings" };
      return { pass: false, issue: issues[0], fix: issues.map((i) => `• ${i}`).join("\n") };
    },
  },
  {
    id: "credentials",
    label: "Credentials & Licensing",
    weight: 10,
    run: (ctx) => {
      const text = ctx.text.toUpperCase();
      const html = ctx.html.toUpperCase();
      const signals = {
        "CAGE code": /CAGE[#\s]*\d{5}/i,
        "DUNS number": /DUNS[#\s]*\d{6,9}/i,
        "NAICS code": /NAICS[#\s]*\d{6}/i,
        "ISA Certified Arborist": /ISA\s+CERTIFIED\s+ARBORIST/i,
        "Tree contractor license": /(TREE\s*(TRIMMER|CONTRACTOR|MAINTENANCE)\s*LICENSE|CONTRACTOR\s*LICENSE.*TREE|ARBORIST\s*LICENSE)/i,
        "Irrigation license": /(IRRIGATION\s*LICENSE|IRRIGATION\s*CONTRACTOR\s*LICENSE)/i,
        "FDOT certification": /FDOT/i,
        "Lawn/landscape contractor": /(LAWN\s*CONTRACTOR|LANDSCAPE\s*CONTRACTOR|LANDSCAPE\s*LICENSE)/i,
        "Pest control credentials": /(PEST\s*CONTROL|STRUCTURAL\s*PEST|TERMITE)/i,
        "Broward County": /BROWARD/i,
        "Miami-Dade": /MIAMI-?DADE/i,
        "Palm Beach": /PALM\s*BEACH/i,
        "General business license": /(BUSINESS\s*LICENSE|CHANGED\s*LICENSE|TRADE\s*LICENSE|PROFESSIONAL\s*LICENSE)/i,
        "Insurance": /(INSURANCE|INSURED|LICENSE\s*#| LIABILITY)/i,
      };
      const found = Object.entries(signals).filter(([, re]) => re.test(text + " " + html));
      const foundStr = found.map(([k]) => k).join(", ");

      if (found.length === 0) return { pass: false, issue: "No credentials, licenses, or certifications found on the page", fix: "List your licenses, certifications, and credentials prominently: CAGE code, DUNS number, NAICS code, ISA Certified Arborist, Broward County tree trimmer license, irrigation license, FDOT MOT certification, lawn/landscape contractor credentials, pest control credentials. Put them on the homepage and the Government/Commercial Services page. Government and commercial buyers verify these before awarding contracts." };
      if (found.length <= 2) return { pass: false, issue: `Only ${found.length} credential signals found: ${foundStr}`, fix: `Expand the credentials section. You have several professional licenses and certifications (${foundStr} found) — list them all prominently. Add a dedicated "Licenses & Certifications" section or panel. Government and commercial buyers verify these before awarding contracts.` };
      return { pass: true, note: `${found.length} credential signals found: ${foundStr}` };
    },
  },
  {
    id: "cta",
    label: "Conversion / CTA",
    weight: 8,
    run: (ctx) => {
      const $ = ctx.$;
      const bodyText = ctx.text.toLowerCase();
      const html = ctx.html.toLowerCase();
      const ctaSignals = {
        clickToCall: $('a[href^="tel:"]').length > 0 || /call now|phone now|📞|call us/i.test(bodyText),
        requestQuoteButton: /request (?:a|an) quote|get (?:a|an) quote|free quote|estimating|estimate/i.test(html),
        multipleCTAs: /request (?:a|an) quote|call now|phone now|contact us|get started|book (?:a|an)|schedule|emergency/i.test(bodyText),
        stickyMobileCTA: /sticky|fixed\s*position|bottom\s*bar|floating\s*button|mobile\s*(?:header|menu|cta)/i.test(html),
        clearServiceExplanation: /what we do|our services|about (?:us|our company)|why choose/i.test(bodyText),
        emergencyService: /emergency\s*(?:tree|service|ac|plumbing|landscaping)/i.test(bodyText),
        commercialSection: /(?:commercial|hmo|property\s*management|municipal|government|business\s*client)/i.test(bodyText),
      };

      const passed = Object.entries(ctaSignals).filter(([, v]) => v).length;
      const failed = Object.entries(ctaSignals).filter(([, v]) => !v).map(([k]) => k);

      const issues = [];
      if (!ctaSignals.clickToCall) issues.push("No click-to-call phone number (missing tel: link or 'Call Now' text) — add a prominent phone number visitors can tap to call immediately, especially on mobile");
      if (!ctaSignals.requestQuoteButton) issues.push("No clear 'Request a Quote' or 'Get a Quote' CTA button — add a primary call-to-action button above the fold and in the hero section");
      if (!ctaSignals.multipleCTAs) issues.push("Only one or no call-to-action — add multiple conversion paths: Request a Quote, Call Now, Schedule Inspection, Emergency Service");
      if (!ctaSignals.commercialSection) issues.push("No commercial/HOA/government service section — add a dedicated section for commercial, HOA, and government clients since these are higher-value customers");

      if (!issues.length) return { pass: true, note: `${passed}/6 conversion signals present` };
      return { pass: false, issue: `${passed}/6 conversion signals present`, fix: issues.map((i) => `• ${i}`).join("\n") };
    },
  },
  {
    id: "local-seo",
    label: "Local SEO",
    weight: 8,
    run: (ctx) => {
      const text = ctx.text;
      const html = ctx.html;
      const $ = ctx.$;
      const cities = ["miami", "miami-dade", "broward", "palm beach", "fort lauderdale", "lauderdale lakes", "pompano beach", "coral springs", "west palm beach", "hollywood", "miramar", "weston", "davie", "plantation", "sunrise", "boca raton", "delray beach", "boynton beach", "west palm beach", "south florida"];
      const foundCities = cities.filter((c) => new RegExp(`\\b${c.replace(/-/g, "[-\\s]?")}\\b`, "i").test(text + " " + html));
      const hasAddressSchema = $('script[type="application/ld+json"]').length > 0 && /address/i.test($('script[type="application/ld+json"]').html());
      const hasServiceAreaGeo = /(serving|serving area|service area|counties? we serve|areas? we serve)/i.test(text);
      const hasIndividualLocationPages = /href=["'][^"']*\/(broward|palm-?beach|miami|fort-?lauderdale|lauderdale| pompano|coral|west-?palm|south-?florida)[^"']*["\']/i.test(html);
      const hasPhoneNAP = /\(?\d{3}\)?\s*\d{3}[-.\s]?\d{4}/.test(text);

      const issues = [];
      if (foundCities.length === 0) issues.push("No city or county names found on the page — local SEO depends on naming the locations you serve");
      if (foundCities.length <= 2 && foundCities.length > 0) issues.push(`Only ${foundCities.length} location names found (${foundCities.join(", ")}) — expand to list all counties and major cities served`);
      if (!hasServiceAreaGeo && foundCities.length > 0) issues.push("No explicit 'service area' statement — add a sentence like 'Serving Miami-Dade, Broward, and Palm Beach Counties' near the top of the page");
      if (!hasAddressSchema && $('script[type="application/ld+json"]').length > 0) issues.push("LocalBusiness schema found but missing address — add address/geo to the LocalBusiness JSON-LD");
      if (!hasPhoneNAP) issues.push("No phone number in plain text — add a visible phone number (NAP: Name, Address, Phone) on the page for local search credibility");

      if (!issues.length) return { pass: true, note: `${foundCities.length} South Florida locations found: ${foundCities.join(", ")}` };
      return { pass: false, issue: issues[0], fix: issues.map((i) => `• ${i}`).join("\n") };
    },
  },
  {
    id: "reviews",
    label: "Reviews & Reputation",
    weight: 6,
    run: (ctx) => {
      const text = ctx.text;
      const html = ctx.html;
      const hasGoogleReviews = /(google\s*(reviews|business|local)|google\s*ratings|google\s*(my\s*)?business)/i.test(text + " " + html);
      const hasReviewText = /(⭐|★|star|stars)|(\d+\.\d?\s*stars?)/i.test(text);
      const hasTestimonials = /(testimonials?|what our? (clients?|customers?|customers|i) say|client\s*reviews|success\s*stories|happy\s*(clients?|customers?|customers|i))/i.test(text);
      const hasReviewCount = /\d+\s*(google|reviews?|reviews\s*from|reviews\s*on)\b/i.test(text);
      const hasStarRatingInHtml = /⭐\s*\d|class.*star|data-rating/i.test(html);

      const signals = Object.entries({ googleReviews: hasGoogleReviews, reviewText: hasReviewText, testimonials: hasTestimonials, reviewCount: hasReviewCount, starRatingDisplay: hasStarRatingInHtml }).filter(([, v]) => v);
      const foundStr = signals.map(([k]) => k).join(", ");

      if (signals.length === 0) return { pass: false, issue: "No review, testimonial, or reputation signals found on the page", fix: "Add: (1) A testimonials/testimonials section with real quotes from customers (3–5 minimum); (2) A review count badge like '4.8★ from 52 Google reviews'; (3) A link to the Google Business Profile; (4) Schema markup for AggregateRating or Review so search engines display star ratings in results. Pull verified reviews from Google Business Profile and display them on the site." };
      if (signals.length <= 2) return { pass: false, issue: `Only ${signals.length} review signals found: ${foundStr}`, fix: `Add more reputation signals. Found: ${foundStr}. Add: (1) A testimonials section with real quotes; (2) A Google review count badge (e.g. '4.8★ from 52 reviews'); (3) Link to Google Business Profile; (4) Review schema markup so star ratings appear in search results.` };
      return { pass: true, note: `${signals.length} review signals found: ${foundStr}` };
    },
  },
];

// ── Audit engine ────────────────────────────────────────────────────────────

function score({ earned, total }) {
  return Math.round((earned / total) * 100);
}

export function audit(html, finalUrl, opts = {}) {
  const $ = cheerio.load(html);
  $("script, style, noscript").remove();
  const text = $("body").text().replace(/\s+/g, " ").trim();
  const words = text ? text.split(" ").length : 0;
  const cleaned$ = cheerio.load(html);

  const ctx = {
    $: cleaned$,
    html,
    text,
    words,
    finalUrl,
    bytes: new Blob([html]).size,
    ttfbMs: opts.ttfbMs ?? 0,
    certValid: opts.certValid,
    fetchError: opts.fetchError,
  };

  let earned = 0;
  const issues = [];
  const passed = [];
  const notes = [];

  for (const check of CHECKS) {
    try {
      const r = check.run(ctx);
      if (r.pass) {
        earned += check.weight;
        passed.push(check.id);
        if (r.note) notes.push(r.note);
      } else {
        issues.push({ check: check.id, label: check.label, issue: r.issue, fix: r.fix || r.repair });
      }
    } catch {
      issues.push({ check: check.id, label: check.label, issue: "Check errored", fix: "Re-run audit to investigate" });
    }
  }

  const total = CHECKS.reduce((s, c) => s + c.weight, 0);
  const s = score({ earned, total });

  return {
    score: s,
    url: finalUrl,
    reachable: true,
    issues,
    passed: { count: passed.length, total: CHECKS.length, ids: passed },
    stats: {
      responseMs: ctx.ttfbMs,
      htmlKB: Math.round(ctx.bytes / 1024),
      wordCount: words,
      httpStatus: opts.status ?? 200,
    },
    notes,
    certValid: opts.certValid,
    fetchError: opts.fetchError,
    // SSL cert validity derived from fetch path: if we used the insecure HTTPS
    // fallback, the server's certificate was rejected by Node's default verifier.
    sslExpired: opts.certValid === false,
  };
}

export async function auditUrl(url, opts = {}) {
  try {
    const { page, usedUnsafe, fetchError } = await fetchPage(url, opts.timeoutMs);
    if (!page.status || page.status >= 400) {
      return {
        score: 0,
        url: page.url,
        reachable: false,
        issues: [{ check: "fetch", label: "Accessibility", issue: `HTTP ${page.status}`, fix: "Site returned an error. Check that the URL is correct and the server is running." }],
        passed: { count: 0, total: CHECKS.length, ids: [] },
        stats: { responseMs: page.ttfbMs, htmlKB: 0, wordCount: 0, httpStatus: page.status },
        notes: [],
      };
    }
    return audit(page.html, page.url, { ttfbMs: page.ttfbMs, status: page.status, certValid: !usedUnsafe, fetchError });
  } catch (err) {
    return {
      score: 0,
      url,
      reachable: false,
      issues: [{ check: "fetch", label: "Error", issue: err.message, fix: "Check the URL and try again." }],
      passed: { count: 0, total: CHECKS.length, ids: [] },
      stats: { responseMs: 0, htmlKB: 0, wordCount: 0, httpStatus: 0 },
      notes: [],
    };
  }
}

// ── Report renderers ────────────────────────────────────────────────────────

function scoreColor(s) {
  if (s >= 80) return "#22c55e";
  if (s >= 60) return "#eab308";
  if (s >= 40) return "#f97316";
  return "#ef4444";
}

function scoreLabel(s) {
  if (s >= 80) return "Good";
  if (s >= 60) return "Okay";
  if (s >= 40) return "Weak";
  return "Poor";
}

function esc(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function renderHtml(audit) {
  const { score: s, url, issues, passed, stats, notes, sslExpired } = audit;
  const color = scoreColor(s);
  const band = scoreBand(s);

  const issueCards = issues
    .map(
      (i) => `
    <div class="issue">
      <div class="issue-head">
        <span class="issue-badge" style="background:${color}">${i.label}</span>
        <span class="issue-text">✗ ${esc(i.issue)}</span>
      </div>
      <div class="issue-fix"><span class="fix-label">How to fix:</span> ${esc(i.fix)}</div>
    </div>`
    )
    .join("\n");

  const noteItems = notes.length
    ? `<div class="notes"><div class="notes-title">Notes</div>${notes.map((n) => `<div class="note">${esc(n)}</div>`).join("")}</div>`
    : "";

  // Group issues by category
  const catOrder = ["Hosting / DNS", "SSL Certificate", "Security / HTTPS", "Page Title", "Meta Description", "Content", "Mobile / Responsive", "Headings", "Images", "Structured Data", "Social Sharing", "Canonical URL", "Analytics", "Performance", "Contact Info", "Credentials & Licensing", "Conversion / CTA", "Local SEO", "Reviews & Reputation", "Brand / Naming", "Content Freshness"];
  const byCat = new Map();
  for (const i of issues) {
    if (!byCat.has(i.label)) byCat.set(i.label, []);
    byCat.get(i.label).push(i);
  }
  const catIssues = catOrder.filter((c) => byCat.has(c)).flatMap((c) => byCat.get(c));

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Website Audit — ${esc(url)}</title>
<style>
  :root { --bg:#0f172a; --card:#1e293b; --fg:#f8fafc; --muted:#94a3b8; --border:#334155; --accent:#38bdf8; }
  * { box-sizing:border-box; margin:0; padding:0; }
  body { background:var(--bg); color:var(--fg); font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif; line-height:1.6; padding:24px; max-width:880px; margin:0 auto; }
  h1 { font-size:1.5rem; font-weight:700; }
  .url { color:var(--muted); font-size:0.875rem; word-break:break-all; margin-bottom:20px; }
  .score-card { background:var(--card); border:1px solid var(--border); border-radius:12px; padding:20px 24px; display:flex; align-items:center; gap:32px; margin-bottom:24px; flex-wrap:wrap; }
  .score-big { display:flex; flex-direction:column; align-items:center; min-width:100px; }
  .score-num { font-size:3rem; font-weight:800; line-height:1; color:${color}; }
  .score-num small { font-size:1.2rem; color:var(--muted); }
  .score-label { font-size:0.875rem; font-weight:600; color:${color}; margin-top:4px; text-transform:uppercase; letter-spacing:0.04em; }
  .stats { display:flex; gap:16px; flex-wrap:wrap; font-size:0.85rem; color:var(--muted); }
  .stat { display:flex; flex-direction:column; gap:2px; }
  .stat-label { font-size:0.7rem; text-transform:uppercase; letter-spacing:0.05em; opacity:0.7; }
  .stat-value { font-weight:600; color:var(--fg); }
  .score-bar { width:100%; margin-top:10px; height:6px; background:var(--border); border-radius:3px; overflow:hidden; }
  .score-bar-inner { height:100%; background:${color}; border-radius:3px; width:${s}%; }
  .section-title { font-size:0.7rem; text-transform:uppercase; letter-spacing:0.08em; color:var(--muted); opacity:0.7; margin:4px 0 12px 0; font-weight:600; }
  .issue { background:var(--card); border:1px solid var(--border); border-radius:10px; padding:14px 18px; margin-bottom:10px; }
  .issue-head { display:flex; align-items:center; gap:10px; margin-bottom:6px; }
  .issue-badge { font-size:0.7rem; font-weight:700; padding:2px 8px; border-radius:999px; text-transform:uppercase; letter-spacing:0.04em; white-space:nowrap; }
  .issue-text { color:var(--bad, #ef4444); font-weight:500; }
  .issue-fix { font-size:0.9rem; color:var(--fg); background:rgba(56,189,248,0.06); border-left:3px solid var(--accent); padding:8px 12px; border-radius:0 6px 6px 0; white-space:pre-wrap; }
  .fix-label { color:var(--accent); font-weight:600; }
  .all-good { background:rgba(34,197,94,0.1); border:1px solid #22c55e; color:#22c55e; padding:24px; border-radius:10px; font-size:1.1rem; font-weight:600; text-align:center; margin-bottom:20px; }
  .unreachable { background:rgba(239,68,68,0.12); border:1px solid #ef4444; color:#ef4444; padding:16px 20px; border-radius:10px; font-weight:500; margin-bottom:20px; }
  .notes { background:var(--card); border:1px solid var(--border); border-radius:10px; padding:14px 18px; margin-top:10px; }
  .notes-title { font-weight:700; font-size:0.8rem; text-transform:uppercase; letter-spacing:0.06em; color:var(--muted); margin-bottom:6px; }
  .note { font-size:0.85rem; color:var(--fg); padding:2px 0; }
  .footer { margin-top:24px; padding-top:12px; border-top:1px solid var(--border); font-size:0.75rem; color:var(--muted); text-align:center; }
</style>
</head>
<body>
  <h1>Website Audit</h1>
  <div class="url">${esc(url)}</div>

  ${!audit.reachable
    ? `<div class="unreachable">✗ This site could not be reached. ${esc(issues[0]?.issue ?? "Unknown error")}</div>`
    : issues.length === 0
      ? `<div class="all-good">✓ No issues found. This site looks solid.</div>`
      : ""}

  <div class="score-card">
    <div class="score-big">
      <div class="score-num">${s}<small>/100</small></div>
      <div class="score-label">${band}</div>
    </div>
    <div class="stats">
      <div class="stat"><span class="stat-label">Passed</span><span class="stat-value">${passed.count}/${passed.total} checks</span></div>
      <div class="stat"><span class="stat-label">Issues</span><span class="stat-value">${issues.length}</span></div>
      <div class="stat"><span class="stat-label">Response</span><span class="stat-value">${stats.responseMs}ms</span></div>
      <div class="stat"><span class="stat-label">HTTP</span><span class="stat-value">${stats.httpStatus}</span></div>
      <div class="stat"><span class="stat-label">Size</span><span class="stat-value">${stats.htmlKB}KB</span></div>
      <div class="stat"><span class="stat-label">Words</span><span class="stat-value">${stats.wordCount}</span></div>
    </div>
    <div class="score-bar"><div class="score-bar-inner"></div></div>
  </div>

  <div class="cert-status cert-bad">
    <div class="cert-icon">⚠</div>
    <div class="cert-text">
      <div class="cert-title">SSL Certificate — Expired or Invalid</div>
      <div class="cert-detail">This site's SSL certificate is expired or invalid. Browsers show 'Not Secure' warnings, HTTPS is broken, and visitors may be blocked from reaching the site.</div>
      <div class="cert-fix"><span class="fix-label">Fix:</span> Renew the SSL certificate. Let's Encrypt is free and auto-renews. After renewal, browsers stop showing 'Not Secure' warnings and the HTTPS check is restored. Until then, the HTTPS and SSL checks both fail.</div>
    </div>
  </div>

  <div class="section-title">What's Wrong & How to Fix It</div>
  ${issueCards}
  ${noteItems}
  <div class="footer">Audit performed ${new Date().toISOString().slice(0,10)} · Website Audit Tool v1.1</div>
</body>
</html>`;
}

// ── CLI ─────────────────────────────────────────────────────────────────────

function printConsole(audit) {
  const { score: s, url, issues, passed, stats, notes } = audit;
  console.clear();
  console.log("");
  console.log("═".repeat(64));
  console.log(`  WEBSITE AUDIT — ${url}`);
  console.log("═".repeat(64));
  console.log("");
  const label = scoreLabel(s);
  console.log(`  Score: ${s}/100  ${label}`);
  console.log(`  Response: ${stats.responseMs}ms  |  HTTP: ${stats.httpStatus}  |  Size: ${stats.htmlKB}KB`);
  console.log(`  Words: ${stats.wordCount}  |  Checks passed: ${passed.count}/${passed.total}`);
  console.log("");

  if (!audit.reachable) {
    console.log(`  ✗  Site unreachable — ${issues[0]?.issue ?? "Unknown"}`);
    console.log("");
    return;
  }

  if (issues.length === 0) {
    console.log("  ✓  No issues found. This site looks solid.");
    console.log("");
    return;
  }

  console.log(`  Found ${issues.length} issue${issues.length === 1 ? "" : "s"}:`);
  console.log("");

  const byCat = new Map();
  for (const i of issues) {
    if (!byCat.has(i.label)) byCat.set(i.label, []);
    byCat.get(i.label).push(i);
  }
  const sorted = [...byCat.entries()].sort((a, b) => b[1].length - a[1].length);

  for (const [label, items] of sorted) {
    console.log(`  ▸ ${label}`);
    for (const i of items) {
      console.log(`      ✗  ${i.issue}`);
      console.log(`          → ${i.fix}`);
    }
    console.log("");
  }

  if (notes.length) {
    console.log("  Notes:");
    for (const n of notes) console.log(`      • ${n}`);
    console.log("");
  }

  console.log("═".repeat(64));
  console.log("");
}

async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
    console.log(`
Website Audit Tool — audit any website and get a plain-English report with fixes.

Usage:
  node src/audit.js <URL>                  Audit a site, print console report
  node src/audit.js <URL> --json           Output JSON instead of console
  node src/audit.js <URL> --report path    Write HTML report to path
  node src/audit.js <URL> --timeout ms     Set fetch timeout (default 15000ms)
  node src/audit.js --help                 This help

Examples:
  node src/audit.js https://example.com
  node src/audit.js example.com --report ./report.html
  node src/audit.js https://site.com --json
`);
    process.exit(0);
  }

  let urlArg = args.find((a) => !a.startsWith("--"));
  if (!urlArg) {
    console.error("Error: no URL provided. Usage: node src/audit.js <URL>");
    process.exit(1);
  }
  const url = normalizeUrl(urlArg);
  if (!url) {
    console.error(`Error: could not parse URL "${urlArg}"`);
    process.exit(1);
  }

  const json = args.includes("--json");
  let reportPath = null;
  const reportIdx = args.indexOf("--report");
  if (reportIdx >= 0 && reportIdx + 1 < args.length) {
    reportPath = args[reportIdx + 1];
  }
  const timeoutArg = args.find((a) => a.startsWith("--timeout="));
  const timeoutMs = timeoutArg ? parseInt(timeoutArg.split("=")[1], 10) || 15000 : 15000;

  try {
    const result = await auditUrl(url, { timeoutMs });
    printConsole(result);

    if (json) {
      const dir = resolve(__dirname, "..", "output");
      const file = resolve(dir, "audit-result.json");
      writeFileSync(file, JSON.stringify(result, null, 2) + "\n");
      console.log(`JSON saved → ${file}`);
    }

    if (reportPath) {
      const html = renderHtml(result);
      writeFileSync(reportPath, html);
      console.log(`HTML report → ${reportPath}`);
    }
  } catch (err) {
    console.error(`Audit failed: ${err.message}`);
    process.exit(1);
  }
}

const guard = process.argv[1]?.endsWith("audit.js") || process.env.NODE_RUN_MAIN === "1";
if (guard) main();

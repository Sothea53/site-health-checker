// Loads a .env file if present (silently does nothing if it isn't) — a
// fallback for hosting panels where env vars can't be set through the
// dashboard directly. Never overrides a real process.env value that's
// already set some other way.
import 'dotenv/config';
import puppeteer from 'puppeteer';
import express from 'express';
import cron from 'node-cron';
import { kv } from './kv.js';

// ---- Edit this list with your 20+ sites ----
const SITES = [
  'https://godital.com',
  'https://caravanpp.com',
  'https://palacegatepp.com',
];

const VIEWPORTS = {
  desktop: { width: 1920, height: 1080, isMobile: false },
  mobile: {
    width: 390,
    height: 844,
    isMobile: true,
    hasTouch: true,
    userAgent:
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
  },
};

const OVERFLOW_TOLERANCE_PX = 5;
const NAV_TIMEOUT_MS = 25000;
// Treat the site as reachable once the initial HTML is parsed. Waiting for
// `networkidle0` makes this checker stricter than uptime tools such as
// Uptime Kuma and falsely marks pages DOWN when analytics, chat widgets,
// beacons, or long-polling requests keep the network busy.
const NAV_WAIT_UNTIL = 'domcontentloaded';
const CONTENT_READY_DELAY_MS = 1000;
const REPORT_HISTORY_DAYS = 30;
const SETTLE_DELAY_MS = 4000; // wait after scrolling, before checking images/overflow/screenshot

// Diagnostic logging: prefixed + timestamped so `wrangler tail` output shows
// exactly which awaited step a check is on when (if) it hangs. Remove/quiet
// this once the root cause is confirmed.
function diag(label, extra) {
  const line = `[diag +${Date.now() % 100000}ms] ${label}`;
  if (extra !== undefined) console.log(line, extra);
  else console.log(line);
}


// Hard ceiling for an entire single-page check (nav + scroll + settle + checks + screenshot).
// Guards against any single site hanging the whole batch, no matter what causes it.
const PAGE_TIMEOUT_MS = NAV_TIMEOUT_MS + CONTENT_READY_DELAY_MS + SETTLE_DELAY_MS + 15000;

async function performPageChecks(page, url, vp, result) {
  diag(`setViewport start`, url);
  await page.setViewport({ width: vp.width, height: vp.height, isMobile: !!vp.isMobile, hasTouch: !!vp.hasTouch });
  if (vp.userAgent) await page.setUserAgent(vp.userAgent);
  diag(`setViewport done`, url);

  page.on('console', (msg) => {
    if (msg.type() === 'error') result.consoleErrors.push(msg.text().slice(0, 300));
  });
  page.on('pageerror', (err) => {
    result.consoleErrors.push(`Uncaught exception: ${err.message}`.slice(0, 300));
  });
  page.on('requestfailed', (req) => {
    const failure = req.failure();
    if (failure && failure.errorText !== 'net::ERR_ABORTED') {
      result.failedRequests.push(`${req.method()} ${req.url()} — ${failure.errorText}`);
    }
  });

  const start = Date.now();
  diag(`goto start`, url);
  const response = await page.goto(url, { waitUntil: NAV_WAIT_UNTIL, timeout: NAV_TIMEOUT_MS });
  diag(`goto done`, `${url} status=${response ? response.status() : 'null'} waitUntil=${NAV_WAIT_UNTIL}`);
  await new Promise((resolve) => setTimeout(resolve, CONTENT_READY_DELAY_MS));
  diag(`content ready delay done`, url);
  result.loadTimeMs = Date.now() - start;
  result.httpStatus = response ? response.status() : null;

  if (!response || response.status() >= 400) {
    result.status = 'DOWN';
    result.issues.push(`HTTP ${result.httpStatus ?? 'no response'}`);
  }

  // Scroll through the page to trigger lazy-loaded images (most lazy-load
  // libraries only start loading once an element enters the viewport), then
  // scroll back to top. Hard-capped by both distance and iteration count so
  // infinite-scroll pages or content that keeps growing can't loop forever.
  diag(`scroll evaluate start`, url);
  await page.evaluate(async () => {
    await new Promise((resolve) => {
      let scrolled = 0;
      let iterations = 0;
      const step = 400;
      const maxScroll = 20000;
      const maxIterations = 60; // ~6s of stepping at 100ms, regardless of page height
      const timer = setInterval(() => {
        window.scrollBy(0, step);
        scrolled += step;
        iterations += 1;
        const target = Math.min(document.body.scrollHeight, maxScroll);
        if (scrolled >= target || iterations >= maxIterations) {
          clearInterval(timer);
          window.scrollTo(0, 0);
          resolve();
        }
      }, 100);
    });
  });
  diag(`scroll evaluate done`, url);
  await new Promise((resolve) => setTimeout(resolve, SETTLE_DELAY_MS));
  diag(`settle delay done`, url);

  diag(`broken-images evaluate start`, url);
  const brokenImages = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('img'))
      .filter((img) => img.src && !img.src.startsWith('data:') && (!img.complete || img.naturalWidth === 0))
      .map((img) => img.src)
      .slice(0, 20);
  });
  diag(`broken-images evaluate done`, `${url} count=${brokenImages.length}`);
  result.brokenImages = brokenImages;

  diag(`overflow evaluate start`, url);
  // Sample overflow multiple times rather than once — a single snapshot can
  // land mid-animation (a sliding carousel, an opening menu, a marquee) and
  // catch a transient state that's briefly wider than the viewport even
  // though the page settles back to a clean layout moments later. Only
  // flag it as a real issue if overflow is present in every sample, so a
  // genuinely broken layout still gets caught but a passing animation frame
  // doesn't produce a false positive.
  const OVERFLOW_SAMPLES = 3;
  const OVERFLOW_SAMPLE_INTERVAL_MS = 400;
  const overflowSamples = [];
  for (let sample = 0; sample < OVERFLOW_SAMPLES; sample++) {
    const reading = await page.evaluate(() => ({
      docWidth: document.documentElement.scrollWidth,
      viewWidth: document.documentElement.clientWidth,
    }));
    overflowSamples.push(reading);
    if (sample < OVERFLOW_SAMPLES - 1) {
      await new Promise((resolve) => setTimeout(resolve, OVERFLOW_SAMPLE_INTERVAL_MS));
    }
  }
  diag(`overflow evaluate done`, `${url} samples=${JSON.stringify(overflowSamples)}`);
  result.hasOverflow = overflowSamples.every((s) => s.docWidth > s.viewWidth + OVERFLOW_TOLERANCE_PX);
  if (result.hasOverflow) {
    const worst = overflowSamples.reduce((a, b) => (b.docWidth > a.docWidth ? b : a));
    result.issues.push(`Horizontal overflow: page is ${worst.docWidth}px wide in a ${worst.viewWidth}px viewport (consistent across ${OVERFLOW_SAMPLES} samples)`);
  }

  if (brokenImages.length > 0) result.issues.push(`${brokenImages.length} broken image(s)`);
  if (result.consoleErrors.length > 0) result.issues.push(`${result.consoleErrors.length} console error(s)`);
  if (result.failedRequests.length > 0) result.issues.push(`${result.failedRequests.length} failed network request(s)`);

  if (result.status === 'OK' && result.issues.length > 0) result.status = 'ISSUES';

  // Only screenshot pages with an issue, to stay well within the Free plan's 10 min/day browser budget
  if (result.issues.length > 0) {
    diag(`screenshot start`, url);
    // JPEG instead of PNG: full-page PNGs of real websites can run several
    // MB (a plain lossless capture hit ~7MB on one page), large enough to
    // trip nginx's default proxy buffering/timeout and render as a broken
    // image in the browser even though the data was stored correctly.
    // Quality 70 keeps it plenty sharp for spotting overflow/broken elements
    // while typically landing well under 1MB.
    result.screenshotBytes = await page.screenshot({ fullPage: true, type: 'jpeg', quality: 70 });
    diag(`screenshot done`, url);
  }
  diag(`performPageChecks complete`, url);
}

async function checkPage(browser, url, viewportName, vp) {
  diag(`newPage start`, `${url} [${viewportName}]`);
  const page = await browser.newPage();
  diag(`newPage done`, `${url} [${viewportName}]`);
  const result = {
    url,
    viewport: viewportName,
    status: 'OK',
    httpStatus: null,
    issues: [],
    consoleErrors: [],
    failedRequests: [],
    brokenImages: [],
    hasOverflow: false,
    loadTimeMs: null,
    screenshotId: null,
    checkedAt: new Date().toISOString(),
  };

  // Promise.race below does NOT cancel performPageChecks if the timeout
  // branch wins — it keeps running in the background against a page we're
  // about to close. When it then throws (operating on a closed page), that
  // rejection has nothing attached to catch it, which crashes the whole
  // background run (ctx.waitUntil) silently with no log line — this is what
  // was killing the run dead right after the first slow/hanging page.
  const checkPromise = performPageChecks(page, url, vp, result);
  checkPromise.catch(() => {});

  try {
    await Promise.race([
      checkPromise.then(() => diag(`race: performPageChecks won`, `${url} [${viewportName}]`)),
      new Promise((_, reject) =>
        setTimeout(() => {
          diag(`race: timeout won — performPageChecks still pending`, `${url} [${viewportName}]`);
          reject(new Error(`Check exceeded ${PAGE_TIMEOUT_MS}ms overall timeout`));
        }, PAGE_TIMEOUT_MS)
      ),
    ]);
  } catch (err) {
    diag(`checkPage caught error`, `${url} [${viewportName}] ${String(err && err.message ? err.message : err)}`);
    result.status = 'DOWN';
    result.issues.push(`Failed to load: ${String(err.message).split('\n')[0]}`);
  } finally {
    diag(`page.close start`, `${url} [${viewportName}]`);
    await page.close().catch(() => {});
    diag(`page.close done`, `${url} [${viewportName}]`);
  }

  return result;
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function statusClass(status) {
  return status === 'DOWN' ? 'down' : status === 'ISSUES' ? 'warn' : 'ok';
}

const DISPLAY_TIMEZONE = 'Asia/Phnom_Penh';

// Timestamps are stored/keyed in UTC ISO (so KV keys stay sortable and
// unambiguous); this only affects how they're rendered to the user.
function formatDisplayTime(isoOrDate) {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: DISPLAY_TIMEZONE,
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(new Date(isoOrDate)).replace(',', '') + ' ICT';
}

// Shared look across both pages: a dark diagnostics-console aesthetic —
// status dots, monospace vitals, red/amber/green semantics borrowed from
// real monitoring equipment rather than a generic light dashboard.
const BASE_STYLES = `
  :root {
    --bg: #0d1117;
    --border: #262c34;
    --text: #e6edf3;
    --text-dim: #8b949e;
    --text-faint: #565f6b;
    --ok: #3fb950;
    --warn: #d29922;
    --down: #f85149;
    --accent: #58a6ff;
    --mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
    --sans: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  }
  * { box-sizing: border-box; }
  body {
    background: var(--bg); color: var(--text); font-family: var(--sans);
    margin: 0; padding: 0 0 64px; -webkit-font-smoothing: antialiased;
  }
  a { color: var(--accent); }
  .topbar {
    display: flex; align-items: center; justify-content: space-between;
    padding: 16px 28px; border-bottom: 1px solid var(--border);
    position: sticky; top: 0; background: rgba(13,17,23,0.92); backdrop-filter: blur(6px);
    z-index: 10;
  }
  .brand {
    font-family: var(--mono); font-size: 12.5px; font-weight: 600; letter-spacing: 0.14em;
    text-transform: uppercase; color: var(--text-dim);
  }
  .brand strong { color: var(--text); }
  .nav a {
    color: var(--text-dim); text-decoration: none; font-size: 12.5px; margin-left: 22px;
    font-family: var(--mono); letter-spacing: 0.04em;
  }
  .nav a:hover { color: var(--accent); }
  .nav .check-now {
    margin-left: 22px; color: var(--bg); background: var(--accent);
    padding: 5px 12px; border-radius: 5px; font-weight: 600;
    transition: opacity 0.15s ease;
  }
  .nav .check-now:hover { color: var(--bg); opacity: 0.85; }
  .dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; display: inline-block; }
  .dot--ok { background: var(--ok); }
  .dot--warn { background: var(--warn); }
  .dot--down {
    background: var(--down);
    animation: pulse 1.8s ease-out infinite;
  }
  @keyframes pulse {
    0% { box-shadow: 0 0 0 0 rgba(248,81,73,0.45); }
    70% { box-shadow: 0 0 0 8px rgba(248,81,73,0); }
    100% { box-shadow: 0 0 0 0 rgba(248,81,73,0); }
  }
  .badge {
    font-family: var(--mono); font-size: 10.5px; letter-spacing: 0.06em; padding: 2px 8px;
    border-radius: 4px; text-transform: uppercase; font-weight: 700;
  }
  .badge--ok { color: var(--ok); background: rgba(63,185,80,0.12); }
  .badge--warn { color: var(--warn); background: rgba(210,153,34,0.12); }
  .badge--down { color: var(--down); background: rgba(248,81,73,0.12); }
`;

function topbar(activeNav) {
  return `
  <div class="topbar">
    <div class="brand"><strong>Site Health</strong> · console</div>
    <div class="nav">
      <a href="/" ${activeNav === 'latest' ? 'style="color:var(--accent)"' : ''}>Latest</a>
      <a href="/history" ${activeNav === 'history' ? 'style="color:var(--accent)"' : ''}>History</a>
      <a href="/settings" ${activeNav === 'settings' ? 'style="color:var(--accent)"' : ''}>Settings</a>
      <a href="/run" class="check-now">Check Now</a>
    </div>
  </div>`;
}

function generateHtmlReport(results, timestampIso, options = {}) {
  const { isHistorical = false } = options;

  const bySite = {};
  for (const r of results) {
    bySite[r.url] = bySite[r.url] || [];
    bySite[r.url].push(r);
  }

  const summaryPatterns = [/console error/, /failed network request/, /broken image/];

  const rows = Object.entries(bySite)
    .map(([siteUrl, entries]) => {
      const worst = entries.some((e) => e.status === 'DOWN')
        ? 'DOWN'
        : entries.some((e) => e.status === 'ISSUES')
        ? 'ISSUES'
        : 'OK';
      const worstClass = statusClass(worst);

      const viewportBlocks = entries
        .map((e) => {
          const cls = statusClass(e.status);
          const flagIssues = e.issues.filter((i) => !summaryPatterns.some((p) => p.test(i)));

          const details = [];

          if (flagIssues.length > 0) {
            details.push(
              flagIssues.map((i) => `<div class="flag flag--${cls}">${escapeHtml(i)}</div>`).join('')
            );
          }
          if (e.consoleErrors.length > 0) {
            details.push(`
              <details class="detail">
                <summary>${e.consoleErrors.length} console error${e.consoleErrors.length > 1 ? 's' : ''}</summary>
                <div class="detail-body"><ul class="detail-list">${e.consoleErrors
                  .map((m) => `<li>${escapeHtml(m)}</li>`)
                  .join('')}</ul></div>
              </details>`);
          }
          if (e.failedRequests.length > 0) {
            details.push(`
              <details class="detail">
                <summary>${e.failedRequests.length} failed request${e.failedRequests.length > 1 ? 's' : ''}</summary>
                <div class="detail-body"><ul class="detail-list">${e.failedRequests
                  .map((m) => `<li>${escapeHtml(m)}</li>`)
                  .join('')}</ul></div>
              </details>`);
          }
          if (e.brokenImages.length > 0) {
            details.push(`
              <details class="detail">
                <summary>${e.brokenImages.length} broken image${e.brokenImages.length > 1 ? 's' : ''}</summary>
                <div class="detail-body"><ul class="detail-list">${e.brokenImages
                  .map((m) => `<li><a href="${escapeHtml(m)}" target="_blank">${escapeHtml(m)}</a></li>`)
                  .join('')}</ul></div>
              </details>`);
          }
          if (e.screenshotId) {
            details.push(`
              <details class="detail">
                <summary>Screenshot <a class="shot-open" href="/screenshot/${e.screenshotId}" target="_blank" rel="noopener" title="Open full screenshot in a new tab" onclick="event.stopPropagation()">&#8599; open</a></summary>
                <div class="detail-body"><img class="detail-shot" loading="lazy" src="/screenshot/${e.screenshotId}" /></div>
              </details>`);
          }

          return `
            <div class="viewport-row">
              <div class="viewport-head">
                <span class="dot dot--${cls}"></span>
                <span class="viewport-name">${e.viewport}</span>
                <span class="badge badge--${cls}">${e.status}</span>
                <span class="viewport-meta">HTTP ${e.httpStatus ?? '—'} · ${e.loadTimeMs ?? '—'}ms</span>
              </div>
              ${details.join('')}
            </div>`;
        })
        .join('');

      return `
        <div class="site-row" data-status="${worst}">
          <div class="site-head">
            <span class="dot dot--${worstClass}"></span>
            <a class="site-url" href="${siteUrl}" target="_blank">${escapeHtml(siteUrl)}</a>
            <span class="badge badge--${worstClass} site-badge">${worst}</span>
          </div>
          <div class="viewports">${viewportBlocks}</div>
        </div>`;
    })
    .join('');

  const downCount = Object.values(bySite).filter((e) => e.some((x) => x.status === 'DOWN')).length;
  const issueCount = Object.values(bySite).filter(
    (e) => !e.some((x) => x.status === 'DOWN') && e.some((x) => x.status === 'ISSUES')
  ).length;
  const okCount = Object.keys(bySite).length - downCount - issueCount;

  const subtitle = isHistorical
    ? `Archived report · ${formatDisplayTime(timestampIso)}`
    : `Live report · ${formatDisplayTime(timestampIso)}`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Site Health Report</title>
<style>
${BASE_STYLES}
  .vitals {
    display: flex; gap: 30px; align-items: baseline; flex-wrap: wrap;
    padding: 26px 28px 20px; border-bottom: 1px solid var(--border);
  }
  .vital { display: flex; align-items: baseline; gap: 8px; }
  .vital-num { font-family: var(--mono); font-size: 30px; font-weight: 700; }
  .vital-label { font-family: var(--mono); font-size: 10.5px; letter-spacing: 0.08em; text-transform: uppercase; color: var(--text-dim); }
  .vital--ok .vital-num { color: var(--ok); }
  .vital--warn .vital-num { color: var(--warn); }
  .vital--down .vital-num { color: var(--down); }
  .vitals-meta { margin-left: auto; font-family: var(--mono); font-size: 12px; color: var(--text-faint); align-self: center; }

  .filter-tabs {
    position: relative; display: inline-flex; gap: 2px; padding: 4px;
    margin: 14px 28px; border-radius: 999px; background: rgba(255,255,255,0.05);
    border: 1px solid var(--border);
  }
  .filter-slider {
    position: absolute; top: 4px; bottom: 4px; left: 4px; border-radius: 999px;
    background: var(--text); z-index: 0;
    box-shadow: 0 2px 8px rgba(0,0,0,0.35);
    transition: transform 0.28s cubic-bezier(0.4, 0, 0.2, 1),
                width 0.28s cubic-bezier(0.4, 0, 0.2, 1),
                background-color 0.2s ease;
  }
  .filter-tab {
    position: relative; z-index: 1;
    font-family: var(--mono); font-size: 12px; letter-spacing: 0.03em;
    padding: 7px 16px; border-radius: 999px; border: none;
    background: transparent; color: var(--text-dim); cursor: pointer;
    display: flex; align-items: center; gap: 7px;
    transition: color 0.2s ease, transform 0.15s ease;
  }
  .filter-tab:hover:not(.filter-tab--active) { color: var(--text); }
  .filter-tab:active { transform: scale(0.96); }
  .filter-tab .count {
    font-weight: 700; font-size: 11px; padding: 1px 6px; border-radius: 999px;
    background: rgba(255,255,255,0.1); color: inherit;
  }
  .filter-tab--active { color: var(--bg); }
  .filter-tab--active .count { background: rgba(0,0,0,0.15); }

  .list { padding: 6px 28px 0; max-width: 920px; }
  .site-row { border-bottom: 1px solid var(--border); padding: 16px 0; }
  .site-head { display: flex; align-items: center; gap: 10px; }
  .site-url { color: var(--text); text-decoration: none; font-weight: 600; font-size: 14.5px; }
  .site-url:hover { color: var(--accent); }
  .site-badge { margin-left: auto; }

  .viewports { margin: 10px 0 0 18px; display: flex; flex-direction: column; gap: 10px; }
  .viewport-head { display: flex; align-items: center; gap: 8px; font-size: 12.5px; }
  .viewport-name { font-family: var(--mono); text-transform: uppercase; color: var(--text-dim); width: 60px; font-size: 11px; letter-spacing: 0.05em; }
  .viewport-meta { color: var(--text-faint); font-family: var(--mono); font-size: 11.5px; }

  .flag { margin: 6px 0 0 70px; font-size: 12.5px; color: var(--text-dim); font-family: var(--mono); }
  .flag--down { color: var(--down); }
  .flag--warn { color: var(--warn); }

  details.detail { margin: 6px 0 0 70px; }
  details.detail summary { cursor: pointer; font-size: 12.5px; color: var(--text-dim); list-style: none; }
  details.detail summary::-webkit-details-marker { display: none; }
  details.detail summary::before { content: '▸ '; color: var(--text-faint); }
  details.detail[open] summary::before { content: '▾ '; }
  .detail-body { margin: 6px 0 4px 14px; }
  .detail-list { margin: 0; padding-left: 16px; font-family: var(--mono); font-size: 11.5px; color: var(--text-dim); }
  .detail-list li { margin-bottom: 3px; word-break: break-all; }
  .detail-list a { color: var(--text-dim); }
  .detail-list a:hover { color: var(--accent); }
  .detail-shot { max-width: 100%; margin-top: 6px; border: 1px solid var(--border); border-radius: 6px; display: block; }
  .shot-open { color: var(--accent); text-decoration: none; font-size: 11px; margin-left: 4px; }
  .shot-open:hover { text-decoration: underline; }
</style>
</head>
<body>
  ${topbar('latest')}
  <div class="vitals">
    <div class="vital vital--ok"><span class="vital-num">${okCount}</span><span class="vital-label">up</span></div>
    <div class="vital vital--warn"><span class="vital-num">${issueCount}</span><span class="vital-label">issues</span></div>
    <div class="vital vital--down"><span class="vital-num">${downCount}</span><span class="vital-label">down</span></div>
    <div class="vitals-meta">${subtitle}</div>
  </div>
  <div class="filter-tabs" id="filterTabs">
    <div class="filter-slider" id="filterSlider"></div>
    <button type="button" class="filter-tab filter-tab--active" data-filter="ALL">All <span class="count">${okCount + issueCount + downCount}</span></button>
    <button type="button" class="filter-tab" data-filter="OK">OK <span class="count">${okCount}</span></button>
    <button type="button" class="filter-tab" data-filter="ISSUES">Issues <span class="count">${issueCount}</span></button>
    <button type="button" class="filter-tab" data-filter="DOWN">Down <span class="count">${downCount}</span></button>
  </div>
  <div class="list">${rows}</div>
  <script>
    (function () {
      var track = document.getElementById('filterTabs');
      var slider = document.getElementById('filterSlider');
      var tabs = document.querySelectorAll('.filter-tab');
      var rows = document.querySelectorAll('.site-row[data-status]');
      var colorFor = { ALL: 'var(--text)', OK: 'var(--ok)', ISSUES: 'var(--warn)', DOWN: 'var(--down)' };

      function moveSliderTo(tab) {
        var trackRect = track.getBoundingClientRect();
        var tabRect = tab.getBoundingClientRect();
        slider.style.width = tabRect.width + 'px';
        slider.style.transform = 'translateX(' + (tabRect.left - trackRect.left - 4) + 'px)';
        slider.style.background = colorFor[tab.getAttribute('data-filter')] || 'var(--text)';
      }

      tabs.forEach(function (tab) {
        tab.addEventListener('click', function () {
          var f = tab.getAttribute('data-filter');
          tabs.forEach(function (t) { t.classList.toggle('filter-tab--active', t === tab); });
          moveSliderTo(tab);
          rows.forEach(function (row) {
            row.style.display = f === 'ALL' || row.getAttribute('data-status') === f ? '' : 'none';
          });
        });
      });

      // Position the slider under "All" instantly on load, no animation,
      // then re-enable the transition for subsequent clicks.
      slider.style.transition = 'none';
      moveSliderTo(document.querySelector('.filter-tab--active'));
      requestAnimationFrame(function () {
        slider.style.transition = '';
      });
    })();
  </script>
</body>
</html>`;
}

function generateHistoryListHtml(entries) {
  // entries: [{ ts, summary: { okCount, issueCount, downCount, totalSites } | null }], newest first
  const sorted = [...entries].sort((a, b) => (a.ts < b.ts ? 1 : -1));

  const rows = sorted
    .map(({ ts, summary }) => {
      const label = formatDisplayTime(ts);
      const counts = summary
        ? `
          <span class="hcount hcount--ok">${summary.okCount} up</span>
          <span class="hcount hcount--warn">${summary.issueCount} issues</span>
          <span class="hcount hcount--down">${summary.downCount} down</span>`
        : `<span class="hcount">—</span>`;
      return `
        <a class="history-row" href="/history/${encodeURIComponent(ts)}">
          <span class="history-time">${label}</span>
          <span class="history-counts">${counts}</span>
        </a>`;
    })
    .join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Site Health — History</title>
<style>
${BASE_STYLES}
  .list { padding: 10px 28px 0; max-width: 720px; }
  .history-row {
    display: flex; align-items: center; gap: 16px; padding: 14px 4px;
    border-bottom: 1px solid var(--border); text-decoration: none; color: var(--text);
  }
  .history-row:hover .history-time { color: var(--accent); }
  .history-time { font-family: var(--mono); font-size: 13px; flex: 1; }
  .history-counts { display: flex; gap: 12px; }
  .hcount { font-family: var(--mono); font-size: 11.5px; color: var(--text-faint); margin-left: 12px; }
  .hcount:first-child { margin-left: 0; }
  .hcount--ok { color: var(--ok); }
  .hcount--warn { color: var(--warn); }
  .hcount--down { color: var(--down); }
  .empty-state { padding: 60px 28px; text-align: center; color: var(--text-faint); font-family: var(--mono); font-size: 13px; }
</style>
</head>
<body>
  ${topbar('history')}
  <div class="list">${rows}</div>
  ${rows ? '' : `<div class="empty-state">No past reports yet — reports are kept for ${REPORT_HISTORY_DAYS} days.</div>`}
</body>
</html>`;
}

function generateSettingsPageHtml(settings, flash) {
  const flashHtml = flash
    ? `<div class="flash flash--${flash.type}">${escapeHtml(flash.message)}</div>`
    : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Site Health — Settings</title>
<style>
${BASE_STYLES}
  .settings-wrap { max-width: 620px; margin: 0 auto; padding: 32px 28px 60px; }
  .settings-title { font-size: 20px; font-weight: 700; margin: 0 0 6px; }
  .settings-subtitle { color: var(--text-dim); font-size: 13px; margin: 0 0 28px; }
  .settings-card {
    border: 1px solid var(--border); border-radius: 10px; padding: 24px;
    margin-bottom: 20px; background: rgba(255,255,255,0.015);
  }
  .settings-card h2 {
    font-size: 14px; margin: 0 0 4px; display: flex; align-items: center; gap: 8px;
  }
  .settings-card .card-desc { color: var(--text-dim); font-size: 12.5px; margin: 0 0 20px; }
  .field { margin-bottom: 18px; }
  .field label {
    display: flex; align-items: center; gap: 8px; font-size: 12.5px; font-weight: 600;
    margin-bottom: 6px; color: var(--text);
  }
  .field input[type="text"], .field input[type="password"] {
    width: 100%; background: var(--bg); border: 1px solid var(--border); border-radius: 7px;
    padding: 9px 12px; color: var(--text); font-family: var(--mono); font-size: 13px;
  }
  .field input:focus { outline: none; border-color: var(--accent); }
  .field .help {
    color: var(--text-faint); font-size: 11.5px; margin-top: 6px; line-height: 1.5;
  }
  .field .help code {
    background: rgba(255,255,255,0.06); padding: 1px 5px; border-radius: 4px; font-size: 11px;
  }
  .toggle-row { display: flex; align-items: center; gap: 10px; margin-bottom: 18px; }
  .toggle-row label { font-size: 13px; font-weight: 600; margin: 0; cursor: pointer; }
  .switch { position: relative; width: 38px; height: 22px; flex-shrink: 0; }
  .switch input { opacity: 0; width: 0; height: 0; }
  .switch .track {
    position: absolute; inset: 0; background: var(--border); border-radius: 999px;
    cursor: pointer; transition: background 0.15s ease;
  }
  .switch .track::before {
    content: ''; position: absolute; width: 16px; height: 16px; left: 3px; top: 3px;
    background: var(--text-dim); border-radius: 50%; transition: transform 0.15s ease, background 0.15s ease;
  }
  .switch input:checked + .track { background: rgba(63,185,80,0.25); }
  .switch input:checked + .track::before { transform: translateX(16px); background: var(--ok); }
  .btn-row { display: flex; gap: 10px; margin-top: 4px; }
  .btn {
    font-family: var(--mono); font-size: 12.5px; font-weight: 600; letter-spacing: 0.02em;
    padding: 9px 16px; border-radius: 7px; border: 1px solid var(--border);
    background: transparent; color: var(--text); cursor: pointer;
  }
  .btn:hover { border-color: var(--text-faint); }
  .btn--primary { background: var(--accent); border-color: var(--accent); color: var(--bg); }
  .btn--primary:hover { opacity: 0.9; border-color: var(--accent); }
  .flash {
    padding: 11px 16px; border-radius: 8px; font-size: 12.5px; margin-bottom: 20px;
    font-family: var(--mono);
  }
  .flash--ok { background: rgba(63,185,80,0.12); color: var(--ok); border: 1px solid rgba(63,185,80,0.3); }
  .flash--error { background: rgba(248,81,73,0.12); color: var(--down); border: 1px solid rgba(248,81,73,0.3); }
  .alert-note {
    font-size: 11.5px; color: var(--text-faint); margin-top: -8px; margin-bottom: 18px;
    padding: 8px 12px; background: rgba(255,255,255,0.03); border-radius: 6px;
  }
</style>
</head>
<body>
  ${topbar('settings')}
  <div class="settings-wrap">
    <h1 class="settings-title">Settings</h1>
    <p class="settings-subtitle">Configure alerts and other options for this checker.</p>

    ${flashHtml}

    <div class="settings-card">
      <h2>📨 Telegram Alerts</h2>
      <p class="card-desc">Sends a Telegram message the moment a site transitions into DOWN. Won't re-alert every run while it stays down, and won't alert on ISSUES or recovery — just the moment something breaks.</p>

      <form method="POST" action="/settings">
        <div class="toggle-row">
          <span class="switch">
            <input type="checkbox" id="telegramEnabled" name="telegramEnabled" ${settings.telegramEnabled ? 'checked' : ''} />
            <span class="track" onclick="document.getElementById('telegramEnabled').click()"></span>
          </span>
          <label for="telegramEnabled">Enable Telegram alerts</label>
        </div>

        <div class="field">
          <label for="telegramBotToken">Bot Token</label>
          <input type="password" id="telegramBotToken" name="telegramBotToken" value="${escapeHtml(settings.telegramBotToken)}" placeholder="123456789:AAExampleTokenFromBotFather" autocomplete="off" />
          <div class="help">
            Get this from <a href="https://t.me/BotFather" target="_blank">@BotFather</a> on Telegram: send <code>/newbot</code>, follow the prompts, and it'll give you a token that looks like <code>123456789:AAH...</code>.
          </div>
        </div>

        <div class="field">
          <label for="telegramChatId">Chat ID</label>
          <input type="text" id="telegramChatId" name="telegramChatId" value="${escapeHtml(settings.telegramChatId)}" placeholder="e.g. 123456789" autocomplete="off" />
          <div class="help">
            How to find your chat ID: first send any message to your new bot (search for it by the username BotFather gave you, and press Start). Then open
            <code>https://api.telegram.org/bot&lt;YOUR_TOKEN&gt;/getUpdates</code>
            in a browser — replace <code>&lt;YOUR_TOKEN&gt;</code> with the bot token above. Look for <code>"chat":{"id":123456789,...}</code> in the response — that number is your chat ID.
            <br />For a group chat instead, add the bot to the group first, send a message there, then check the same URL — group chat IDs are usually negative numbers.
          </div>
        </div>

        <div class="btn-row">
          <button type="submit" class="btn btn--primary">Save Settings</button>
        </div>
      </form>

      <form method="POST" action="/settings/test-telegram" style="margin-top: 14px;">
        <div class="btn-row">
          <button type="submit" class="btn">Send Test Alert</button>
        </div>
      </form>
    </div>
  </div>
</body>
</html>`;
}

function generateRunningPageHtml() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Site Health — Running…</title>
<style>
${BASE_STYLES}
  .run-wrap { max-width: 640px; margin: 56px auto; padding: 0 24px; }
  .run-head { display: flex; align-items: center; gap: 10px; margin-bottom: 22px; }
  .dot--scan { background: var(--accent); animation: pulse-blue 1.4s ease-out infinite; }
  @keyframes pulse-blue {
    0% { box-shadow: 0 0 0 0 rgba(88,166,255,0.45); }
    70% { box-shadow: 0 0 0 8px rgba(88,166,255,0); }
    100% { box-shadow: 0 0 0 0 rgba(88,166,255,0); }
  }
  .run-title { font-family: var(--mono); font-size: 15px; letter-spacing: 0.03em; }
  .progress-track { height: 6px; background: #1c222b; border-radius: 3px; overflow: hidden; margin-bottom: 10px; }
  .progress-fill { height: 100%; width: 0%; background: var(--accent); transition: width 0.4s ease; }
  .status-text { font-family: var(--mono); font-size: 12.5px; color: var(--text-dim); margin-bottom: 22px; }
  .log { background: #0a0d12; border: 1px solid var(--border); border-radius: 8px; padding: 12px 14px; height: 280px; overflow-y: auto; font-family: var(--mono); font-size: 11.5px; }
  .log-line { padding: 2px 0; color: var(--text-dim); }
  .log-line--ok { color: var(--ok); }
  .log-line--warn { color: var(--warn); }
  .log-line--down { color: var(--down); }
  .done-note { margin-top: 16px; font-family: var(--mono); font-size: 12.5px; color: var(--ok); display: none; }
</style>
</head>
<body>
  ${topbar('latest')}
  <div class="run-wrap">
    <div class="run-head">
      <span class="dot dot--scan"></span>
      <span class="run-title">Running health check…</span>
    </div>
    <div class="progress-track"><div class="progress-fill" id="bar"></div></div>
    <div class="status-text" id="status-text">Starting…</div>
    <div class="log" id="log"></div>
    <div class="done-note" id="done-note">Done — redirecting to the report…</div>
  </div>
  <script>
    var lastCount = 0;
    function statusClassFor(s) { return s === 'DOWN' ? 'down' : s === 'ISSUES' ? 'warn' : 'ok'; }
    function iconFor(s) { return s === 'DOWN' ? '✕' : s === 'ISSUES' ? '!' : '✓'; }

    function poll() {
      fetch('/run-status').then(function (res) { return res.json(); }).then(function (data) {
        var total = data.total || 0;
        var completed = data.completed || [];
        var pct = total > 0 ? Math.round((completed.length / total) * 100) : 0;
        document.getElementById('bar').style.width = pct + '%';
        document.getElementById('status-text').textContent =
          data.status === 'done'
            ? 'Done — ' + completed.length + ' checks complete'
            : 'Checking ' + completed.length + ' of ' + total + '…';

        var log = document.getElementById('log');
        for (var i = lastCount; i < completed.length; i++) {
          var c = completed[i];
          var line = document.createElement('div');
          line.className = 'log-line log-line--' + statusClassFor(c.status);
          line.textContent = iconFor(c.status) + ' ' + c.url + ' — ' + c.viewport + ' — ' + (c.loadTimeMs != null ? c.loadTimeMs + 'ms' : '—');
          log.appendChild(line);
        }
        log.scrollTop = log.scrollHeight;
        lastCount = completed.length;

        if (data.status === 'done') {
          document.getElementById('done-note').style.display = 'block';
          setTimeout(function () { window.location.href = '/'; }, 1300);
          return;
        }
        if (data.status === 'error') {
          document.getElementById('status-text').textContent = 'Run failed: ' + (data.error || 'unknown error');
          document.getElementById('status-text').style.color = 'var(--down)';
          return;
        }
        setTimeout(poll, 900);
      }).catch(function () {
        setTimeout(poll, 1500);
      });
    }
    poll();
  </script>
</body>
</html>`;
}

async function runChecks() {
  // Guard against overlapping runs: if a run is still marked 'running', a
  // second trigger (a fast double-click on /run, or the cron firing mid-test)
  // would launch a second browser session on top of the first — which is
  // exactly what produces the 'Unable to create new browser: 429 rate limit'
  // error, since the Free plan only allows a couple of concurrent sessions.
  const existingRaw = await kv.get('run-status');
  if (existingRaw) {
    const existing = JSON.parse(existingRaw);
    if (existing.status === 'running') {
      const startedAt = existing.startedAt ? new Date(existing.startedAt).getTime() : 0;
      const ageMs = Date.now() - startedAt;
      // Treat a "running" run older than PAGE_TIMEOUT_MS * totalChecks as stale/dead
      // rather than trusting it forever, in case a prior invocation was killed
      // outright and never got to write an 'error' status.
      const staleAfterMs = PAGE_TIMEOUT_MS * Math.max(existing.total || 1, 1) + 60000;
      if (ageMs < staleAfterMs) {
        diag(`runChecks skipped — a run is already in progress`, `startedAt=${existing.startedAt}`);
        return null;
      }
      diag(`runChecks: previous run-status looked stale, proceeding anyway`, `ageMs=${ageMs}`);
    }
  }

  const totalChecks = SITES.length * Object.keys(VIEWPORTS).length;
  const progress = { status: 'running', total: totalChecks, completed: [], startedAt: new Date().toISOString() };
  await kv.put('run-status', JSON.stringify(progress));

  // Guard the whole run: without this, any unexpected failure (browser launch
  // hanging, a KV write erroring, etc.) leaves run-status stuck on 'running'
  // forever with no signal back to the polling UI, which is what made the
  // progress bar appear to freeze. Now a failure is recorded and surfaced.
  try {
    return await runChecksInner( progress, totalChecks);
  } catch (err) {
    progress.status = 'error';
    progress.error = String(err && err.message ? err.message : err);
    progress.finishedAt = new Date().toISOString();
    await kv.put('run-status', JSON.stringify(progress));
    throw err;
  }
}

// Self-hosted Chromium can still fail to launch transiently (OOM under load,
// a zombie process still holding the profile lock, etc.) — retry a couple of
// times with a short backoff before giving up for real.
async function launchBrowserWithRetry(maxAttempts = 3) {
  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      diag(`browser.launch attempt ${attempt} start`);
      const browser = await puppeteer.launch({
        headless: 'new',
        // --no-sandbox is required on most bare Linux servers unless you've
        // set up a dedicated unprivileged user + kernel namespaces for
        // Chrome's sandbox. Safe here since we only ever navigate to a
        // fixed, known list of URLs (see SITES above), not arbitrary input.
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
      });
      diag(`browser.launch attempt ${attempt} done`);
      return browser;
    } catch (err) {
      lastErr = err;
      diag(`browser.launch attempt ${attempt} failed`, String(err && err.message ? err.message : err));
      if (attempt === maxAttempts) break;
      const waitSeconds = attempt * 5; // 5s, 10s
      diag(`browser.launch retrying after ${waitSeconds}s`);
      await new Promise((resolve) => setTimeout(resolve, waitSeconds * 1000));
    }
  }
  throw lastErr;
}

async function runChecksInner( progress, totalChecks) {
  const browser = await launchBrowserWithRetry();
  const results = [];

  try {
    for (const siteUrl of SITES) {
      for (const [name, vp] of Object.entries(VIEWPORTS)) {
        diag(`checkPage call start`, `${siteUrl} [${name}]`);
        let result;
        try {
          result = await checkPage(browser, siteUrl, name, vp);
          diag(`checkPage call done`, `${siteUrl} [${name}] status=${result.status}`);
        } catch (err) {
          // Belt-and-braces: even if checkPage itself throws (e.g. browser.newPage()
          // failing), don't let one bad check take the whole batch down with it.
          diag(`checkPage threw`, `${siteUrl} [${name}] ${String(err && err.message ? err.message : err)}`);
          result = {
            url: siteUrl,
            viewport: name,
            status: 'DOWN',
            issues: [`Check errored: ${String(err && err.message ? err.message : err).split('\n')[0]}`],
            httpStatus: null,
            consoleErrors: [],
            failedRequests: [],
            brokenImages: [],
            hasOverflow: false,
            loadTimeMs: null,
            screenshotId: null,
            checkedAt: new Date().toISOString(),
          };
        }
        results.push(result);
        progress.completed.push({ url: siteUrl, viewport: name, status: result.status, loadTimeMs: result.loadTimeMs });
        diag(`KV run-status put start`, `${siteUrl} [${name}]`);
        await kv.put('run-status', JSON.stringify(progress));
        diag(`KV run-status put done`, `${siteUrl} [${name}]`);
      }
    }
  } finally {
    diag(`browser.close start`);
    await browser.close().catch(() => {});
    diag(`browser.close done`);
  }

  const timestampIso = new Date().toISOString();

  // Store screenshots separately as raw bytes, served via their own URL — keeps
  // report pages small and fast instead of embedding multi-MB base64 blobs inline.
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    if (r.screenshotBytes) {
      const screenshotId = `${timestampIso}-${i}`;
      await kv.put(`screenshot-${screenshotId}`, r.screenshotBytes, {
        expirationTtl: 60 * 60 * 24 * REPORT_HISTORY_DAYS,
      });
      r.screenshotId = screenshotId;
      delete r.screenshotBytes;
    }
  }

  // Small summary record so the /history list can show counts per run
  // without having to fetch and parse every full report.
  const bySite = {};
  for (const r of results) {
    bySite[r.url] = bySite[r.url] || [];
    bySite[r.url].push(r);
  }
  const downCount = Object.values(bySite).filter((e) => e.some((x) => x.status === 'DOWN')).length;
  const issueCount = Object.values(bySite).filter(
    (e) => !e.some((x) => x.status === 'DOWN') && e.some((x) => x.status === 'ISSUES')
  ).length;
  const okCount = Object.keys(bySite).length - downCount - issueCount;
  await kv.put(
    `summary-${timestampIso}`,
    JSON.stringify({ okCount, issueCount, downCount, totalSites: Object.keys(bySite).length }),
    { expirationTtl: 60 * 60 * 24 * REPORT_HISTORY_DAYS }
  );

  // Per-site worst status, for diffing against the previous run to detect
  // DOWN transitions (see checkForDownAlerts).
  const siteStatusMap = {};
  for (const [siteUrl, entries] of Object.entries(bySite)) {
    siteStatusMap[siteUrl] = entries.some((e) => e.status === 'DOWN')
      ? 'DOWN'
      : entries.some((e) => e.status === 'ISSUES')
      ? 'ISSUES'
      : 'OK';
  }
  await checkForDownAlerts(siteStatusMap);

  const html = generateHtmlReport(results, timestampIso);

  await kv.put('latest-report-html', html);
  await kv.put('latest-report-json', JSON.stringify(results));
  await kv.put(`report-${timestampIso}`, JSON.stringify(results), {
    expirationTtl: 60 * 60 * 24 * REPORT_HISTORY_DAYS,
  });

  progress.status = 'done';
  progress.finishedAt = timestampIso;
  await kv.put('run-status', JSON.stringify(progress));

  return results;
}

// Equivalent of wrangler.toml's `[triggers] crons = ["0 0 * * *"]` (00:00
// UTC = 07:00 Asia/Phnom_Penh) — expressed directly in local time here since
// we're no longer forced to think in UTC the way Workers cron triggers do.
// Override with the CRON_SCHEDULE / CRON_TIMEZONE env vars if needed.
function setupCronSchedule() {
  const schedule = process.env.CRON_SCHEDULE || '0 7 * * *';
  const timezone = process.env.CRON_TIMEZONE || 'Asia/Phnom_Penh';
  cron.schedule(
    schedule,
    () => {
      diag('cron triggered runChecks');
      runChecks().catch((err) => diag('cron runChecks unhandled rejection', String(err && err.message ? err.message : err)));
    },
    { timezone }
  );
  console.log(`Scheduled daily check: "${schedule}" (${timezone})`);
}

// ---- Settings (Telegram alerts) ----

const DEFAULT_SETTINGS = {
  telegramEnabled: false,
  telegramBotToken: '',
  telegramChatId: '',
};

async function getSettings() {
  const raw = await kv.get('settings');
  if (!raw) return { ...DEFAULT_SETTINGS };
  try {
    return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

async function saveSettings(partial) {
  const merged = { ...(await getSettings()), ...partial };
  await kv.put('settings', JSON.stringify(merged));
  return merged;
}

async function sendTelegramMessage(settings, text) {
  if (!settings.telegramBotToken || !settings.telegramChatId) {
    throw new Error('Telegram bot token and chat ID must both be set');
  }
  const url = `https://api.telegram.org/bot${settings.telegramBotToken}/sendMessage`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: settings.telegramChatId, text }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ok === false) {
    throw new Error(data.description || `Telegram API returned HTTP ${res.status}`);
  }
  return data;
}

// Alerts fire only on a site transitioning INTO 'DOWN' (not on every check
// while it stays down, and not on ISSUES/recovery — per what was asked for).
// Detecting a "transition" requires comparing against the previous run's
// per-site status, so we persist that map across runs. On the very first
// run ever (no previous map), nothing is alerted — that's a baseline being
// established, not a new failure, so it shouldn't page anyone.
async function checkForDownAlerts(siteStatusMap) {
  try {
    const settings = await getSettings();
    const prevRaw = await kv.get('previous-site-status');
    const prevMap = prevRaw ? JSON.parse(prevRaw) : null;

    if (prevMap && settings.telegramEnabled && settings.telegramBotToken && settings.telegramChatId) {
      for (const [siteUrl, status] of Object.entries(siteStatusMap)) {
        const prevStatus = prevMap[siteUrl];
        if (status === 'DOWN' && prevStatus !== 'DOWN') {
          const text = `🔴 DOWN: ${siteUrl}\n\nJust started failing health checks.`;
          try {
            await sendTelegramMessage(settings, text);
            diag('Telegram alert sent', siteUrl);
          } catch (err) {
            // Don't let a Telegram API failure (bad token, network blip, etc.)
            // interrupt the run itself — just log it.
            diag('Telegram alert failed', `${siteUrl}: ${String(err && err.message ? err.message : err)}`);
          }
        }
      }
    }
  } catch (err) {
    diag('checkForDownAlerts error', String(err && err.message ? err.message : err));
  } finally {
    // Persist regardless of whether alerting is even enabled, so that
    // turning alerts on later immediately has a correct baseline to diff
    // against instead of alerting on everything already down at that point.
    await kv.put('previous-site-status', JSON.stringify(siteStatusMap));
  }
}

const app = express();
app.use(express.urlencoded({ extended: false }));

// Express 4 does NOT automatically catch rejections from async route
// handlers — an unhandled rejection here just leaves the request hanging
// forever with no response and no visible error, which is exactly the
// silent-hang failure mode this whole project already spent a long debugging
// session chasing down on the Cloudflare version. Wrap every async handler
// so failures (e.g. Mongo unreachable) turn into a real 500 response instead.
function asyncHandler(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

app.get('/run', (req, res) => {
  // Fire-and-forget, same as Cloudflare's ctx.waitUntil(runChecks()) — the
  // Node process stays alive on its own (the HTTP server keeps the event
  // loop running), so we don't need an equivalent of waitUntil here. Any
  // failure is still caught and recorded by runChecks()'s own try/catch.
  runChecks().catch((err) => diag('runChecks unhandled rejection', String(err && err.message ? err.message : err)));
  res.type('html').send(generateRunningPageHtml());
});

// Synchronous JSON variant, useful for scripting/curl instead of the browser UI
app.get('/run.json', asyncHandler(async (req, res) => {
  const results = await runChecks();
  if (results === null) {
    return res.status(409).json({ ok: false, skipped: true, reason: 'A run is already in progress' });
  }
  const downCount = results.filter((r) => r.status === 'DOWN').length;
  const issueCount = results.filter((r) => r.status === 'ISSUES').length;
  res.json({ ok: true, checked: results.length, down: downCount, issues: issueCount });
}));

app.get('/run-status', asyncHandler(async (req, res) => {
  const json = await kv.get('run-status');
  res.set('cache-control', 'no-store').type('json').send(json || JSON.stringify({ status: 'idle', total: 0, completed: [] }));
}));

app.get('/report.json', asyncHandler(async (req, res) => {
  const json = await kv.get('latest-report-json');
  res.type('json').send(json || '[]');
}));

app.get('/screenshot/:id', asyncHandler(async (req, res) => {
  const bytes = await kv.get(`screenshot-${req.params.id}`, { type: 'arrayBuffer' });
  if (!bytes) return res.status(404).send('Screenshot not found or expired.');
  // Sniff the actual format rather than assuming JPEG — older entries stored
  // before this switch are still raw PNG bytes, and serving those with a
  // jpeg Content-Type would just trade one broken-image cause for another.
  const isPng = bytes.length > 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
  res.set('cache-control', 'public, max-age=2592000').type(isPng ? 'png' : 'jpeg').send(bytes);
}));

app.get('/history', asyncHandler(async (req, res) => {
  const list = await kv.list({ prefix: 'report-' });
  const entries = await Promise.all(
    list.keys.map(async (k) => {
      const ts = k.name.replace(/^report-/, '');
      const summaryJson = await kv.get(`summary-${ts}`);
      return { ts, summary: summaryJson ? JSON.parse(summaryJson) : null };
    })
  );
  res.type('html').send(generateHistoryListHtml(entries));
}));

app.get('/settings', asyncHandler(async (req, res) => {
  const settings = await getSettings();
  let flash = null;
  if (req.query.saved) flash = { type: 'ok', message: 'Settings saved.' };
  if (req.query.test === 'ok') flash = { type: 'ok', message: 'Test alert sent — check Telegram.' };
  if (req.query.test === 'error') flash = { type: 'error', message: `Test alert failed: ${req.query.msg || 'unknown error'}` };
  res.type('html').send(generateSettingsPageHtml(settings, flash));
}));

app.post('/settings', asyncHandler(async (req, res) => {
  await saveSettings({
    telegramEnabled: req.body.telegramEnabled === 'on',
    telegramBotToken: (req.body.telegramBotToken || '').trim(),
    telegramChatId: (req.body.telegramChatId || '').trim(),
  });
  res.redirect('/settings?saved=1');
}));

app.post('/settings/test-telegram', asyncHandler(async (req, res) => {
  const settings = await getSettings();
  try {
    await sendTelegramMessage(settings, '✅ Test alert from Site Health — Telegram alerts are wired up correctly.');
    res.redirect('/settings?test=ok');
  } catch (err) {
    res.redirect('/settings?test=error&msg=' + encodeURIComponent(String(err && err.message ? err.message : err)));
  }
}));

app.get('/history/:ts', asyncHandler(async (req, res) => {
  const ts = decodeURIComponent(req.params.ts);
  const json = await kv.get(`report-${ts}`);
  if (!json) {
    return res.status(404).send('Report not found — it may have expired (kept for ' + REPORT_HISTORY_DAYS + ' days).');
  }
  const html = generateHtmlReport(JSON.parse(json), ts, { isHistorical: true });
  res.type('html').send(html);
}));

app.get('/', asyncHandler(async (req, res) => {
  const html = await kv.get('latest-report-html');
  if (!html) {
    return res.send('No report yet. Visit /run to trigger the first check manually, or wait for the scheduled run.');
  }
  res.type('html').send(html);
}));

// Catches anything passed to next(err) by asyncHandler above — without this,
// Express's own default error handler still responds, but this gives us a
// clearer message and a log line pointing at what actually failed.
app.use((err, req, res, next) => {
  console.error('Unhandled route error:', err);
  if (res.headersSent) return next(err);
  res.status(500).send('Internal server error: ' + (err && err.message ? err.message : String(err)));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Site health checker listening on :${PORT}`);
});

setupCronSchedule();

'use strict';

/**
 * Generates a parent index.html for a staged cycle run.
 *
 * The page shows an overall status summary and links to each stage's
 * individual Playwright HTML report via relative paths (stage_N/index.html).
 */

const fs   = require('fs');
const path = require('path');

/** HTML-escape a value. */
function esc(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function fmtTimestamp(ts) {
  if (!ts || ts.length < 13) return ts || '';
  return `${ts.slice(0,4)}-${ts.slice(4,6)}-${ts.slice(6,8)} ${ts.slice(9,11)}:${ts.slice(11,13)}`;
}

function fmtDuration(ms) {
  if (!ms) return '';
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

/**
 * Generate the parent index.html for a staged cycle run.
 *
 * @param {object} opts
 * @param {string}   opts.cycleFolder    - Absolute path to the <timestamp>_cycle_run/ folder
 * @param {string}   opts.cycleName      - e.g. "cycle_smoke"
 * @param {string}   opts.cycleTimestamp - "YYYYMMDD-HHMMSS"
 * @param {string}   opts.project        - Project name
 * @param {string}   opts.environment    - Environment name
 * @param {Array}    opts.results        - Stage results from run-cycle-staged.js
 *                                         [{ stage, name, status, exitCode, stopped }]
 * @param {Array}    opts.testRecords    - Per-test RunIndexRecord objects (all stages)
 * @returns {string} Path to the generated index.html, or '' on failure.
 */
function generateCycleIndex({ cycleFolder, cycleName, cycleTimestamp, project, environment, results, testRecords }) {

  // ── Aggregate totals ──────────────────────────────────────────────────────
  let total = 0, passed = 0, failed = 0, skipped = 0, totalMs = 0, browser = '';
  for (const rec of testRecords) {
    total   += rec.summary?.total   || 0;
    passed  += rec.summary?.passed  || 0;
    failed  += rec.summary?.failed  || 0;
    skipped += (rec.summary?.skipped || 0) + (rec.summary?.timedOut || 0);
    totalMs += rec.durationMs       || 0;
    if (!browser) browser = rec.browser || '';
  }

  // SVG status icons matching Playwright's circle icons
  const pIcon = (sz) => `<svg width="${sz}" height="${sz}" viewBox="0 0 16 16" style="flex-shrink:0"><circle cx="8" cy="8" r="8" fill="#22c55e"/><path d="M4.5 8l2.5 2.5 4-4.5" stroke="#fff" stroke-width="1.5" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  const fIcon = (sz) => `<svg width="${sz}" height="${sz}" viewBox="0 0 16 16" style="flex-shrink:0"><circle cx="8" cy="8" r="8" fill="#ef4444"/><path d="M5.5 5.5l5 5M10.5 5.5l-5 5" stroke="#fff" stroke-width="1.5" stroke-linecap="round"/></svg>`;
  const sIcon = (sz) => `<svg width="${sz}" height="${sz}" viewBox="0 0 16 16" style="flex-shrink:0"><circle cx="8" cy="8" r="8" fill="#d1d5db"/><path d="M5 8h6" stroke="#fff" stroke-width="1.5" stroke-linecap="round"/></svg>`;
  const statusSvg = (status, sz) => status === 'passed' ? pIcon(sz) : status === 'failed' ? fIcon(sz) : sIcon(sz);

  // ── Stage expandable rows ─────────────────────────────────────────────────
  const stageItems = results.map((r, idx) => {
    const marker  = `stage_${r.stage}`;
    const stTests = testRecords.filter(rec => (rec.reportPath || '').replace(/\\/g, '/').includes(marker));
    const stP     = stTests.reduce((s, t) => s + (t.summary?.passed  || 0), 0);
    const stF     = stTests.reduce((s, t) => s + (t.summary?.failed  || 0), 0);
    const stT     = stTests.reduce((s, t) => s + (t.summary?.total   || 0), 0);
    const stMs    = stTests.reduce((s, t) => s + (t.durationMs        || 0), 0);
    const stopNote = r.stopped ? ` <span style="font-size:11px;color:#f59e0b;font-weight:400">⚠ cycle aborted here</span>` : '';

    // Nested test rows
    const testRows = stTests.map(t => {
      const parts   = (t.title || '').split('/');
      const display = parts.length > 1
        ? `<span style="color:#9ca3af">${esc(parts.slice(0,-1).join(' › '))}</span> › <strong>${esc(parts[parts.length-1])}</strong>`
        : `<strong>${esc(t.title || '')}</strong>`;
      const scen = t.scenario
        ? ` <span style="background:#fef3c7;color:#92400e;padding:1px 7px;border-radius:10px;font-size:11px;font-weight:500;white-space:nowrap">${esc(t.scenario)}</span>` : '';
      return `<div style="display:flex;align-items:center;justify-content:space-between;padding:7px 16px 7px 44px;border-bottom:1px solid #f9fafb;transition:background .08s" onmouseover="this.style.background='#f9fafb'" onmouseout="this.style.background=''">
        <div style="display:flex;align-items:center;gap:8px;overflow:hidden;flex:1">${statusSvg(t.status, 14)}<span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#1f2937">${display}${scen}</span></div>
        <span style="flex-shrink:0;font-size:11px;color:#9ca3af;margin-left:12px;white-space:nowrap">${fmtDuration(t.durationMs)}</span>
      </div>`;
    }).join('');

    const openLink = r.status !== 'skipped'
      ? `<a href="stage_${r.stage}/index.html" style="display:inline-flex;align-items:center;gap:5px;color:#2563eb;font-size:12px;text-decoration:none;font-weight:500;padding:4px 10px;border:1px solid #bfdbfe;border-radius:5px;transition:background .1s" onmouseover="this.style.background='#eff6ff'" onmouseout="this.style.background=''">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
          Open Stage ${r.stage} Report
        </a>` : '';

    const cntBadge = stT
      ? `<span style="flex-shrink:0;padding:1px 8px;border-radius:10px;font-size:11px;font-weight:500;${stF > 0 ? 'background:#fee2e2;color:#b91c1c' : 'background:#dcfce7;color:#15803d'}">${stP}/${stT}</span>` : '';

    // Stage title: link to the stage report (opens in new tab); chevron click expands details
    const stageTitleInner = r.status !== 'skipped'
      ? `<a href="stage_${r.stage}/index.html" target="_blank" onclick="event.stopPropagation()" style="color:inherit;text-decoration:none" onmouseover="this.querySelector('strong').style.textDecoration='underline'" onmouseout="this.querySelector('strong').style.textDecoration='none'"><span style="color:#9ca3af;font-weight:400">[Cycle] ${esc(cycleName)} › </span><strong>Stage ${r.stage}: ${esc(r.name)}</strong>${stopNote}</a>`
      : `<span><span style="color:#9ca3af;font-weight:400">[Cycle] ${esc(cycleName)} › </span><strong>Stage ${r.stage}: ${esc(r.name)}</strong>${stopNote}</span>`;

    return `<div style="border-bottom:1px solid #f3f4f6">
      <div style="display:flex;align-items:center;gap:8px;padding:9px 16px;cursor:pointer;transition:background .08s" onclick="toggle(${idx})" onmouseover="this.style.background='#f9fafb'" onmouseout="this.style.background=''">
        <svg id="chev-${idx}" width="12" height="12" viewBox="0 0 16 16" fill="#9ca3af" style="flex-shrink:0;transition:transform .18s"><path d="M6 4l4 4-4 4"/></svg>
        ${statusSvg(r.status, 16)}
        <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#1f2937">${stageTitleInner}</span>
        ${browser ? `<span style="flex-shrink:0;padding:1px 8px;border-radius:10px;font-size:11px;font-weight:500;background:#dbeafe;color:#1d4ed8">${esc(browser)}</span>` : ''}
        ${cntBadge}
        <span style="flex-shrink:0;font-size:12px;color:#9ca3af;white-space:nowrap">${fmtDuration(stMs)}</span>
      </div>
      <div id="body-${idx}" style="display:none;border-top:1px solid #f3f4f6">
        ${testRows || '<div style="padding:10px 16px 10px 44px;color:#9ca3af;font-size:12px">No test records found.</div>'}
      </div>
    </div>`;
  }).join('');

  const meta = [project, environment].filter(Boolean).map(esc).join(' · ');

  // ── HTML (light theme matching Playwright report) ─────────────────────────
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Playwright Test Report</title>
  <style>
    *,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
    body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;
         background:#fff;color:#1f2937;font-size:13px;line-height:1.5}
  </style>
</head>
<body>

  <!-- Top filter bar -->
  <div style="position:sticky;top:0;z-index:10;background:#fff;border-bottom:1px solid #e5e7eb;
              padding:8px 24px;display:flex;align-items:center;gap:6px;flex-wrap:wrap">
    <div style="display:flex;align-items:center;gap:6px;background:#f3f4f6;border-radius:6px;
                padding:5px 10px;color:#9ca3af;font-size:13px;width:240px">
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>
      Search tests
    </div>
    <span style="padding:4px 9px;border-radius:5px;font-size:12px;font-weight:500;background:#f3f4f6;color:#374151">All ${total}</span>
    <div style="width:1px;height:16px;background:#e5e7eb;margin:0 2px"></div>
    <span style="padding:4px 9px;border-radius:5px;font-size:12px;font-weight:500;display:inline-flex;align-items:center;gap:4px;color:#16a34a">${pIcon(12)} Passed ${passed}</span>
    <div style="width:1px;height:16px;background:#e5e7eb;margin:0 2px"></div>
    <span style="padding:4px 9px;border-radius:5px;font-size:12px;font-weight:500;display:inline-flex;align-items:center;gap:4px;color:#dc2626">${fIcon(12)} Failed ${failed}</span>
    <div style="width:1px;height:16px;background:#e5e7eb;margin:0 2px"></div>
    <span style="padding:4px 9px;font-size:12px;font-weight:500;color:#6b7280">Flaky 0</span>
    <div style="width:1px;height:16px;background:#e5e7eb;margin:0 2px"></div>
    <span style="padding:4px 9px;font-size:12px;font-weight:500;color:#6b7280">Skipped ${skipped}</span>
    <div style="margin-left:auto;font-size:12px;color:#6b7280;white-space:nowrap">
      <strong style="color:#374151">Project: ${esc(browser || 'chromium')}</strong>
      &nbsp;&nbsp;${fmtTimestamp(cycleTimestamp)}&nbsp;&nbsp;Total time: ${fmtDuration(totalMs)}
    </div>
  </div>

  <!-- Section header (cycle name) -->
  <div style="background:#f9fafb;border-bottom:1px solid #e5e7eb;padding:7px 24px;
              font-size:13px;font-weight:600;color:#374151;display:flex;align-items:center;gap:6px;max-width:1200px;margin:0 auto">
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#9ca3af" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
    ${esc(cycleName)}
    ${meta ? `<span style="font-weight:400;color:#9ca3af;font-size:12px;margin-left:4px">${meta}</span>` : ''}
  </div>

  <!-- Stage rows -->
  <div style="max-width:1200px;margin:0 auto">${stageItems}</div>

  <script>
    function toggle(i) {
      var b = document.getElementById('body-' + i);
      var c = document.getElementById('chev-' + i);
      var open = b.style.display !== 'none';
      b.style.display = open ? 'none' : 'block';
      c.style.transform = open ? '' : 'rotate(90deg)';
    }
  </script>
</body>
</html>`;

  try {
    fs.mkdirSync(cycleFolder, { recursive: true });
    const outPath = path.join(cycleFolder, 'index.html');
    fs.writeFileSync(outPath, html, 'utf-8');
    return outPath;
  } catch (err) {
    console.warn(`[cycle-report-generator] Failed to write index.html: ${err}`);
    return '';
  }
}

module.exports = { generateCycleIndex };

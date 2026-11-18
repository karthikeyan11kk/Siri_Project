/**
 * Staged Cycle Runner
 *
 * Runs each stage of a cycle JSON file as a separate playwright test invocation,
 * ensuring strict stage-by-stage sequencing while allowing intra-stage parallelism
 * (controlled by fullyParallel + workers in playwright-settings.json).
 *
 * Usage:
 *   node framework/scripts/run-cycle-staged.js <cycle-name> [options]
 *
 * Arguments:
 *   cycle-name          Name of the cycle file (with or without .json extension)
 *                       e.g.  cycle_smoke   or   cycle_smoke.json
 *
 * Options:
 *   --workers=N         Override the number of Playwright workers for every stage
 *   --project=NAME      Override the active project (else reads active-project.json)
 *   --headed            Run browsers in headed mode
 *   --dry-run           Print the commands that would be run without executing them
 *
 * Environment variables (alternative to CLI options):
 *   TARGET_JSON_CYCLE   Cycle name (same as positional arg)
 *   PW_PROJECT          Project name override
 *
 * Examples:
 *   node framework/scripts/run-cycle-staged.js cycle_smoke
 *   node framework/scripts/run-cycle-staged.js cycle_smoke --workers=4
 *   node framework/scripts/run-cycle-staged.js cycle_smoke --project=saucedemo --headed
 *   npm run cycle:staged -- cycle_smoke --workers=4
 */

'use strict';

const { spawnSync } = require('child_process');
const fs   = require('fs');
const os   = require('os');
const path = require('path');
const { generateCycleIndex } = require('./cycle-report-generator');
const { loadEnvFile } = require('./env-file');

const ROOT_DIR = path.resolve(__dirname, '../../');
const ACTIVE_PROJECT_PATH = path.join(ROOT_DIR, 'configs/active-project.json');
const SPEC_FILE = 'tests/csv-tests-driver.spec.ts';

loadEnvFile(path.join(ROOT_DIR, '.env'));

// ─── Timestamp helper (mirrors playwright.config.ts format: YYYYMMDD-HHMMSS) ─

function formatTimestamp(d) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

// ─── Run-index helpers ────────────────────────────────────────────────────────

// Mirrors the scope resolution in framework/references/playwright-config-utils.ts —
// scope="project" must load outputFolder from the project's own settings file,
// not the global one, or reports silently fall back to ./playwright-run-history/.
function resolveOutputFolder(projectName) {
  let scope = (process.env.PW_CONFIG || '').trim();
  if (!scope) {
    try {
      const activeProject = JSON.parse(fs.readFileSync(ACTIVE_PROJECT_PATH, 'utf-8'));
      const scopedPreference = String(activeProject?.scopesByProject?.[projectName] || '').trim();
      scope = (scopedPreference === 'local' || scopedPreference === 'project')
        ? scopedPreference
        : (activeProject.scope || 'local');
    } catch {
      scope = 'local';
    }
  }

  const settingsPath = (scope === 'project' && projectName)
    ? path.join(ROOT_DIR, 'projects', projectName, 'test-configs', 'playwright-settings.json')
    : path.join(ROOT_DIR, 'configs', 'playwright-settings.json');

  let outputFolder = '';
  try {
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
    outputFolder = (settings.outputFolder || '').trim();
  } catch {}
  return outputFolder;
}

function resolveRunIndexPath(projectName) {
  const outputFolder = resolveOutputFolder(projectName);
  const base = outputFolder || path.join(ROOT_DIR, 'playwright-run-history');
  const proj = (projectName || 'default').toLowerCase().replace(/[^a-z0-9_-]/g, '_');
  const isCicd = Boolean(process.env.CI || process.env.GITHUB_ACTIONS);
  return path.join(base, isCicd ? `${proj}-cicd_run-index.jsonl` : `${proj}_run-index.jsonl`);
}

function resolveCycleReportFolder(projectName, cycleName, cycleTimestamp) {
  const outputFolder = resolveOutputFolder(projectName);
  const base = outputFolder || path.join(ROOT_DIR, 'playwright-run-history');
  const proj = projectName || 'default';
  const year = cycleTimestamp.slice(0, 4);
  const key = (cycleName || 'unknown')
    .replace(/\.json$/i, '')
    .replace(/\\/g, '/')
    .replace(/^\/+|\/+$/g, '')
    .replace(/[<>:|"?*\x00-\x1F]/g, '_');
  return path.join(base, proj, year, ...key.split('/'), `${cycleTimestamp}_cycle_run`);
}

async function writeCycleSummary({ cycleName, projectName, runId, cycleTimestamp, cycleStartedAt, cycleReportFolder, results, testRecords, indexPath }) {
  let total = 0, passed = 0, failed = 0, skipped = 0, timedOut = 0, interrupted = 0, flaky = 0;
  let browser = '';
  let durationMs = 0;

  for (const rec of testRecords) {
    total += rec.summary?.total || 0;
    passed += rec.summary?.passed || 0;
    failed += rec.summary?.failed || 0;
    skipped += rec.summary?.skipped || 0;
    timedOut += rec.summary?.timedOut || 0;
    interrupted += rec.summary?.interrupted || 0;
    flaky += rec.summary?.flaky || 0;
    durationMs += rec.durationMs || 0;
    if (!browser) browser = rec.browser || '';
  }

  const overallStatus = results.some((r) => r.status === 'failed') ? 'failed' : 'passed';
  const cycleRecord = {
    recordType: 'cycle', runId, runTimestamp: cycleTimestamp, runType: 'cycle', cycle: cycleName,
    runSource: String(process.env.PW_RUN_SOURCE || 'unknown').toLowerCase(),
    project: (projectName || 'default').toLowerCase().replace(/[^a-z0-9_-]/g, '_'),
    environment: String(process.env.PW_ENV || ''), testId: '', title: cycleName, scenario: '',
    status: overallStatus, browser, startedAt: cycleStartedAt, endedAt: new Date().toISOString(),
    durationMs, reportPath: cycleReportFolder,
    summary: { total, passed, failed, skipped, timedOut, interrupted, flaky },
  };

  const payload = [cycleRecord, ...testRecords].map((r) => JSON.stringify(r)).join('\n') + '\n';
  let lockfile;
  try { lockfile = require('proper-lockfile'); } catch {}
  if (!fs.existsSync(indexPath)) fs.writeFileSync(indexPath, '', 'utf-8');
  if (lockfile) {
    const release = await lockfile.lock(indexPath, {
      retries: { retries: 5, minTimeout: 100, maxTimeout: 2000 }, stale: 10000,
    });
    try { fs.appendFileSync(indexPath, payload, 'utf-8'); }
    finally { await release(); }
  } else {
    fs.appendFileSync(indexPath, payload, 'utf-8');
  }
  console.log(`[run-cycle-staged] ${1 + testRecords.length} record(s) indexed → ${indexPath}`);
}

// ─── ANSI colours (stripped if not a TTY) ────────────────────────────────────

const isTTY = process.stdout.isTTY;
const c = {
  reset:  isTTY ? '\x1b[0m'  : '',
  bold:   isTTY ? '\x1b[1m'  : '',
  dim:    isTTY ? '\x1b[2m'  : '',
  green:  isTTY ? '\x1b[32m' : '',
  red:    isTTY ? '\x1b[31m' : '',
  yellow: isTTY ? '\x1b[33m' : '',
  cyan:   isTTY ? '\x1b[36m' : '',
  gray:   isTTY ? '\x1b[90m' : '',
};

// ─── Arg parsing ─────────────────────────────────────────────────────────────

function parseArgs() {
  const args = process.argv.slice(2);
  let cycleName = '';
  let workers = null;
  let projectName = '';
  let headed = false;
  let dryRun = false;

  for (const arg of args) {
    if (arg.startsWith('--workers=')) {
      workers = parseInt(arg.split('=')[1], 10) || null;
    } else if (arg.startsWith('--project=')) {
      projectName = arg.split('=')[1].trim();
    } else if (arg === '--headed') {
      headed = true;
    } else if (arg === '--dry-run') {
      dryRun = true;
    } else if (!arg.startsWith('--')) {
      cycleName = arg.trim().replace(/\.json$/i, '');
    }
  }

  if (!cycleName) {
    cycleName = (process.env.TARGET_JSON_CYCLE || '').trim().replace(/\.json$/i, '');
  }
  if (!projectName) {
    projectName = (process.env.PW_PROJECT || '').trim();
  }

  return { cycleName, workers, projectName, headed, dryRun };
}

// ─── Project / cycle helpers ──────────────────────────────────────────────────

function getActiveProjectName() {
  if (!fs.existsSync(ACTIVE_PROJECT_PATH)) return '';
  try {
    const cfg = JSON.parse(fs.readFileSync(ACTIVE_PROJECT_PATH, 'utf-8'));
    return String(cfg.projectName || '').trim();
  } catch {
    return '';
  }
}

function resolveCycleFile(projectName, cycleName) {
  const fileName = cycleName.endsWith('.json') ? cycleName : `${cycleName}.json`;
  const candidates = [];

  if (projectName) {
    candidates.push(path.join(ROOT_DIR, 'projects', projectName, 'test-cycles', fileName));
  }

  candidates.push(path.join(ROOT_DIR, fileName));

  if (path.isAbsolute(cycleName)) {
    candidates.push(cycleName.endsWith('.json') ? cycleName : `${cycleName}.json`);
  }

  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }

  // Walk all project cycle dirs as fallback
  const projectsDir = path.join(ROOT_DIR, 'projects');
  if (fs.existsSync(projectsDir)) {
    for (const proj of fs.readdirSync(projectsDir, { withFileTypes: true })) {
      if (!proj.isDirectory()) continue;
      const candidate = path.join(ROOT_DIR, 'projects', proj.name, 'test-cycles', fileName);
      if (fs.existsSync(candidate)) return candidate;
    }
  }

  return null;
}

// ─── Regex helpers (mirrors app-ui/public/app.js) ───────────────────────────

function escapeRegex(text) {
  return String(text || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeTestName(name) {
  return String(name || '').trim().replace(/\\/g, '/');
}

// ─── Stage runner ─────────────────────────────────────────────────────────────

function buildStageCommand(stage, cycleName, workers, headed) {
  // Grep matches the exact stage label: "Stage 1: Auth"
  // "Stage 1:" won't accidentally match "Stage 10:" because "Stage 1:" is not a
  // substring of "Stage 10:" (the char after '1' is '0', not ':').
  const grepPattern = `Stage ${stage.stage}:`;

  // When shell:true is used, Node joins all args with spaces into one shell string.
  // Without quoting, "--grep Stage 1:" splits into --grep=Stage and 1: as a stray
  // token — no tests are found. Wrap in double-quotes so the shell keeps it intact.
  const grepArg = `"${grepPattern}"`;

  // Do NOT pass --reporter here: any CLI --reporter flag overrides all reporters in
  // playwright.config.ts, which would suppress the custom record-runs reporter.
  // The reporters configured in playwright-settings.json (list, html, custom) apply automatically.
  const playwrightArgs = ['playwright', 'test', SPEC_FILE, '--grep', grepArg];

  if (workers != null) playwrightArgs.push(`--workers=${workers}`);
  if (headed)          playwrightArgs.push('--headed');

  // Build --grep-invert from tests marked enabled:false in this stage.
  // Mirrors the logic in app-ui/public/app.js (normalizeExecutionTestName + escapeRegex).
  const disabledPatterns = (stage.tests || [])
    .filter((entry) => entry.enabled === false)
    .map((entry) => escapeRegex(normalizeTestName(entry.test)))
    .filter(Boolean);

  let grepInvert = '';
  if (disabledPatterns.length > 0) {
    grepInvert = disabledPatterns.join('|');
    playwrightArgs.push('--grep-invert', `"${grepInvert}"`);
  }

  return { args: playwrightArgs, grepPattern, grepInvert };
}

function runStage(stage, cycleName, projectName, workers, headed, dryRun, tempFilePath, cycleTimestamp) {
  const { args, grepPattern, grepInvert } = buildStageCommand(stage, cycleName, workers, headed);
  const stageLabel = `Stage ${stage.stage}: ${stage.name}`;
  const execStr = `TARGET_JSON_CYCLE=${cycleName}.json npx ${args.join(' ')}`;

  console.log(`\n${c.cyan}${'═'.repeat(64)}${c.reset}`);
  console.log(`${c.bold}▶  ${stageLabel}${c.reset}  ${c.dim}[execution=${stage.execution} | tests=${stage.tests.length}]${c.reset}`);
  console.log(`${c.gray}   grep: "${grepPattern}"${c.reset}`);
  if (grepInvert) {
    console.log(`${c.gray}   skip: "${grepInvert}" (enabled=false)${c.reset}`);
  }
  console.log(`${c.gray}   cmd:  npx ${args.join(' ')}${c.reset}`);
  console.log(`${c.cyan}${'═'.repeat(64)}${c.reset}\n`);

  if (dryRun) {
    console.log(`${c.yellow}[dry-run] Skipping execution.${c.reset}`);
    return 0;
  }

  const env = {
    ...process.env,
    TARGET_JSON_CYCLE:        `${cycleName}.json`,
    PW_CYCLE_STAGE:           'true',           // suppress JSONL write inside the reporter
    PW_CYCLE_STAGE_NUM:       String(stage.stage), // used by playwright.config.ts for folder naming
    PW_CYCLE_RUN_TIMESTAMP:   cycleTimestamp,   // shared across all stages → same _cycle_run parent folder
    PW_CYCLE_STAGE_TEMP_FILE: tempFilePath,     // reporter writes per-test records here instead
  };
  if (projectName) env.PW_PROJECT = projectName;

  const result = spawnSync('npx', args, {
    stdio: 'inherit',
    env,
    cwd: ROOT_DIR,
    shell: true,
  });

  return result.status ?? 1;
}

// ─── Summary printer ──────────────────────────────────────────────────────────

function printSummary(cycleName, results) {
  const width = 64;
  const line = '═'.repeat(width);

  console.log(`\n${c.bold}${line}`);
  console.log(`  CYCLE SUMMARY  —  ${cycleName}`);
  console.log(`${line}${c.reset}`);

  for (const r of results) {
    let icon, color;
    if (r.status === 'passed')  { icon = '✔'; color = c.green; }
    else if (r.status === 'failed')  { icon = '✖'; color = c.red; }
    else                         { icon = '⏭'; color = c.dim; }

    const stopNote = r.status === 'failed' && r.stopped ? '  ← cycle aborted here' : '';
    console.log(`  ${color}${icon}  Stage ${r.stage}: ${r.name}${c.reset}  ${c.dim}[${r.status.toUpperCase()}]${stopNote}${c.reset}`);
  }

  console.log(`${c.bold}${'═'.repeat(width)}${c.reset}\n`);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const { cycleName, workers, projectName: argProject, headed, dryRun } = parseArgs();
  const projectName = argProject || getActiveProjectName();

  if (!cycleName) {
    console.error(`${c.red}[run-cycle-staged] Error: Cycle name is required.${c.reset}`);
    console.error('  Usage: node framework/scripts/run-cycle-staged.js <cycle-name> [--workers=N] [--project=NAME]');
    process.exit(1);
  }

  const cycleFile = resolveCycleFile(projectName, cycleName);
  if (!cycleFile) {
    console.error(`${c.red}[run-cycle-staged] Error: Could not find cycle file '${cycleName}.json'`);
    if (projectName) {
      console.error(`  Searched under: projects/${projectName}/test-cycles/ and workspace root.`);
    } else {
      console.error(`  No active project set. Pass --project=NAME or set active-project.json.`);
    }
    process.exit(1);
  }

  let cycle;
  try {
    cycle = JSON.parse(fs.readFileSync(cycleFile, 'utf-8'));
  } catch (e) {
    console.error(`${c.red}[run-cycle-staged] Failed to parse cycle JSON: ${e.message}${c.reset}`);
    process.exit(1);
  }

  const stages = (cycle.stages || []).slice().sort((a, b) => a.stage - b.stage);
  if (stages.length === 0) {
    console.error(`${c.yellow}[run-cycle-staged] Warning: Cycle '${cycleName}' has no stages.${c.reset}`);
    process.exit(0);
  }

  const width = 64;
  console.log(`\n${c.bold}╔${'═'.repeat(width - 2)}╗${c.reset}`);
  console.log(`${c.bold}║  Cycle   : ${(cycle.name || cycleName).padEnd(width - 14)}║${c.reset}`);
  console.log(`${c.bold}║  Project : ${(projectName || '(active)').padEnd(width - 14)}║${c.reset}`);
  console.log(`${c.bold}║  Stages  : ${String(stages.length).padEnd(width - 14)}║${c.reset}`);
  if (dryRun) {
    console.log(`${c.bold}║  ${c.yellow}DRY RUN — no tests will be executed${c.reset}${c.bold}${''.padEnd(width - 38)}║${c.reset}`);
  }
  console.log(`${c.bold}╚${'═'.repeat(width - 2)}╝${c.reset}`);

  // Guarantee a stable PW_RUN_ID shared across all stages (UI sets it; CLI may not)
  if (!process.env.PW_RUN_ID) {
    process.env.PW_RUN_ID = String(Date.now());
  }
  // Capture cycle start timestamp before any stage runs
  const cycleTimestamp = formatTimestamp(new Date());
  const cycleStartedAt  = new Date().toISOString();  // ISO for startedAt field
  const runId = process.env.PW_RUN_ID;

  const results = [];
  let aborted = false;
  const allTestRecords = [];  // collects per-test records from all stages in memory

  for (const stage of stages) {
    if (stage.enabled === false) {
      console.log(`\n${c.dim}⏭  Skipping Stage ${stage.stage}: ${stage.name} (disabled)${c.reset}`);
      results.push({ stage: stage.stage, name: stage.name, status: 'skipped', disabled: true });
      continue;
    }

    if (aborted) {
      console.log(`\n${c.dim}\u23ed  Skipping Stage ${stage.stage}: ${stage.name} (cycle aborted)${c.reset}`);
      results.push({ stage: stage.stage, name: stage.name, status: 'skipped' });
      continue;
    }

    // Temp file for this stage: reporter writes per-test records here
    const tempFile = path.join(os.tmpdir(), `cycle-stage-${runId}-${stage.stage}.jsonl`);
    try { fs.writeFileSync(tempFile, '', 'utf-8'); } catch {}

    const exitCode = runStage(stage, cycleName, projectName, workers, headed, dryRun, tempFile, cycleTimestamp);

    // Read per-test records from temp file into memory, then clean up
    try {
      const raw = fs.readFileSync(tempFile, 'utf-8');
      for (const line of raw.split('\n')) {
        const t = line.trim();
        if (t) { try { allTestRecords.push(JSON.parse(t)); } catch {} }
      }
      try { fs.unlinkSync(tempFile); } catch {}
    } catch {}
    const passed = exitCode === 0;
    const shouldStop = !passed && stage.stopOnStageFail !== false;

    results.push({
      stage: stage.stage,
      name: stage.name,
      status: passed ? 'passed' : 'failed',
      exitCode,
      stopped: shouldStop,
    });

    if (shouldStop) {
      console.error(`\n${c.red}⛔  Stage ${stage.stage}: "${stage.name}" failed (exitCode=${exitCode}).`);
      console.error(`   Stopping cycle because stopOnStageFail is not false.${c.reset}`);
      aborted = true;
    }
  }

  printSummary(cycleName, results);

  // Build the parent cycle report folder path and generate the summary index.html
  const cycleReportFolder = resolveCycleReportFolder(projectName, cycleName, cycleTimestamp);
  const indexHtmlPath = generateCycleIndex({
    cycleFolder:    cycleReportFolder,
    cycleName,
    cycleTimestamp,
    project:        projectName || 'default',
    environment:    String(process.env.PW_ENV || ''),
    results,
    testRecords:    allTestRecords,
  });
  if (indexHtmlPath) {
    console.log(`[run-cycle-staged] Cycle index generated \u2192 ${indexHtmlPath}`);
  }

  // Write exactly ONE cycle-level summary + all per-test records (collected in memory)
  const indexPath = resolveRunIndexPath(projectName);
  await writeCycleSummary({ cycleName, projectName, runId, cycleTimestamp, cycleStartedAt, cycleReportFolder, results, testRecords: allTestRecords, indexPath });
  const anyFailed = results.some((r) => r.status === 'failed');
  process.exit(anyFailed ? 1 : 0);
}

main().catch((err) => {
  console.error(`[run-cycle-staged] Fatal error: ${err.message || err}`);
  process.exit(1);
});

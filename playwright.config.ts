import * as fs from 'fs';
import * as path from 'path';
import { defineConfig, devices } from '@playwright/test';
import { loadPlaywrightConfig, buildPlaywrightProjects } from './framework/references/playwright-config-utils';

const config = loadPlaywrightConfig();
const useCustomReporter = config.reporter.includes('custom');
const useRecordRunsReporter = useCustomReporter ||
  String(process.env.PW_DESIGN_ZEPHYR_UPDATE || '').trim().toLowerCase() === 'true';

// Expose the output base folder to reporters (e.g. record-runs.ts) via env var.
// Mirrors the same default used by getHtmlOutputFolder().
if (!process.env.PW_OUTPUT_FOLDER) {
  process.env.PW_OUTPUT_FOLDER = config.outputFolder || path.join(process.cwd(), 'playwright-run-history');
}

// Resolve project name: env var (set by server) → active-project.json → fallback
function resolveProjectName(): string {
  if (process.env.PW_PROJECT) return process.env.PW_PROJECT.trim();
  try {
    const data = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'configs', 'active-project.json'), 'utf-8'));
    return String(data.projectName || '').trim() || 'default';
  } catch {
    return 'default';
  }
}

// Resolve environment name: env var (set by server) → active-project.json → fallback
function resolveEnvironmentName(projectName: string): string {
  if (process.env.PW_ENV) return process.env.PW_ENV.trim();
  try {
    const data = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'configs', 'active-project.json'), 'utf-8'));
    return String(data.environmentsByProject?.[projectName] || data.environmentName || '').trim();
  } catch {
    return '';
  }
}

// Resolve scope: env var → active-project.json.scopesByProject[project] → 'local'
function resolveScope(projectName: string): string {
  if (process.env.PW_CONFIG) return process.env.PW_CONFIG.trim();
  try {
    const data = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'configs', 'active-project.json'), 'utf-8'));
    return String(data.scopesByProject?.[projectName] || data.scope || 'local').trim();
  } catch {
    return 'local';
  }
}

// Stamp resolved context into env once so workers and spec files read env vars, not files.
// Only writes if not already set — CI/server pre-set values are never overwritten.
if (!process.env.PW_PROJECT) {
  process.env.PW_PROJECT = resolveProjectName();
}
if (!process.env.PW_CONFIG) {
  process.env.PW_CONFIG = resolveScope(process.env.PW_PROJECT);
}
if (!process.env.PW_ENV) {
  process.env.PW_ENV = resolveEnvironmentName(process.env.PW_PROJECT);
}

// Derive test key path from what's being targeted
function resolveTestKeyPath(): string {
  const raw =
    String(process.env.TARGET_CSV_SCRIPT || '').trim() ||
    String(process.env.TARGET_JSON_CYCLE || '').trim() ||
    String(process.env.PW_GREP || '').trim() ||
    'all-tests';
  return raw
    .replace(/\.(csv|json)$/i, '')
    .replace(/\\/g, '/')
    .replace(/^\/+|\/+$/g, '')
    .replace(/[<>:"|?*\x00-\x1F]/g, '_')
    || 'all-tests';
}

// Stamp stable run values once for custom history or Design publishing.
if (useRecordRunsReporter && !process.env.PW_RUN_TIMESTAMP) {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  process.env.PW_RUN_TIMESTAMP = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  process.env.PW_RUN_ID = process.env.PW_RUN_ID || String(Date.now());
  // PW_PROJECT, PW_CONFIG, PW_ENV already stamped unconditionally above
}

function getHtmlOutputFolder(): string | null {
  if (!useCustomReporter) {
    // outputFolder is only meaningful for the custom history system — never hand a
    // non-custom reporter the raw shared outputFolder, or it will clear/rewrite it directly.
    return null;
  }
  const base      = config.outputFolder || path.join(process.cwd(), 'playwright-run-history');
  const project   = process.env.PW_PROJECT || resolveProjectName();
  const year      = process.env.PW_RUN_TIMESTAMP!.slice(0, 4);
  const testKey   = resolveTestKeyPath();
  const timestamp = process.env.PW_RUN_TIMESTAMP!;

  let folder: string;

  if (process.env.PW_CYCLE_STAGE === 'true') {
    // Staged cycle stage → <base>/<project>/<year>/<cycleName>/<cycleRunTs>_cycle_run/stage_N/
    // PW_CYCLE_RUN_TIMESTAMP is set by run-cycle-staged.js so ALL stages share the same
    // parent _cycle_run folder, making relative links in the parent index.html work.
    const stageNum    = String(process.env.PW_CYCLE_STAGE_NUM     || '').trim();
    const cycleRunTs  = String(process.env.PW_CYCLE_RUN_TIMESTAMP || timestamp).trim();
    const cycleYear   = cycleRunTs.slice(0, 4);
    folder = path.join(base, project, cycleYear, ...testKey.split('/'), `${cycleRunTs}_cycle_run`, `stage_${stageNum}`);
  } else {
    const isCycle = Boolean(String(process.env.TARGET_JSON_CYCLE || '').trim()) ||
                    String(process.env.PW_RUN_TYPE || '').toLowerCase() === 'cycle';
    if (isCycle) {
      // Normal (non-staged) cycle → <base>/<project>/<year>/<cycleName>/<timestamp>_cycle_run/
      folder = path.join(base, project, year, ...testKey.split('/'), `${timestamp}_cycle_run`);
    } else {
      // Script run → <base>/<project>/<year>/<testKey>/<timestamp>_script_run/
      folder = path.join(base, project, year, ...testKey.split('/'), `${timestamp}_script_run`);
    }
  }

  process.env.PW_REPORT_HTML_FOLDER = folder;
  return folder;
}

function buildReporterConfig(): any {
  const htmlFolder = getHtmlOutputFolder();
  // When 'custom' is selected, always include 'list' and 'html' alongside record-runs.ts,
  // even if the user only ticked 'custom' in the settings.
  const effectiveReporters = [...config.reporter.filter((r) => r !== 'custom')];
  if (useCustomReporter) {
    if (!effectiveReporters.includes('html'))  effectiveReporters.push('html');
    if (!effectiveReporters.includes('list'))  effectiveReporters.push('list');
  }
  // Filter out 'custom' — it's a meta-option, not a real Playwright reporter
  const reporters: any[] = effectiveReporters.map((r) => {
      if (r === 'allure') return ['allure-playwright'];
      if (r === 'html') return htmlFolder ? ['html', { outputFolder: htmlFolder, open: 'never' }] : ['html'];
      return [r];
    });
  if (useRecordRunsReporter && !reporters.some(([reporter]) =>
    path.resolve(reporter) === path.resolve('./framework/references/record-runs.ts'))) {
    reporters.push(['./framework/references/record-runs.ts']);
  }
  return reporters;
}

export default defineConfig({
  testDir: config.testDir,
  testMatch: config.testMatch,
  ...(config.outputDir ? { outputDir: config.outputDir } : {}),
  snapshotPathTemplate: `${config.snapshotDir}/{arg}{ext}`,
  fullyParallel: config.fullyParallel,
  forbidOnly: config.forbidOnly,
  retries: config.retries,
  workers: config.workers,
  reporter: buildReporterConfig(),
  timeout: config.timeoutMs,
  expect: {
    timeout: config.expectTimeoutMs,
  },
  use: {
    baseURL: config.baseURL || 'https://www.saucedemo.com',
    actionTimeout: config.actionTimeoutMs,
    navigationTimeout: config.navigationTimeoutMs,
    launchOptions: {
      args: config.launchArgs,
      slowMo: config.slowMo,
    },
    trace: config.trace as any,
    ignoreHTTPSErrors: config.ignoreHTTPSErrors,
    screenshot: config.screenshot as any,
    video: config.video as any,
  },
  projects: buildPlaywrightProjects(
    devices as unknown as Record<string, unknown>,
    config.browsers,
    {
      width: config.viewportWidth,
      height: config.viewportHeight,
    }
  )
});


import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type {
  FullConfig,
  FullResult,
  Reporter,
  Suite,
  TestCase,
  TestResult,
} from '@playwright/test/reporter';
import { publishZephyrScriptResults, publishZephyrTestResults } from '../integrations/zephyr-publisher';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type RunType = 'script' | 'cycle';
export type RunSource = 'ui' | 'cicd' | 'terminal' | 'vscode' | 'unknown';

/**
 * Single unified record shape for every entry in the run-index JSONL.
 *
 * recordType | runType  | cycle        | When written
 * ---------- | -------- | ------------ | ------------------------------------------
 * 'test'     | 'script' | ''           | Once per scenario/test in a script run
 * 'cycle'    | 'cycle'  | <cycleName>  | Once per cycle run — aggregated summary
 * 'test'     | 'cycle'  | <cycleName>  | Once per test/scenario inside a cycle
 */
export type RunIndexRecord = {
  recordType: 'test' | 'cycle';
  runId: string;
  runTimestamp: string;
  runType: RunType;
  cycle: string;       // cycle name for cycle runs; '' for script runs
  runSource: RunSource;
  project: string;
  environment: string;
  testId: string;      // Playwright test.id (per-test rows) | runId (summary rows)
  title: string;       // full test.title, e.g. "TC001_Login [TC_001]"
  scenario: string;    // extracted scenario name, e.g. "TC_001"; '' if not data-driven
  status: string;
  browser: string;     // playwright project name, e.g. 'chromium'
  startedAt: string;   // ISO 8601 — result.startTime for per-test; process start for summaries
  endedAt: string;     // ISO 8601 — startedAt + durationMs for per-test; process end for summaries
  durationMs: number;  // ms — result.duration for per-test; elapsed wall-clock for summaries
  retry?: number;      // zero-based Playwright retry number for per-test records
  reportPath: string;
  systemName: string;   // os.hostname() at test-runner time
  userId: string;       // os.userInfo().username at test-runner time
  failureReason?: string;  // user-entered root-cause note (editable from Test Reports UI)
  jiraBug?: string;        // user-entered Jira ticket ID (editable from Test Reports UI)
  summary: {
    total: number;
    passed: number;
    failed: number;
    skipped: number;
    timedOut: number;
    interrupted: number;
    flaky: number;
  };
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// OS identity — resolved once at module load time so all records in a run share the same values.
const OS_HOSTNAME = (() => { try { return os.hostname(); } catch { return ''; } })();
const OS_USERNAME = (() => { try { return os.userInfo().username; } catch { return ''; } })();

function logRecordRuns(level: 'log' | 'warn' | 'error', message: string): void {
  const border = '='.repeat(72);
  console[level](`${border}\n[record-runs] ${message}\n${border}`);
}

function normalizeRunSource(value: string): RunSource {
  const raw = String(value || '').trim().toLowerCase();
  if (raw === 'ui') return 'ui';
  if (raw === 'cicd' || raw === 'ci' || raw === 'cd') return 'cicd';
  if (raw === 'terminal' || raw === 'cli') return 'terminal';
  if (raw === 'vscode' || raw === 'vs-code' || raw === 'run-icon') return 'vscode';
  return 'unknown';
}

export function resolveRunSourceFromEnv(): RunSource {
  const explicit = normalizeRunSource(process.env.PW_RUN_SOURCE || '');
  if (explicit !== 'unknown') return explicit;

  const isCi =
    String(process.env.CI || '').trim().toLowerCase() === 'true' ||
    Boolean(
      process.env.GITHUB_ACTIONS ||
      process.env.TF_BUILD ||
      process.env.BUILD_BUILDID ||
      process.env.JENKINS_HOME ||
      process.env.GITLAB_CI ||
      process.env.BUILDKITE
    );
  if (isCi) return 'cicd';

  const termProgram = String(process.env.TERM_PROGRAM || '').trim().toLowerCase();
  const hasVsCode = Boolean(process.env.VSCODE_PID || process.env.VSCODE_CWD || process.env.VSCODE_IPC_HOOK_CLI);

  if (termProgram === 'vscode') return 'terminal';
  if (hasVsCode) return 'vscode';
  if (process.stdout.isTTY) return 'terminal';
  return 'unknown';
}

export function resolveRunTypeFromEnv(): RunType {
  const explicit = String(process.env.PW_RUN_TYPE || '').trim().toLowerCase();
  if (explicit === 'cycle') return 'cycle';
  if (explicit === 'script') return 'script';
  if (String(process.env.TARGET_JSON_CYCLE || '').trim()) return 'cycle';
  return 'script';
}

/** Returns the cycle name for cycle runs, or '' for single-script / design-page runs. */
function resolveCycleName(): string {
  return String(process.env.TARGET_JSON_CYCLE || '').trim()
    .replace(/\.json$/i, '')
    .replace(/\\/g, '/');
}

/** Extract scenario name from a test title of the form "TestName [ScenarioName]". */
function extractScenario(title: string): string {
  const match = title.match(/\[(.+)\]$/);
  return match ? match[1] : '';
}
function getBrowserFromTest(test: TestCase): string {
  let suite: any = test.parent;
  while (suite) {
    if (typeof suite.project === 'function') {
      const proj = suite.project() as { name?: string } | undefined;
      if (proj?.name) return proj.name;
    }
    suite = suite.parent;
  }
  return '';
}

// JSONL path: <PW_OUTPUT_FOLDER>/<project>_run-index.jsonl
// Falls back to: playwright-run-history/<project>_run-index.jsonl when PW_OUTPUT_FOLDER is not set.
// Accepts an array of records (test rows + run-summary row) and writes them all in a single
// lock acquisition — one lock per playwright run regardless of how many tests ran.
async function appendToRunIndex(repoRoot: string, records: RunIndexRecord[]): Promise<void> {
  if (records.length === 0) return;
  const project = String(process.env.PW_PROJECT || '').trim().toLowerCase().replace(/[^a-z0-9_-]/g, '_') || 'default';

  // Resolve target directory and filename.
  // PW_OUTPUT_FOLDER is set by playwright.config.ts; falls back to playwright-run-history
  // (same default the HTML reporter uses when outputFolder is cleared in the UI).
  const outputBase = String(process.env.PW_OUTPUT_FOLDER || '').trim()
    || path.join(repoRoot, 'playwright-run-history');
  const indexDir  = outputBase;
  // CI runs (GitHub Actions / any CI system) write to a separate file to keep local and CI history distinct
  const isCicd = Boolean(process.env.CI || process.env.GITHUB_ACTIONS);
  const indexPath = path.join(indexDir, isCicd ? `${project}-cicd_run-index.jsonl` : `${project}_run-index.jsonl`);

  try {
    fs.mkdirSync(indexDir, { recursive: true });
  } catch {
    // ignore — directory may already exist
  }

  // One-time migration: move existing run-index.jsonl from the old test-results location
  const oldDir  = path.join(repoRoot, 'projects', project, 'test-results');
  const oldPath = path.join(oldDir, 'run-index.jsonl');
  if (fs.existsSync(oldPath) && !fs.existsSync(indexPath)) {
    try {
      const oldContent = fs.readFileSync(oldPath, 'utf-8');
      if (oldContent.trim()) fs.writeFileSync(indexPath, oldContent, 'utf-8');
      fs.unlinkSync(oldPath);
      try { fs.rmdirSync(oldDir); } catch { /* folder not empty — leave it */ }
      logRecordRuns('log', `Migrated run history: ${oldPath} → ${indexPath}`);
    } catch (err) {
      logRecordRuns('warn', `Migration warning: ${err}`);
    }
  }

  // Load proper-lockfile dynamically — fail gracefully with a clear message if not installed
  let lockfile: any;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    lockfile = require('proper-lockfile');
  } catch {
    logRecordRuns('error',
      '❌ proper-lockfile is not installed — run history will NOT be recorded for this run.\n' +
      '   Fix: npm install proper-lockfile    (run from the repo root)'
    );
    return;
  }

  const line = records.map(r => JSON.stringify(r)).join('\n') + '\n';

  // proper-lockfile requires the target file to already exist before locking
  if (!fs.existsSync(indexPath)) {
    try { fs.writeFileSync(indexPath, '', 'utf-8'); } catch { /* another process beat us — that's fine */ }
  }

  let release: (() => Promise<void>) | null = null;
  try {
    release = await lockfile.lock(indexPath, {
      retries: { retries: 5, minTimeout: 100, maxTimeout: 2000 },
      stale: 10000, // treat lock as stale after 10s — protects against crashed processes
    });

    fs.appendFileSync(indexPath, line, 'utf-8');

    if (!process.env.TEST_WORKER_INDEX) {
      logRecordRuns('log', `${records.length} record(s) indexed → ${indexPath}`);
    }
  } catch (err) {
    logRecordRuns('warn', `Failed to write run-index.jsonl: ${err}`);
  } finally {
    if (release) {
      try { await release(); } catch { /* ignore unlock errors */ }
    }
  }
}

// ---------------------------------------------------------------------------
// Playwright Reporter
// ---------------------------------------------------------------------------

class RecordRunsReporter implements Reporter {
  private startedAtMs = 0;
  private startedAtIso = '';
  private expectedTotal = 0;
  private passed = 0;
  private failed = 0;
  private skipped = 0;
  private timedOut = 0;
  private interrupted = 0;
  private flaky = 0;
  private browser = '';
  private perTestRecords: RunIndexRecord[] = [];

  onBegin(_config: FullConfig, suite: Suite): void {
    this.startedAtMs = Date.now();
    this.startedAtIso = new Date(this.startedAtMs).toISOString();
    this.expectedTotal = suite.allTests().length;
  }

  onTestEnd(test: TestCase, result: TestResult): void {
    const s = result.status;
    if (s === 'passed') this.passed++;
    else if (s === 'failed') this.failed++;
    else if (s === 'skipped') this.skipped++;
    else if (s === 'timedOut') this.timedOut++;
    else if (s === 'interrupted') this.interrupted++;
    const isFlaky = result.retry > 0 && s === 'passed';
    if (isFlaky) this.flaky++;

    // Capture browser once from the first test (all tests in a single run share the same browser)
    if (!this.browser) this.browser = getBrowserFromTest(test);

    // Collect one 'test' record per Playwright TestCase (both script and cycle runs)
    const runType = resolveRunTypeFromEnv();
    const testRecord: RunIndexRecord = {
      recordType:   'test',
      runId:        String(process.env.PW_RUN_ID || '').trim(),
      runTimestamp: String(process.env.PW_RUN_TIMESTAMP || '').trim(),
      runType,
      cycle:        resolveCycleName(),
      runSource:    resolveRunSourceFromEnv(),
      project:      String(process.env.PW_PROJECT || '').trim() || 'default',
      environment:  String(process.env.PW_ENV || '').trim(),
      testId:       test.id,
      title:        test.title,
      scenario:     extractScenario(test.title),
      status:       s,
      browser:      getBrowserFromTest(test),
      startedAt:    result.startTime.toISOString(),
      endedAt:      new Date(result.startTime.getTime() + result.duration).toISOString(),
      durationMs:   result.duration,
      retry:        result.retry,
      reportPath:   String(process.env.PW_REPORT_HTML_FOLDER || '').trim(),
      systemName:   OS_HOSTNAME,
      userId:       OS_USERNAME,
      summary: {
        total:       1,
        passed:      s === 'passed'      ? 1 : 0,
        failed:      s === 'failed'      ? 1 : 0,
        skipped:     s === 'skipped'     ? 1 : 0,
        timedOut:    s === 'timedOut'    ? 1 : 0,
        interrupted: s === 'interrupted' ? 1 : 0,
        flaky:       isFlaky             ? 1 : 0,
      },
    };
    this.perTestRecords.push(testRecord);

  }

  async onEnd(result: FullResult): Promise<void> {
    const endedAtMs   = Date.now();
    const runType     = resolveRunTypeFromEnv();
    const cycle       = resolveCycleName();
    const runId       = String(process.env.PW_RUN_ID || endedAtMs).trim();
    const runTimestamp = String(process.env.PW_RUN_TIMESTAMP || '').trim();
    const project     = String(process.env.PW_PROJECT || '').trim() || 'default';
    const environment = String(process.env.PW_ENV || '').trim();
    const reportPath  = String(process.env.PW_REPORT_HTML_FOLDER || '').trim();
    const testKey     = (String(process.env.TARGET_CSV_SCRIPT || process.env.TARGET_JSON_CYCLE || process.env.PW_GREP || '').trim()
      .replace(/\.(csv|json)$/i, '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '') || 'all-tests');
    const runSource   = resolveRunSourceFromEnv();
    const status      = String(result.status || '').trim();
    const summary = {
      total:       this.expectedTotal,
      passed:      this.passed,
      failed:      this.failed,
      skipped:     this.skipped,
      timedOut:    this.timedOut,
      interrupted: this.interrupted,
      flaky:       this.flaky,
    };

    const records: RunIndexRecord[] = [];

    if (runType === 'cycle') {
      await publishZephyrTestResults(project, cycle, this.perTestRecords);
    } else if (String(process.env.PW_DESIGN_ZEPHYR_UPDATE || '').trim().toLowerCase() === 'true') {
      await publishZephyrScriptResults(this.perTestRecords);
    }

    if (runType === 'cycle') {
      if (process.env.PW_CYCLE_STAGE === 'true') {
        // Staged mode: write per-test records to the temp file provided by run-cycle-staged.js.
        // The parent process collects records from all stages and writes the JSONL in one shot.
        const tempFilePath = (process.env.PW_CYCLE_STAGE_TEMP_FILE || '').trim();
        if (tempFilePath && this.perTestRecords.length > 0) {
          const lines = this.perTestRecords.map(r => JSON.stringify(r)).join('\n') + '\n';
          try { fs.writeFileSync(tempFilePath, lines, 'utf-8'); }
          catch (err) { logRecordRuns('warn', `Failed to write stage temp file: ${err}`); }
        }
        return; // run-cycle-staged.js writes to JSONL after all stages complete
      }
      // Normal (non-staged) cycle: write cycle summary then per-test records
      records.push({
        recordType: 'cycle',
        runId, runTimestamp, runType: 'cycle', cycle,
        runSource, project, environment,
        testId: '', title: cycle, scenario: '',
        status, browser: this.browser,
        startedAt: this.startedAtIso,
        endedAt: new Date(endedAtMs).toISOString(),
        durationMs: Math.max(0, endedAtMs - this.startedAtMs), reportPath,
        systemName: OS_HOSTNAME, userId: OS_USERNAME,
        summary,
      });
      records.push(...this.perTestRecords);
    } else {
      // Script run: only per-scenario records, no summary record
      records.push(...this.perTestRecords);
    }

    await appendToRunIndex(process.cwd(), records);
  }
}

export default RecordRunsReporter;

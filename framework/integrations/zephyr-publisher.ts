import * as fs from 'fs';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { createZephyrTestExecution } from './zephyr-scale';

const ROOT_DIR = path.resolve(__dirname, '../..');

type CycleEntry = {
  test?: string;
  testId?: string;
};

export type ZephyrTestRecord = {
  title: string;
  scenario: string;
  browser: string;
  status: string;
  durationMs: number;
  endedAt: string;
  testId: string;
  reportPath?: string;
  retry?: number;
};

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[character]!));
}

function buildReportLinks(records: ZephyrTestRecord[]): string[] {
  return records.flatMap((record) => {
    const reportPath = String(record.reportPath || '').trim();
    if (!reportPath || !record.testId) return [];
    const normalized = reportPath.replace(/\\/g, '/').replace(/\/$/, '');
    const indexPath = /\/index\.html$/i.test(normalized) ? normalized : `${normalized}/index.html`;
    const url = /^[a-z]:\//i.test(indexPath)
      ? new URL(`file:///${indexPath.split('/').map((part, index) => index === 0 ? part : encodeURIComponent(part)).join('/')}`)
      : pathToFileURL(indexPath);
    url.hash = `?testId=${encodeURIComponent(record.testId)}`;
    const label = record.scenario ? `Report (${record.scenario})` : 'Report';
    return [`${escapeHtml(label)}: <a href="${escapeHtml(url.href)}">${escapeHtml(url.href)}</a>`];
  });
}

function normalizeTestName(name: string): string {
  return String(name || '').trim().replace(/\\/g, '/').replace(/\.csv$/i, '');
}

function readJsonIfExists(filePath: string): any | null {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    return null;
  }
}

function isZephyrEnabled(): boolean {
  return /^(1|true|yes|on)$/i.test(String(process.env.ZEPHYR_ENABLED || '').trim());
}

function resolveCycleFile(projectName: string, cycleName: string): string | null {
  const fileName = cycleName.endsWith('.json') ? cycleName : `${cycleName}.json`;
  const candidates = [
    path.join(ROOT_DIR, 'projects', projectName, 'test-cycles', fileName),
    path.join(ROOT_DIR, fileName),
  ];

  return candidates.find((candidate) => fs.existsSync(candidate)) || null;
}

/** Zephyr cycle key comes only from the cycle JSON's zephyrCycleKeysByEnvironment. */
function resolveZephyrCycleKey(
  projectName: string,
  cycleName: string,
  environmentName: string,
): string {
  const cycleFile = resolveCycleFile(projectName, cycleName);
  const cycle = cycleFile ? readJsonIfExists(cycleFile) : null;
  const keysByEnv = cycle?.zephyrCycleKeysByEnvironment;
  const envUpper = environmentName.toUpperCase();
  return keysByEnv && typeof keysByEnv === 'object'
    ? String(keysByEnv[envUpper] ?? keysByEnv[environmentName] ?? '').trim()
    : '';
}

function findTestCaseKey(projectName: string, cycleName: string, testTitle: string): string {
  const cycleFile = resolveCycleFile(projectName, cycleName);
  const cycle = cycleFile ? readJsonIfExists(cycleFile) : null;
  const normalizedTitle = normalizeTestName(testTitle);

  for (const stage of cycle?.stages || []) {
    for (const entry of (stage.tests || []) as CycleEntry[]) {
      const testName = normalizeTestName(entry.test || '');
      const testId = String(entry.testId || '').trim();
      if (testId && (normalizedTitle === testName || normalizedTitle.startsWith(`${testName} [`))) {
        return testId;
      }
    }
  }

  return '';
}

function getBaseTestName(title: string): string {
  return String(title || '').trim().replace(/\s*\[[^\]]*\]\s*$/, '');
}

function normalizeStatus(status: string): string {
  const normalized = String(status || '').trim().toLowerCase();
  if (normalized === 'timedout') return 'failed';
  if (normalized === 'interrupted') return 'skipped';
  return normalized;
}

function buildScenarioComment(records: ZephyrTestRecord[]): string {
  const scenarioGroups = new Map<string, ZephyrTestRecord[]>();
  for (const record of records) {
    const scenario = String(record.scenario || '').trim() || '(default)';
    const group = scenarioGroups.get(scenario) || [];
    group.push(record);
    scenarioGroups.set(scenario, group);
  }

  const lines: string[] = [];
  for (const [scenario, attempts] of scenarioGroups) {
    const attemptStatuses = attempts.map((record, index) => {
      const attempt = Number.isFinite(record.retry) ? Number(record.retry) + 1 : index + 1;
      return `Attempt ${attempt}: ${normalizeStatus(record.status) || 'unknown'}`;
    });
    const finalStatus = normalizeStatus(attempts[attempts.length - 1].status) || 'unknown';
    lines.push(`- ${scenario}: ${attemptStatuses.join(', ')} (final: ${finalStatus})`);
    lines.push(...buildReportLinks([attempts[attempts.length - 1]]));
  }

  return lines.join('<br>');
}

/** Publish one aggregate Zephyr execution per test and browser. */
export async function publishZephyrTestResults(
  projectName: string,
  cycleName: string,
  records: ZephyrTestRecord[],
): Promise<void> {
  if (!projectName || !cycleName || records.length === 0) {
    console.warn('[zephyr] Skipped publishing: project, cycle, or test records are missing.');
    return;
  }
  if (!isZephyrEnabled()) {
    console.warn('[zephyr] Skipped publishing: ZEPHYR_ENABLED is not enabled.');
    return;
  }

  const environmentName = String(process.env.PW_ENV || '').trim();
  const testCycleKey = resolveZephyrCycleKey(projectName, cycleName, environmentName);
  if (!testCycleKey) {
    console.warn(`[zephyr] Skipped publishing: no cycle key configured for ${cycleName} in environment '${environmentName || '(unset)'}'.`);
    return;
  }

  const token = String(process.env.ZEPHYR_SCALE_TOKEN || '').trim();
  if (!token) {
    console.warn('[zephyr] Skipped publishing: ZEPHYR_SCALE_TOKEN is not configured.');
    return;
  }

  await publishAggregateResults(cycleName, String(process.env.ZEPHYR_PROJECT_KEY || '').trim(), testCycleKey, records, token,
    (title) => findTestCaseKey(projectName, cycleName, title));
}

export async function publishZephyrScriptResults(records: ZephyrTestRecord[]): Promise<void> {
  if (String(process.env.PW_DESIGN_ZEPHYR_UPDATE || '').trim().toLowerCase() !== 'true') return;
  if (!isZephyrEnabled()) {
    console.warn('[zephyr] Skipped Design publishing: ZEPHYR_ENABLED is not enabled.');
    return;
  }

  const testCycleKey = String(process.env.PW_DESIGN_ZEPHYR_CYCLE_ID || '').trim();
  const projectKey = String(process.env.PW_DESIGN_ZEPHYR_PROJECT_KEY || '').trim();
  const testCaseKey = String(process.env.PW_DESIGN_ZEPHYR_TEST_ID || '').trim();
  if (!testCycleKey || !projectKey || !testCaseKey || records.length === 0) {
    console.warn('[zephyr] Skipped Design publishing: project key, cycle ID, script test ID, or test records are missing.');
    return;
  }
  const token = String(process.env.ZEPHYR_SCALE_TOKEN || '').trim();
  if (!token) {
    console.warn('[zephyr] Skipped publishing: ZEPHYR_SCALE_TOKEN is not configured.');
    return;
  }

  await publishAggregateResults(testCycleKey, projectKey, testCycleKey, records, token, () => testCaseKey);
}

async function publishAggregateResults(
  cycleName: string,
  projectKey: string,
  testCycleKey: string,
  records: ZephyrTestRecord[],
  token: string,
  resolveTestCaseKey: (title: string) => string,
): Promise<void> {
  const environmentName = String(process.env.PW_ENV || '').trim();
  const executedById = String(process.env.ZEPHYR_SCALE_EXECUTED_BY_ID || '').trim();
  const groups = new Map<string, ZephyrTestRecord[]>();
  for (const record of records) {
    const key = `${getBaseTestName(record.title)}\u0000${record.browser || '(unknown)'}`;
    const group = groups.get(key) || [];
    group.push(record);
    groups.set(key, group);
  }

  for (const group of groups.values()) {
    const first = group[0];
    const testName = getBaseTestName(first.title);
    const testCaseKey = resolveTestCaseKey(first.title);
    if (!testCaseKey) {
      console.warn(`[zephyr] Skipped ${testName}: no Zephyr testId is configured.`);
      continue;
    }

    const scenarios = new Map<string, ZephyrTestRecord[]>();
    for (const record of group) {
      const scenario = String(record.scenario || '').trim() || '(default)';
      const scenarioRecords = scenarios.get(scenario) || [];
      scenarioRecords.push(record);
      scenarios.set(scenario, scenarioRecords);
    }
    const finalScenarioRecords = [...scenarios.values()].map((scenarioRecords) => scenarioRecords[scenarioRecords.length - 1]);
    const aggregateStatus = finalScenarioRecords.some((record) => normalizeStatus(record.status) === 'failed')
      ? 'failed'
      : finalScenarioRecords.some((record) => normalizeStatus(record.status) === 'skipped')
        ? 'skipped'
        : 'passed';
    const comment = [
      `Cycle: ${cycleName}`,
      `Test: ${testName}`,
      `Browser: ${first.browser || '(unknown)'}`,
      'Scenario results:',
      buildScenarioComment(group),
      `Overall: ${aggregateStatus}`,
    ].join('<br>');
    const latestEnd = group.reduce((latest, record) => {
      const endedAt = new Date(record.endedAt);
      return !Number.isNaN(endedAt.getTime()) && endedAt > latest ? endedAt : latest;
    }, new Date(0));

    try {
      const published = await createZephyrTestExecution({
        token,
        projectKey,
        testCycleKey,
        environmentName,
        executedById: executedById || undefined,
      }, {
        testCaseKey,
        status: aggregateStatus,
        durationMs: group.reduce((total, record) => total + Number(record.durationMs || 0), 0),
        actualEndDate: latestEnd.getTime() ? latestEnd : new Date(),
        comment,
      });
      console.log(`[zephyr] ${testCaseKey} ${first.browser || 'unknown'}: ${published.action}${published.executionKey ? ` (${published.executionKey})` : ''}`);
    } catch (error) {
      console.warn(`[zephyr] ${testCaseKey} ${first.browser || 'unknown'}: upload failed: ${error instanceof Error ? error.message : error}`);
    }
  }
}
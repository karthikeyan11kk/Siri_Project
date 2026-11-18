const fs = require('fs/promises');
const fssync = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '../..');
const PROJECTS_ROOT = path.join(REPO_ROOT, 'projects');
const GLOBAL_PLAYWRIGHT_SETTINGS_FILE = path.join(REPO_ROOT, 'configs', 'playwright-settings.json');

const DEFAULT_PLAYWRIGHT_SETTINGS = {
  testDir: 'tests',
  testMatch: '**/*.spec.ts',
  browsers: ['chromium'],
  fullyParallel: false,
  forbidOnly: false,
  retries: 0,
  workers: 1,
  reporter: ['html'],
  timeoutMs: 5 * 60 * 1000,
  expectTimeoutMs: 10000,
  actionTimeoutMs: 20000,
  navigationTimeoutMs: 20000,
  viewportWidth: 1440,
  viewportHeight: 900,
  baseURL: '',
  ignoreHTTPSErrors: false,
  trace: 'on-first-retry',
  slowMo: 0,
  screenshot: 'only-on-failure',
  stepScreenshotMode: 'all-steps',
  stepScreenshotHighlight: false,
  stepScreenshotFullPage: false,
  video: 'retain-on-failure',
  snapshotDir: 'test-snapshots',
  outputDir: '',
  outputFolder: '',
  launchArgs: ['--disable-features=LocalNetworkAccessChecks']
};

function getProjectRoot(projectName) {
  return path.join(PROJECTS_ROOT, projectName);
}

function getProjectConfigDir(projectName) {
  return path.join(getProjectRoot(projectName), 'test-configs');
}

function getApplicationsConfigPath(projectName) {
  return path.join(getProjectConfigDir(projectName), 'applications.json');
}

function getCredentialsConfigPath(projectName) {
  return path.join(getProjectConfigDir(projectName), 'credentials.json');
}

function getProjectSettingsPath(projectName) {
  return path.join(getProjectConfigDir(projectName), 'playwright-settings.json');
}

async function readJsonIfExists(filePath, fallback) {
  try {
    const content = await fs.readFile(filePath, 'utf-8');
    return JSON.parse(content);
  } catch {
    return fallback;
  }
}

async function writeJsonFile(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf-8');
}

function normalizeProjectName(rawName) {
  return String(rawName || '').trim();
}

function validateProjectName(projectName) {
  if (!projectName) {
    throw new Error('Project name is required.');
  }

  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(projectName)) {
    throw new Error('Project name can only contain letters, numbers, underscore, and hyphen.');
  }
}

function normalizePlaywrightSettings(value) {
  const source = value && typeof value === 'object' ? value : {};
  const asNonNegativeInt = (candidate, fallback) => {
    const parsed = Number(candidate);
    if (!Number.isFinite(parsed) || parsed < 0) {
      return fallback;
    }
    return Math.floor(parsed);
  };
  const toBoolean = (val) => {
    if (typeof val === 'boolean') return val;
    if (typeof val === 'string') {
      return val.toLowerCase() === 'true' || val === '1';
    }
    return !!val;
  };
  const screenshotOptions = new Set(['off', 'on', 'only-on-failure']);
  const videoOptions = new Set(['off', 'on', 'retain-on-failure', 'on-first-retry']);
  const reporterOptions = new Set(['html', 'dot', 'json', 'junit', 'list', 'github', 'allure']);
  const traceOptions = new Set(['on', 'off', 'on-first-retry', 'retain-on-failure']);
  const browserOptions = new Set(['chromium', 'firefox', 'webkit']);

  let launchArgs = [];
  if (Array.isArray(source.launchArgs)) {
    launchArgs = source.launchArgs.map((arg) => String(arg || '').trim()).filter(Boolean);
  } else if (typeof source.launchArgs === 'string') {
    launchArgs = source.launchArgs.split(/\r?\n/).map((arg) => arg.trim()).filter(Boolean);
  }

  let browsers = [];
  if (Array.isArray(source.browsers)) {
    browsers = source.browsers.map((name) => String(name || '').trim()).filter((name) => browserOptions.has(name));
  } else if (typeof source.browsers === 'string') {
    browsers = source.browsers
      .split(/[\r\n,]+/)
      .map((name) => name.trim())
      .filter((name) => browserOptions.has(name));
  }

  return {
    testDir: String(source.testDir || DEFAULT_PLAYWRIGHT_SETTINGS.testDir).trim(),
    testMatch: String(source.testMatch || DEFAULT_PLAYWRIGHT_SETTINGS.testMatch).trim(),
    browsers: browsers.length ? [...new Set(browsers)] : [...DEFAULT_PLAYWRIGHT_SETTINGS.browsers],
    fullyParallel: toBoolean(source.fullyParallel),
    forbidOnly: toBoolean(source.forbidOnly),
    retries: asNonNegativeInt(source.retries, DEFAULT_PLAYWRIGHT_SETTINGS.retries),
    workers: Math.max(1, asNonNegativeInt(source.workers, DEFAULT_PLAYWRIGHT_SETTINGS.workers)),
    reporter: (() => { const arr = Array.isArray(source.reporter) ? source.reporter : [String(source.reporter || '').trim()]; const filtered = arr.map((r) => String(r || '').trim()).filter((r) => reporterOptions.has(r)); return filtered.length ? [...new Set(filtered)] : [...DEFAULT_PLAYWRIGHT_SETTINGS.reporter]; })(),
    timeoutMs: asNonNegativeInt(source.timeoutMs, DEFAULT_PLAYWRIGHT_SETTINGS.timeoutMs),
    expectTimeoutMs: asNonNegativeInt(source.expectTimeoutMs, DEFAULT_PLAYWRIGHT_SETTINGS.expectTimeoutMs),
    actionTimeoutMs: asNonNegativeInt(source.actionTimeoutMs, DEFAULT_PLAYWRIGHT_SETTINGS.actionTimeoutMs),
    navigationTimeoutMs: asNonNegativeInt(source.navigationTimeoutMs, DEFAULT_PLAYWRIGHT_SETTINGS.navigationTimeoutMs),
    viewportWidth: Math.max(1, asNonNegativeInt(source.viewportWidth, DEFAULT_PLAYWRIGHT_SETTINGS.viewportWidth)),
    viewportHeight: Math.max(1, asNonNegativeInt(source.viewportHeight, DEFAULT_PLAYWRIGHT_SETTINGS.viewportHeight)),
    baseURL: String(source.baseURL || DEFAULT_PLAYWRIGHT_SETTINGS.baseURL).trim(),
    ignoreHTTPSErrors: toBoolean(source.ignoreHTTPSErrors),
    trace: traceOptions.has(String(source.trace || '').trim())
      ? String(source.trace).trim()
      : DEFAULT_PLAYWRIGHT_SETTINGS.trace,
    slowMo: asNonNegativeInt(source.slowMo, DEFAULT_PLAYWRIGHT_SETTINGS.slowMo),
    screenshot: screenshotOptions.has(String(source.screenshot || '').trim())
      ? String(source.screenshot).trim()
      : DEFAULT_PLAYWRIGHT_SETTINGS.screenshot,
    video: videoOptions.has(String(source.video || '').trim())
      ? String(source.video).trim()
      : DEFAULT_PLAYWRIGHT_SETTINGS.video,
    snapshotDir: String(source.snapshotDir || DEFAULT_PLAYWRIGHT_SETTINGS.snapshotDir).trim(),
    snapshotPathTemplate: String(source.snapshotPathTemplate || DEFAULT_PLAYWRIGHT_SETTINGS.snapshotPathTemplate).trim(),
    launchArgs: launchArgs.length ? launchArgs : [...DEFAULT_PLAYWRIGHT_SETTINGS.launchArgs]
  };
}

function toPascalCase(value) {
  return String(value || '')
    .replace(/[^a-zA-Z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('');
}

async function createProjectScaffold(rawProjectName) {
  const projectName = normalizeProjectName(rawProjectName);
  validateProjectName(projectName);

  const projectRoot = getProjectRoot(projectName);
  const requiredDirs = [
    'test-pages',
    'test-scripts',
    'test-flows',
    'test-data',
    'test-results',
    'test-cycles',
    'test-configs',
    'test-snapshots'
  ];

  await fs.mkdir(projectRoot, { recursive: true });
  for (const dirName of requiredDirs) {
    await fs.mkdir(path.join(projectRoot, dirName), { recursive: true });
  }

  const applicationsPath = getApplicationsConfigPath(projectName);
  if (!fssync.existsSync(applicationsPath)) {
    await writeJsonFile(applicationsPath, {
      version: 1,
      defaultEnvironment: '',
      defaultUiApplicationId: '',
      applications: []
    });
  }

  const credentialsPath = getCredentialsConfigPath(projectName);
  if (!fssync.existsSync(credentialsPath)) {
    await writeJsonFile(credentialsPath, {
      version: 1,
      defaultRole: '',
      roles: {}
    });
  }

  const projectPlaywrightSettingsPath = getProjectSettingsPath(projectName);
  if (!fssync.existsSync(projectPlaywrightSettingsPath)) {
    const globalPlaywrightSettings = await readJsonIfExists(
      GLOBAL_PLAYWRIGHT_SETTINGS_FILE,
      DEFAULT_PLAYWRIGHT_SETTINGS
    );
    await writeJsonFile(projectPlaywrightSettingsPath, normalizePlaywrightSettings(globalPlaywrightSettings));
  }

  const rawConfigVarBase = projectName.replace(/[^a-zA-Z0-9]/g, '');
  const safeConfigVarBase = /^[a-zA-Z_]/.test(rawConfigVarBase) ? rawConfigVarBase : `Project${rawConfigVarBase}`;
  const configVarName = `${safeConfigVarBase || 'project'}Project`;
  const starterConfigPath = path.join(projectRoot, 'test-configs', 'project.config.ts');
  if (!fssync.existsSync(starterConfigPath)) {
    const displayName = toPascalCase(projectName) || projectName;
    const starterConfigContent = [
      "import * as path from 'path';",
      "import { FrameworkProjectConfig } from '../../../framework/references/schema_types';",
      '',
      `export const ${configVarName}: FrameworkProjectConfig = {`,
      `  name: '${projectName}',`,
      `  displayName: '${displayName}',`,
      "  baseURL: process.env.BASE_URL || 'http://localhost:3000',",
      "  testsRootDir: path.resolve(__dirname, '../test-scripts'),",
      "  testDataRootDir: path.resolve(__dirname, '../test-data'),",
      "  testFlowsRootDir: path.resolve(__dirname, '../test-flows'),",
      "  testCyclesRootDir: path.resolve(__dirname, '../test-cycles'),",
      "  pageFactories: {},",
      '};',
      ''
    ].join('\n');

    await fs.writeFile(starterConfigPath, starterConfigContent, 'utf-8');
  }

  const sampleCsvPath = path.join(projectRoot, 'test-scripts', 'tc_sample_smoke.csv');
  if (!fssync.existsSync(sampleCsvPath)) {
    const sampleCsvContent = [
      'Run,Step,Action,Page,Object,Condition,Data',
      'Y,1,GOTO,,,,https://example.com',
      'Y,2,WAIT_FOR_URL,,,,example.com',
      'Y,3,ASSERT_URL_CONTAINS,,,,example.com',
      ''
    ].join('\n');

    await fs.writeFile(sampleCsvPath, sampleCsvContent, 'utf-8');
  }

  return {
    projectName,
    projectRoot,
    configDir: getProjectConfigDir(projectName)
  };
}

module.exports = {
  createProjectScaffold,
  normalizeProjectName,
  validateProjectName,
  DEFAULT_PLAYWRIGHT_SETTINGS
};
import * as fs from 'fs';
import * as path from 'path';
import { test } from '@playwright/test';
import { CSVTestRunner } from '../framework/runners/csv-runner';
import { getConfiguredProjects, getProjectByName } from '../framework/references/project_registry';
import {
  FrameworkProjectConfig,
  ResolvedProjectRuntime,
  TestCycleEntry,
  TestCycleStage,
} from '../framework/references/schema_types';
import { resolveProjectRuntime } from '../framework/references/runtime_resolver';
import {
  discoverCycleFiles,
  executeCycleEntry,
  getScenarioDrivenConfig,
  getCycleName,
  loadCycleConfig,
  normalizeScenarioFetchStep,
  resolveCycleRuntime,
  resolveCycleEntryCsvPath,
} from '../framework/runners/cycle-runner';

type ActiveProjectConfig = {
  projectName?: string;
};

type TargetSelection =
  | { mode: 'csv'; value: string }
  | { mode: 'json'; value: string }
  | { mode: 'none'; value: '' };

const activeProjectConfigPath = path.resolve(__dirname, '../configs/active-project.json');

/**
 * Resolves environment name for a project by reading active-project.json
 */
function resolveEnvironmentForProject(projectName: string): string {
  let environmentName = '';
  if (fs.existsSync(activeProjectConfigPath)) {
    const activeProject = JSON.parse(fs.readFileSync(activeProjectConfigPath, 'utf-8'));
    // Try environmentsByProject first
    if (activeProject.environmentsByProject && activeProject.environmentsByProject[projectName]) {
      environmentName = activeProject.environmentsByProject[projectName];
    } else if (activeProject.environmentName) {
      environmentName = activeProject.environmentName;
    }
  }
  return environmentName;
}

/**
 * Reads timeout values from the correct Playwright config JSON file (local or project scope)
 * Resolves scope internally by reading active-project.json
 */
function getTimeoutsForProjectScope(projectName: string) {
  let scope = 'local';
  // env var takes priority over active-project.json
  const scopeFromEnv = String(process.env.PW_CONFIG || '').trim().toLowerCase();
  if (scopeFromEnv === 'project' || scopeFromEnv === 'local') {
    scope = scopeFromEnv;
  } else if (fs.existsSync(activeProjectConfigPath)) {
    const activeProject = JSON.parse(fs.readFileSync(activeProjectConfigPath, 'utf-8'));
    if (activeProject.scopesByProject && activeProject.scopesByProject[projectName]) {
      scope = activeProject.scopesByProject[projectName];
    } else if (activeProject.scope) {
      scope = activeProject.scope;
    }
  }
  
  // Load config based on resolved scope
  let configPath;
  if (scope === 'project' && projectName) {
    configPath = path.resolve(__dirname, `../projects/${projectName}/test-configs/playwright-settings.json`);
  } else {
    configPath = path.resolve(__dirname, '../configs/playwright-settings.json');
  }
  let config: Record<string, unknown> = {};
  if (fs.existsSync(configPath)) {
    config = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as Record<string, unknown>;
  }
  return {
    testTimeoutMs: Number(config.timeoutMs) || 5 * 60 * 1000,
    expectTimeoutMs: Number(config.expectTimeoutMs) || 10000,
    actionTimeoutMs: Number(config.actionTimeoutMs) || 20000,
    navigationTimeoutMs: Number(config.navigationTimeoutMs) || 20000,
  };
}

function getStepScreenshotConfigForProjectScope(projectName: string) {
  let scope = 'local';
  // env var takes priority over active-project.json
  const scopeFromEnv = String(process.env.PW_CONFIG || '').trim().toLowerCase();
  if (scopeFromEnv === 'project' || scopeFromEnv === 'local') {
    scope = scopeFromEnv;
  } else if (fs.existsSync(activeProjectConfigPath)) {
    const activeProject = JSON.parse(fs.readFileSync(activeProjectConfigPath, 'utf-8'));
    if (activeProject.scopesByProject && activeProject.scopesByProject[projectName]) {
      scope = activeProject.scopesByProject[projectName];
    } else if (activeProject.scope) {
      scope = activeProject.scope;
    }
  }

  let configPath;
  if (scope === 'project' && projectName) {
    configPath = path.resolve(__dirname, `../projects/${projectName}/test-configs/playwright-settings.json`);
  } else {
    configPath = path.resolve(__dirname, '../configs/playwright-settings.json');
  }

  let config: Record<string, unknown> = {};
  if (fs.existsSync(configPath)) {
    config = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as Record<string, unknown>;
  }

  const rawMode = String(config.stepScreenshotMode ?? 'off').trim().toLowerCase();
  const mode = rawMode === 'all-steps' ? ('all-steps' as const) : ('off' as const);
  const rawFullPage = String(config.stepScreenshotFullPage ?? 'false').trim().toLowerCase();
  const fullPage = rawFullPage === 'true' || rawFullPage === '1' || rawFullPage === 'yes';
  const rawHighlight = String(config.stepScreenshotHighlight ?? 'true').trim().toLowerCase();
  const highlight = rawHighlight === 'true' || rawHighlight === '1' || rawHighlight === 'yes';

  return { mode, fullPage, highlight };
}

/**
 * Discover all CSV files recursively (excluding runners folder)
 */
function discoverCsvFiles(rootDir: string): string[] {
  if (!fs.existsSync(rootDir)) {
    return [];
  }

  const entries = fs.readdirSync(rootDir, { withFileTypes: true });

  return entries
    .filter((entry) => entry.name !== 'runners' && entry.name !== 'old_runners' && entry.name !== 'pages')
    .flatMap((entry) => {
      const fullPath = path.join(rootDir, entry.name);

      if (entry.isDirectory()) {
        return discoverCsvFiles(fullPath);
      }

      if (entry.isFile() && fullPath.endsWith('.csv')) {
        return [fullPath];
      }

      return [];
    })
    .sort();
}

/**
 * Get suite name from file path (top-level folder)
 */
function getSuiteName(rootDir: string, filePath: string): string {
  const relativePath = path.relative(rootDir, filePath);
  const [topLevelDir = 'csv'] = relativePath.split(path.sep);
  return topLevelDir;
}

/**
 * Get test name from file path
 */
function getTestName(rootDir: string, filePath: string): string {
  const relativePath = path.relative(rootDir, filePath);
  return relativePath.replace(/\\/g, '/').replace(/\.csv$/, '');
}


function buildSuitesForProject(project: FrameworkProjectConfig, csvTargetPath?: string): Map<string, string[]> {
  const csvFiles = csvTargetPath ? [csvTargetPath] : discoverCsvFiles(project.testsRootDir);
  const suites = new Map<string, string[]>();

  for (const filePath of csvFiles) {
    const suiteName = getSuiteName(project.testsRootDir, filePath);
    const existing = suites.get(suiteName) ?? [];
    existing.push(filePath);
    suites.set(suiteName, existing);
  }

  return suites;
}

function getActiveProjectNameFromFile(): string {
  if (!fs.existsSync(activeProjectConfigPath)) {
    return '';
  }

  const fileContent = fs.readFileSync(activeProjectConfigPath, 'utf-8');
  const parsed = JSON.parse(fileContent) as ActiveProjectConfig;
  return String(parsed.projectName || '').trim();
}

function getSelectedProjects(): FrameworkProjectConfig[] {
  const configuredProjects = getConfiguredProjects();
  const projectName = (process.env.PW_PROJECT || '').trim() || getActiveProjectNameFromFile();

  if (!projectName) {
    return configuredProjects.slice(0, 1);
  }

  const selectedProject = getProjectByName(projectName);
  if (!selectedProject) {
    const available = configuredProjects.map((project) => project.name).join(', ');
    throw new Error(`Unknown active project '${projectName}'. Available projects: ${available}`);
  }

  return [selectedProject];
}

const selectedProjects = getSelectedProjects();

function readCliFlagValue(flagName: string): string {
  const exactPrefix = `${flagName}=`;

  for (let i = 0; i < process.argv.length; i += 1) {
    const arg = String(process.argv[i] || '').trim();
    if (!arg) continue;

    if (arg.startsWith(exactPrefix)) {
      return arg.slice(exactPrefix.length).trim();
    }

    if (arg === flagName) {
      return String(process.argv[i + 1] || '').trim();
    }
  }

  return '';
}

function getTargetSelection(): TargetSelection {
  const csvValue =
    String(process.env.TARGET_CSV_SCRIPT || '').trim() ||
    String(process.env.CSV_TARGET_SCRIPT || '').trim() ||
    String(process.env.CSV_SCRIPT || '').trim() ||
    String(process.env.npm_config_csv || '').trim() ||
    readCliFlagValue('--csv') ||
    readCliFlagValue('--csv-script');

  const cycleValue =
    String(process.env.TARGET_JSON_CYCLE || '').trim() ||
    String(process.env.CSV_TARGET_CYCLE || '').trim() ||
    String(process.env.CSV_CYCLE || '').trim() ||
    String(process.env.npm_config_cycle || '').trim() ||
    readCliFlagValue('--cycle') ||
    readCliFlagValue('--cycle-name');

  if (csvValue && cycleValue) {
    throw new Error(
      'Set only one target: CSV (TARGET_CSV_SCRIPT/--csv) or cycle (TARGET_JSON_CYCLE/--cycle), not both.'
    );
  }

  if (csvValue) {
    return { mode: 'csv', value: csvValue };
  }

  if (cycleValue) {
    return { mode: 'json', value: cycleValue };
  }

  return { mode: 'none', value: '' };
}

function normalizeInputPath(input: string): string {
  return String(input || '').trim().replace(/^["']|["']$/g, '').replace(/\\/g, '/');
}

function isPathWithin(baseDir: string, candidatePath: string): boolean {
  const relative = path.relative(path.resolve(baseDir), path.resolve(candidatePath));
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function resolveCsvTargetForProject(project: FrameworkProjectConfig, input: string): string {
  const normalizedInput = normalizeInputPath(input);
  if (!normalizedInput) {
    throw new Error('CSV target is empty.');
  }

  const candidates = new Set<string>();
  const withExt = normalizedInput.toLowerCase().endsWith('.csv') ? normalizedInput : `${normalizedInput}.csv`;

  if (path.isAbsolute(normalizedInput)) {
    candidates.add(path.resolve(normalizedInput));
  }
  if (path.isAbsolute(withExt)) {
    candidates.add(path.resolve(withExt));
  }

  candidates.add(path.resolve(project.testsRootDir, normalizedInput));
  candidates.add(path.resolve(project.testsRootDir, withExt));
  candidates.add(path.resolve(__dirname, '..', normalizedInput));
  candidates.add(path.resolve(__dirname, '..', withExt));

  for (const candidate of candidates) {
    if (
      fs.existsSync(candidate) &&
      fs.statSync(candidate).isFile() &&
      isPathWithin(project.testsRootDir, candidate)
    ) {
      return candidate;
    }
  }

  const allCsvFiles = discoverCsvFiles(project.testsRootDir);
  const expectedRelative = withExt.toLowerCase();
  const expectedBase = path.basename(withExt).toLowerCase();

  const matched = allCsvFiles.find((filePath) => {
    const relative = path.relative(project.testsRootDir, filePath).replace(/\\/g, '/').toLowerCase();
    const base = path.basename(filePath).toLowerCase();
    return relative === expectedRelative || relative.endsWith(`/${expectedRelative}`) || base === expectedBase;
  });

  if (matched) {
    return matched;
  }

  throw new Error(
    `Unable to resolve CSV target '${input}' for project '${project.name}' under '${project.testsRootDir}'.`
  );
}

function resolveCycleTargetForProject(project: FrameworkProjectConfig, input: string): string {
  const normalizedInput = normalizeInputPath(input);
  if (!normalizedInput) {
    throw new Error('Cycle target is empty.');
  }

  if (!project.testCyclesRootDir) {
    throw new Error(`Project '${project.name}' does not define testCyclesRootDir.`);
  }

  const withExt = normalizedInput.toLowerCase().endsWith('.json') ? normalizedInput : `${normalizedInput}.json`;
  const candidates = new Set<string>();

  if (path.isAbsolute(normalizedInput)) {
    candidates.add(path.resolve(normalizedInput));
  }
  if (path.isAbsolute(withExt)) {
    candidates.add(path.resolve(withExt));
  }

  candidates.add(path.resolve(project.testCyclesRootDir, normalizedInput));
  candidates.add(path.resolve(project.testCyclesRootDir, withExt));
  candidates.add(path.resolve(__dirname, '..', normalizedInput));
  candidates.add(path.resolve(__dirname, '..', withExt));

  for (const candidate of candidates) {
    if (
      fs.existsSync(candidate) &&
      fs.statSync(candidate).isFile() &&
      isPathWithin(project.testCyclesRootDir, candidate)
    ) {
      return candidate;
    }
  }

  const cycleFiles = discoverCycleFiles(project.testCyclesRootDir);
  const expectedCycleName = normalizedInput.replace(/\.json$/i, '').toLowerCase();
  const expectedWithExt = withExt.toLowerCase();

  const matched = cycleFiles.find((cycleFile) => {
    const cycleName = getCycleName(cycleFile).toLowerCase();
    const relative = path.relative(project.testCyclesRootDir!, cycleFile).replace(/\\/g, '/').toLowerCase();
    const base = path.basename(cycleFile).toLowerCase();
    return (
      cycleName === expectedCycleName ||
      relative === expectedWithExt ||
      relative.endsWith(`/${expectedWithExt}`) ||
      base === expectedWithExt
    );
  });

  if (matched) {
    return matched;
  }

  throw new Error(
    `Unable to resolve cycle target '${input}' for project '${project.name}' under '${project.testCyclesRootDir}'.`
  );
}

const targetSelection = getTargetSelection();
const uiBreakpointConfig = {
  mode: String(process.env.CSV_BREAKPOINT_MODE || '').trim().toLowerCase() === 'ui' ? 'ui' as const : 'off' as const,
  pauseOnFailure: String(process.env.CSV_PAUSE_ON_FAILURE || '').trim().toLowerCase() === 'true' ? true : false,
  runId: String(process.env.CSV_BREAKPOINT_RUN_ID || '').trim(),
  controlFilePath: String(process.env.CSV_BREAKPOINT_CONTROL_FILE || '').trim(),
  pollIntervalMs: 400,
};

function logProjectSelectionDiagnostics(): void {
  const projectFromEnv = String(process.env.PW_PROJECT || '').trim();
  const projectFromFile = getActiveProjectNameFromFile();
  const requestedProject = projectFromEnv || projectFromFile || '';
  const source = projectFromEnv
    ? 'PW_PROJECT environment variable'
    : projectFromFile
    ? 'active-project.json file'
    : 'default (first configured project)';
  const selectedProjectNames = selectedProjects.map((project) => project.name).join(', ') || '(none)';

  console.log(`[config] activeProjectPath=${activeProjectConfigPath}`);
  console.log(`[config] requestedProject=${requestedProject || '(not set)'} source=${source}`);
  console.log(`[config] selectedProjects=${selectedProjectNames}`);
  console.log(`[target] mode=${targetSelection.mode} value=${targetSelection.value}`);
}

function registerCycleEntry(
  project: FrameworkProjectConfig,
  entry: TestCycleEntry,
  stageRuntime: ResolvedProjectRuntime,
  stageRetries: number,
  runnerOptions: {
    timeouts: {
      testTimeoutMs: number;
      expectTimeoutMs: number;
      actionTimeoutMs: number;
      navigationTimeoutMs: number;
    };
    breakpoint: {
      mode: 'off' | 'ui';
      runId: string;
      controlFilePath: string;
      pollIntervalMs: number;
    };
    stepScreenshot: {
      mode: 'off' | 'all-steps';
      fullPage: boolean;
    };
  }
): void {
  const testName = entry.test;

  const entryRetries = entry.retryOnFailure;
  const entryEnv = entry.env;
  const csvPath = resolveCycleEntryCsvPath(project, entry);
  const scenarioConfig = getScenarioDrivenConfig(csvPath, project.testDataRootDir);

  // Create a nested scope only when the test entry needs retry/env overrides.
  const needsOwnScope =
    (entryRetries !== undefined && entryRetries !== stageRetries) || entryEnv !== undefined;

  const registerTests = (runtime: ResolvedProjectRuntime) => {
    if (scenarioConfig && scenarioConfig.scenarios.length > 0) {
      for (const scenario of scenarioConfig.scenarios) {
        const scenarioTestName = `${testName} [${scenario}]`;

        test(scenarioTestName, async ({ page }) => {
          await executeCycleEntry(page, project, entry, runtime, {
            scenarioConfig,
            scenario,
            testName: scenarioTestName,
            runnerOptions,
          });
        });
      }

      return;
    }

    test(testName, async ({ page }) => {
      await executeCycleEntry(page, project, entry, runtime, { runnerOptions });
    });
  };

  if (needsOwnScope) {
    const entryRuntime = resolveCycleRuntime(project, entryEnv, stageRuntime);

    test.describe(testName, () => {
      if (entryRetries !== undefined) {
        test.describe.configure({ retries: entryRetries });
      }

      if (entryEnv !== undefined && entryRuntime.baseURL) {
        test.use({ baseURL: entryRuntime.baseURL });
      }

      registerTests(entryRuntime);
    });

    return;
  }

  registerTests(stageRuntime);
}

function registerCycleStage(
  project: FrameworkProjectConfig,
  stage: TestCycleStage,
  cycleEnv: string | undefined,
  defaultRuntime: ResolvedProjectRuntime,
  runnerOptions: {
    timeouts: {
      testTimeoutMs: number;
      expectTimeoutMs: number;
      actionTimeoutMs: number;
      navigationTimeoutMs: number;
    };
    breakpoint: {
      mode: 'off' | 'ui';
      runId: string;
      controlFilePath: string;
      pollIntervalMs: number;
    };
    stepScreenshot: {
      mode: 'off' | 'all-steps';
      fullPage: boolean;
    };
  }
): void {
  const stageEnv = stage.env ?? cycleEnv;
  const stageRuntime = resolveCycleRuntime(project, stageEnv, defaultRuntime);
  const stageRetries = stage.retryOnFailure ?? 0;
  const stageLabel = `Stage ${stage.stage}: ${stage.name}`;

  const describeFn =
    stage.execution === 'sequence'
      ? (label: string, fn: () => void) => test.describe.serial(label, fn)
      : (label: string, fn: () => void) => test.describe(label, fn);

  describeFn(stageLabel, () => {
    if (stageRetries > 0) {
      test.describe.configure({ retries: stageRetries });
    }

    if (stageRuntime.baseURL) {
      test.use({ baseURL: stageRuntime.baseURL });
    }

    test.beforeAll(() => {
      console.log(
        `[cycle] Stage ${stage.stage}: "${stage.name}" | ${stage.execution} | ` +
          `env=${stageEnv || 'default'} | tests=${stage.tests.length} | retries=${stageRetries}`
      );
    });

    for (const entry of stage.tests) {
      registerCycleEntry(project, entry, stageRuntime, stageRetries, runnerOptions);
    }
  });
}

test.describe('CSV Runner Tests', () => {
  // json mode: cycle block handles everything — skip here.
  // csv mode: load only the targeted script.
  // none mode: full discovery so VS Code shows inline run icons.
  if (targetSelection.mode === 'json') {
    return;
  }

  for (const project of selectedProjects) {
    const projectDisplayName = project.displayName || project.name;
    const suites =
      targetSelection.mode === 'csv'
        ? buildSuitesForProject(project, resolveCsvTargetForProject(project, targetSelection.value))
        : buildSuitesForProject(project); // mode === 'none': full discovery
    const environmentName = resolveEnvironmentForProject(project.name);
    const runtime = resolveProjectRuntime(project, environmentName);
    const timeouts = getTimeoutsForProjectScope(project.name);
    const stepScreenshot = getStepScreenshotConfigForProjectScope(project.name);

    test.describe(projectDisplayName, () => {
      if (runtime.baseURL) {
        test.use({ baseURL: runtime.baseURL });
      }

      test.beforeAll(() => {
        console.log(test.info().outputDir);
        //console.log(runtime.summaryLines.join('\n'));
      });

      for (const [suiteName, files] of suites) {
        test.describe(`${suiteName}`, () => {
          for (const filePath of files) {
            const testName = getTestName(project.testsRootDir, filePath);
            const scenarioConfig = getScenarioDrivenConfig(filePath, project.testDataRootDir);

            if (scenarioConfig && scenarioConfig.scenarios.length > 0) {
              for (const scenario of scenarioConfig.scenarios) {
                const scenarioTestName = `${testName} [${scenario}]`;

                test(scenarioTestName, async ({ page }) => {
                  const runner = new CSVTestRunner(page, {
                    testsRootDir: project.testsRootDir,
                    flowsRootDir: project.testFlowsRootDir,
                    testDataRootDir: project.testDataRootDir,
                    pageFactories: project.pageFactories,
                    runtimeValues: runtime.values,
                    timeouts,
                    breakpoint: uiBreakpointConfig,
                    stepScreenshot,
                  });
                  const csvSteps = runner.loadTestSteps(filePath);
                  const normalizedSteps = normalizeScenarioFetchStep(csvSteps, scenarioConfig.dataSource);
                  await runner.runTestCase(normalizedSteps, scenarioTestName, { scenario });
                });
              }
            } else {
              test(testName, async ({ page }) => {
                const runner = new CSVTestRunner(page, {
                  testsRootDir: project.testsRootDir,
                  flowsRootDir: project.testFlowsRootDir,
                  testDataRootDir: project.testDataRootDir,
                  pageFactories: project.pageFactories,
                  runtimeValues: runtime.values,
                  timeouts,
                  breakpoint: uiBreakpointConfig,
                  stepScreenshot,
                });
                const csvSteps = runner.loadTestSteps(filePath);
                await runner.runTestCase(csvSteps, testName);
              });
            }
          }
        });
      }
    });
  }
});

// ─── Test Cycles ──────────────────────────────────────────────────────────────
// Each cycle JSON in a project's testCyclesRootDir gets its own serial describe
// block so stages always run in order, independent of fullyParallel config.

test.describe('Test Cycles', () => {
  // csv mode: CSV block handles everything — skip here.
  // json mode: load only the targeted cycle.
  // none mode: full cycle discovery so VS Code shows inline run icons.
  if (targetSelection.mode === 'csv') {
    return;
  }

  for (const project of selectedProjects) {
    if (!project.testCyclesRootDir) {
      continue;
    }

    const cycleFiles =
      targetSelection.mode === 'json'
        ? [resolveCycleTargetForProject(project, targetSelection.value)]
        : discoverCycleFiles(project.testCyclesRootDir); // mode === 'none': full discovery
    const environmentName = resolveEnvironmentForProject(project.name);
    const defaultRuntime = resolveProjectRuntime(project, environmentName);
    const timeouts = getTimeoutsForProjectScope(project.name);
    const stepScreenshot = getStepScreenshotConfigForProjectScope(project.name);
    const runnerOptions = {
      timeouts,
      breakpoint: uiBreakpointConfig,
      stepScreenshot,
    };

    for (const cycleFile of cycleFiles) {
      const cycleName = getCycleName(cycleFile);
      const cycle = loadCycleConfig(cycleFile);
      const cycleDisplayName = cycle.name || cycle.cycle || cycleName;

      test.describe(`[Cycle] ${cycleName} | ${cycleDisplayName}`, () => {
        test.beforeAll(() => {
          console.log(`\n[cycle] ═══ Project: ${cycle.project} ═══`);
          console.log(`[cycle] ${cycleDisplayName} (${cycleName}) | Stages: ${cycle.stages.length}`);
        });

        for (const stage of cycle.stages) {
          registerCycleStage(project, stage, cycle.env, defaultRuntime, runnerOptions);
        }
      });
    }
  }
});

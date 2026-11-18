/**
 * Test Cycle Helpers
 *
 * Contains read/resolve/execute utilities for cycle JSON files.
 *
 * Test registration (test.describe/test) is intentionally kept in csv-tests-driver.spec.ts
 * so VS Code Playwright run/debug discovery appears in the spec file.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { Page } from '@playwright/test';
import { CSVTestRunner, CSVRunnerOptions } from './csv-runner';
import { CSVParser, TestStep } from './csv-parser';
import {
  FrameworkProjectConfig,
  ResolvedProjectRuntime,
  TestCycleConfig,
  TestCycleEntry,
} from '../references/schema_types';
import { resolveProjectRuntimeForEnv } from '../references/runtime_resolver';

// ─── Helpers ─────────────────────────────────────────────────────────────────

export type ScenarioConfig = {
  dataSource: string;
  scenarios: string[];
};

/** Discovers all *.json files in a directory recursively. */
export function discoverCycleFiles(cyclesRootDir: string): string[] {
  if (!fs.existsSync(cyclesRootDir)) {
    return [];
  }

  const discovered: string[] = [];

  const walk = (dir: string): void => {
    const entries = fs.readdirSync(dir, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        walk(fullPath);
        continue;
      }

      if (entry.isFile() && entry.name.endsWith('.json')) {
        discovered.push(fullPath);
      }
    }
  };

  walk(cyclesRootDir);

  return discovered.sort((a, b) => a.localeCompare(b));
}

function pickRuntime(
  project: FrameworkProjectConfig,
  envName: string | undefined,
  fallback: ResolvedProjectRuntime
): ResolvedProjectRuntime {
  return envName ? resolveProjectRuntimeForEnv(project, envName) : fallback;
}

export function resolveCycleRuntime(
  project: FrameworkProjectConfig,
  envName: string | undefined,
  fallback: ResolvedProjectRuntime
): ResolvedProjectRuntime {
  return pickRuntime(project, envName, fallback);
}

export function loadCycleConfig(cycleFilePath: string): TestCycleConfig {
  const raw = fs.readFileSync(cycleFilePath, 'utf-8');
  return JSON.parse(raw) as TestCycleConfig;
}

export function getCycleName(cycleFilePath: string, cyclesRootDir?: string): string {
  const normalizedRoot = cyclesRootDir ? path.resolve(cyclesRootDir) : '';
  const normalizedFile = path.resolve(cycleFilePath);

  if (!normalizedRoot || !normalizedFile.startsWith(normalizedRoot)) {
    return path.basename(cycleFilePath, '.json');
  }

  const relativePath = path.relative(normalizedRoot, normalizedFile);
  return relativePath.replace(/\\/g, '/').replace(/\.json$/i, '');
}

function isExpansionSelector(selector: string): boolean {
  const trimmed = (selector || '').trim();
  if (!trimmed) {
    return false;
  }

  return trimmed.toLowerCase() === 'all' || trimmed.includes('|') || trimmed.includes('...');
}

function resolveRangeSelector(
  selector: string,
  allScenarios: string[],
  dataSource: string
): string[] {
  const parts = selector.split('...');
  if (parts.length !== 2) {
    throw new Error(
      `Invalid range selector '${selector}'. Expected format: startScenario...endScenario`
    );
  }
  const [start, end] = parts.map((p) => p.trim());
  const startIdx = allScenarios.indexOf(start);
  const endIdx = allScenarios.indexOf(end);
  if (startIdx === -1) {
    throw new Error(`Range start scenario '${start}' not found in ${dataSource}.csv`);
  }
  if (endIdx === -1) {
    throw new Error(`Range end scenario '${end}' not found in ${dataSource}.csv`);
  }
  if (startIdx > endIdx) {
    throw new Error(
      `Range start '${start}' comes after range end '${end}' in ${dataSource}.csv`
    );
  }
  return allScenarios.slice(startIdx, endIdx + 1);
}

function parseFetchDataScenarioConfig(step: TestStep): { dataSource: string; selector: string } | null {
  const dataSource = (step.object || '').trim();
  const selector = (step.data || '').trim();

  if (!dataSource || !selector) {
    return null;
  }

  return { dataSource, selector };
}

export function resolveCycleEntryCsvPath(
  project: FrameworkProjectConfig,
  entry: TestCycleEntry
): string {
  return path.join(project.testsRootDir, `${entry.test}.csv`);
}

export function getScenarioDrivenConfig(
  filePath: string,
  testDataRootDir: string
): ScenarioConfig | null {
  const steps = CSVParser.parseTestSteps(filePath);
  const firstStep = steps[0];

  if (!firstStep || firstStep.action.toUpperCase() !== 'READ_DATA') {
    return null;
  }

  const parsed = parseFetchDataScenarioConfig(firstStep);
  if (!parsed) {
    return null;
  }

  const { dataSource, selector } = parsed;
  if (!isExpansionSelector(selector)) {
    return null;
  }

  const dataFilePath = path.join(testDataRootDir, `${dataSource}.csv`);
  if (!fs.existsSync(dataFilePath)) {
    throw new Error(`Data file not found for source '${dataSource}': ${dataFilePath}`);
  }

  const dataRows = CSVParser.parseTestData(dataFilePath);
  const allScenarios = dataRows
    .map((row) => String(row.scenario ?? '').trim())
    .filter((scenario) => scenario.length > 0);

  const selectorLower = selector.toLowerCase();
  if (selectorLower === 'all') {
    return { dataSource, scenarios: allScenarios };
  }

  if (selector.includes('...')) {
    const rangeScenarios = resolveRangeSelector(selector, allScenarios, dataSource);
    return { dataSource, scenarios: rangeScenarios };
  }

  const selectedScenarios = selector
    .split('|')
    .map((scenario) => scenario.trim())
    .filter((scenario) => scenario.length > 0);

  if (selectedScenarios.length === 0) {
    return null;
  }

  const existingSet = new Set(allScenarios);
  const missing = selectedScenarios.filter((scenario) => !existingSet.has(scenario));
  if (missing.length > 0) {
    throw new Error(
      `Scenario(s) not found in ${dataSource}.csv for ${path.basename(filePath)}: ${missing.join(', ')}`
    );
  }

  return { dataSource, scenarios: selectedScenarios };
}

export function normalizeScenarioFetchStep(steps: TestStep[], dataSource: string): TestStep[] {
  return steps.map((step, index) => {
    if (index !== 0 || step.action.toUpperCase() !== 'READ_DATA') {
      return step;
    }

    if ((step.object || '').trim() !== dataSource) {
      return step;
    }

    return {
      ...step,
      data: '${scenario}',
    };
  });
}

export async function executeCycleEntry(
  page: Page,
  project: FrameworkProjectConfig,
  entry: TestCycleEntry,
  runtime: ResolvedProjectRuntime,
  options?: {
    scenarioConfig?: ScenarioConfig;
    scenario?: string;
    testName?: string;
    runnerOptions?: Pick<CSVRunnerOptions, 'timeouts' | 'breakpoint' | 'stepScreenshot'>;
  }
): Promise<void> {
  const csvPath = resolveCycleEntryCsvPath(project, entry);
  const testName = options?.testName || entry.test;

  if (!fs.existsSync(csvPath)) {
    throw new Error(`[cycle-runner] Test CSV not found: ${csvPath}`);
  }

  const runner = new CSVTestRunner(page, {
    testsRootDir: project.testsRootDir,
    flowsRootDir: project.testFlowsRootDir,
    testDataRootDir: project.testDataRootDir,
    pageFactories: project.pageFactories,
    runtimeValues: runtime.values,
    ...options?.runnerOptions,
  });

  runner.loadAllTestData(project.testDataRootDir);
  const loadedSteps = runner.loadTestSteps(csvPath);
  const steps =
    options?.scenarioConfig && options.scenario
      ? normalizeScenarioFetchStep(loadedSteps, options.scenarioConfig.dataSource)
      : loadedSteps;

  await runner.runTestCase(steps, testName, options?.scenario ? { scenario: options.scenario } : undefined);
}
/**
 * Utility functions and constants for Playwright configuration.
 * These are extracted to keep the main config file clean and focused.
 */

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { validatePlaywrightSettings, PlaywrightSettingsValidationError } = require('./validate-playwright-settings');

export function parseNonNegativeInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return fallback;
  }
  return Math.floor(parsed);
}

export function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (!value) {
    return fallback;
  }
  return value.toLowerCase() === 'true' || value === '1';
}

export function parseReporterArray(value: any, fallback: string[]): string[] {
  const valid = new Set(['html', 'dot', 'json', 'junit', 'list', 'github', 'allure', 'custom']);
  if (Array.isArray(value)) {
    const filtered = value.map((v: any) => String(v || '').trim()).filter((v) => valid.has(v));
    return filtered.length ? filtered : fallback;
  }
  const str = String(value || '').trim();
  return valid.has(str) ? [str] : fallback;
}

export function parseEnum<T extends string>(
  value: string | undefined,
  allowed: readonly T[],
  fallback: T
): T {
  if (!value) {
    return fallback;
  }
  return (allowed as readonly string[]).includes(value) ? (value as T) : fallback;
}

export function parseLaunchArgs(defaultArgs: string[]): string[] {
  const raw = process.env.PW_LAUNCH_ARGS;
  if (!raw) {
    return defaultArgs;
  }

  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      const args = parsed.map((item) => String(item || '').trim()).filter(Boolean);
      return args.length ? args : defaultArgs;
    }
  } catch {
    // Fall back to defaults when env is not valid JSON.
  }

  return defaultArgs;
}

export function parseBrowsers(value: string | undefined, fallback: string[]): string[] {
  const allowed = new Set(['chromium', 'firefox', 'webkit']);
  if (!value) {
    return fallback;
  }

  let parsedList: string[] = [];
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed)) {
      parsedList = parsed.map((item) => String(item || '').trim());
    }
  } catch {
    parsedList = value.split(/[\r\n,]+/).map((item) => item.trim());
  }

  const normalized = parsedList.filter((name) => allowed.has(name));
  return normalized.length ? [...new Set(normalized)] : fallback;
}

export function buildPlaywrightProjects(
  deviceCatalog: Record<string, unknown>,
  selectedBrowsers: string[],
  viewport?: { width: number; height: number }
) {
  const chosen = selectedBrowsers.length ? selectedBrowsers : ['chromium'];
  const projects = [];

  const withViewport = (deviceKey: string): Record<string, unknown> => {
    const baseUse = { ...(deviceCatalog[deviceKey] as Record<string, unknown>) };
    if (viewport && viewport.width > 0 && viewport.height > 0) {
      return {
        ...baseUse,
        viewport: {
          width: viewport.width,
          height: viewport.height,
        },
      };
    }
    return baseUse;
  };

  if (chosen.includes('chromium') && deviceCatalog['Desktop Chrome']) {
    projects.push({
      name: 'chromium',
      use: withViewport('Desktop Chrome'),
    });
  }

  if (chosen.includes('firefox') && deviceCatalog['Desktop Firefox']) {
    projects.push({
      name: 'firefox',
      use: withViewport('Desktop Firefox'),
    });
  }

  if (chosen.includes('webkit') && deviceCatalog['Desktop Safari']) {
    projects.push({
      name: 'webkit',
      use: withViewport('Desktop Safari'),
    });
  }

  return projects.length ? projects : [
    {
      name: 'chromium',
      use: withViewport('Desktop Chrome'),
    },
  ];
}

/**
 * Global default constants - used when JSON config files are not available
 */
const HARDCODED_DEFAULTS = {
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
  video: 'retain-on-failure',
  snapshotDir: 'test-snapshots',
  outputDir: '',
  outputFolder: '',
  launchArgs: ['--disable-features=LocalNetworkAccessChecks']
};

export interface PlaywrightConfigSettings {
  testDir: string;
  testMatch: string;
  browsers: string[];
  fullyParallel: boolean;
  forbidOnly: boolean;
  retries: number;
  workers: number;
  reporter: string[];
  timeoutMs: number;
  expectTimeoutMs: number;
  actionTimeoutMs: number;
  navigationTimeoutMs: number;
  viewportWidth: number;
  viewportHeight: number;
  baseURL: string;
  ignoreHTTPSErrors: boolean;
  trace: string;
  slowMo: number;
  screenshot: string;
  video: string;
  snapshotDir: string;
  outputDir: string;
  outputFolder: string;
  launchArgs: string[];
}

/**
 * Helper to parse CLI arguments and environment variables for project, environment, and scope.
 * Priority: CLI args > env vars > active-project.json > defaults
 */
function parseCIOverrides(): { projectName?: string; environmentName?: string; scope?: string } {
  const result: any = {};

  // 1. Check CLI arguments (--project=name --environment=name --scope=name)
  const argv = process.argv.slice(2);
  for (const arg of argv) {
    if (arg.startsWith('--project=')) {
      result.projectName = arg.split('=')[1]?.trim();
    } else if (arg.startsWith('--environment=')) {
      result.environmentName = arg.split('=')[1]?.trim();
    } else if (arg.startsWith('--scope=')) {
      result.scope = arg.split('=')[1]?.trim();
    }
  }

  // 2. Check environment variables (if not already set by CLI)
  if (!result.projectName && process.env.PW_PROJECT) {
    result.projectName = process.env.PW_PROJECT.trim();
  }
  if (!result.environmentName && process.env.PW_ENV) {
    result.environmentName = process.env.PW_ENV.trim();
  }
  if (!result.scope && process.env.PW_CONFIG) {
    result.scope = process.env.PW_CONFIG.trim();
  }

  return result;
}

function resolveSnapshotDir(snapshotDir: string, scope: string, projectName: string): string {
  const rawSnapshotDir = String(snapshotDir || '').trim() || 'test-snapshots';

  // Without a project name there is nothing to prefix with.
  if (!projectName) {
    return rawSnapshotDir;
  }

  // Preserve absolute paths provided explicitly by users.
  const isWindowsAbs = /^[a-zA-Z]:[\\/]/.test(rawSnapshotDir);
  const isUnixAbs = rawSnapshotDir.startsWith('/');
  const isUnc = rawSnapshotDir.startsWith('\\\\');
  if (isWindowsAbs || isUnixAbs || isUnc) {
    return rawSnapshotDir;
  }

  const normalized = rawSnapshotDir.replace(/\\/g, '/').replace(/^\.\//, '');
  const projectPrefix = `projects/${projectName}/`;

  // Avoid double-prefixing if already project-scoped.
  if (normalized.startsWith(projectPrefix)) {
    return normalized;
  }

  return `${projectPrefix}${normalized}`;
}

/**
 * Load Playwright configuration from JSON files.
 * Reads active-project.json to determine:
 *   - Which project to use
 *   - Which scope (global or project) to load
 * Applies fallbacks to hardcoded defaults if files don't exist.
 *
 * Priority for project/environment/scope:
 *   1. CLI args: --project=name --environment=name --scope=name
 *   2. Environment variables: PW_PROJECT, PW_ENV, PW_CONFIG
 *   3. active-project.json (local dev default)
 *   4. Hardcoded defaults
 *
 * Example CI usage:
 *   export PW_PROJECT=s360
 *   export PW_ENV=qa
 *   export PW_CONFIG=project
 *   npm run test
 *
 *   OR:
 *   npm run test -- --project=s360 --environment=qa --scope=project
 */
export function loadPlaywrightConfig(overrides?: { projectName?: string; scope?: string }): PlaywrightConfigSettings {
  const fs = require('fs');
  const path = require('path');

  let config: any = { ...HARDCODED_DEFAULTS };

  try {
    // 1. Check for CI overrides (CLI args > env vars)
    const ciOverrides = parseCIOverrides();

    // 2. Load active project configuration as fallback
    const activeProjectPath = path.join(__dirname, '../../configs', 'active-project.json');
    let activeProject: any = null;
    let projectName = ciOverrides.projectName || ''; // Start with CI override
    let scope = ciOverrides.scope ? ciOverrides.scope : 'local'; // Start with CI override
    let environmentName = ciOverrides.environmentName || ''; // Start with CI override
      
    if (fs.existsSync(activeProjectPath)) {
      activeProject = JSON.parse(fs.readFileSync(activeProjectPath, 'utf-8'));
      // Use CI project name if set, otherwise use active-project.json
      if (!ciOverrides.projectName) {
        projectName = String(activeProject.projectName || '').trim();
      }
      // Use CI scope if set, otherwise use active-project.json
      if (!ciOverrides.scope) {
        const scopedPreference = String(activeProject?.scopesByProject?.[projectName] || '').trim();
        if (scopedPreference === 'local' || scopedPreference === 'project') {
          scope = scopedPreference;
        } else {
          scope = activeProject.scope || 'local';
        }
      }
      // Use CI environment if set, otherwise use active-project.json
      if (!ciOverrides.environmentName) {
        const envFromProject = String(activeProject?.environmentsByProject?.[projectName] || '').trim();
        if (envFromProject) {
          environmentName = envFromProject;
        } else {
          environmentName = String(activeProject?.environmentName || '').trim();
        }
      }
    } else if (ciOverrides.projectName) {
      projectName = ciOverrides.projectName;
    }

    // Log which configuration source was used for project resolution
    // Remove the ! (NOT operator) if you need to print logs for worker processes as well.
    // The TEST_WORKER_INDEX environment variable is automatically set by Playwright.
    if (!process.env.TEST_WORKER_INDEX) {
      if (ciOverrides.projectName) {
        console.log(`[config] project=${projectName} (source: CLI/environment override)`);
      } else if (activeProject?.projectName) {
        console.log(`[config] project=${projectName} (source: active-project.json file)`);
      } else {
        console.log(`[config] project=${projectName || '(none - will use first configured project)'} (source: default)`);
      }

      // Log scope resolution
      if (ciOverrides.scope) {
        console.log(`[config] scope=${scope} (source: CLI/environment override)`);
      } else if (activeProject?.scopesByProject?.[projectName]) {
        console.log(`[config] scope=${scope} (source: active-project.json scopesByProject for '${projectName}')`);
      } else if (activeProject?.scope) {
        console.log(`[config] scope=${scope} (source: active-project.json default scope)`);
      } else {
        console.log(`[config] scope=${scope} (source: default)`);
      }

      // Log environment resolution
      if (ciOverrides.environmentName) {
        console.log(`[config] environment=${environmentName} (source: CLI/environment override)`);
      } else if (activeProject?.environmentsByProject?.[projectName]) {
        console.log(`[config] environment=${environmentName} (source: active-project.json environmentsByProject for '${projectName}')`);
      } else if (activeProject?.environmentName) {
        console.log(`[config] environment=${environmentName} (source: active-project.json default environment)`);
      } else {
        console.log(`[config] environment=${environmentName || '(not set)'} (source: default)`);
      }
    }

    // Load global config first (always available as fallback)
    try {
      const globalPath = path.join(__dirname, '../../configs', 'playwright-settings.json');
      if (fs.existsSync(globalPath)) {
        const globalData = JSON.parse(fs.readFileSync(globalPath, 'utf-8'));
        validatePlaywrightSettings(globalData, globalPath);
        config = normalizeConfig(globalData, config);
      }
    } catch (err) {
      if (err instanceof PlaywrightSettingsValidationError) throw err;
      console.warn('Failed to load global Playwright config:', err);
    }

    // If scope is "project", load project-specific config instead of global
    if (scope === 'project' && projectName) {
      try {
        const projectPath = path.join(
          __dirname,
          '../../projects',
          projectName,
          'test-configs',
          'playwright-settings.json'
        );
        if (fs.existsSync(projectPath)) {
          const projectData = JSON.parse(fs.readFileSync(projectPath, 'utf-8'));
          validatePlaywrightSettings(projectData, projectPath);
          config = normalizeConfig(projectData, config);
          // Only log in runner process, not in worker process
          if (!process.env.TEST_WORKER_INDEX) {
            console.log(`[config] loaded Playwright config from project: ${projectName}`);
          }
        }
      } catch (err) {
        if (err instanceof PlaywrightSettingsValidationError) throw err;
        console.warn(
          `Failed to load project Playwright config for "${projectName}":`,
          err
        );
      }
    } else if (scope === 'local') {
      // Only log in runner process, not in worker process
      if (!process.env.TEST_WORKER_INDEX) {
        console.log('[config] loaded Playwright config from local scope');
      }
    }

    // Centralized snapshot directory mapping:
    // In project scope, relative paths are rooted under projects/<activeProject>/.
    config.snapshotDir = resolveSnapshotDir(config.snapshotDir, scope, projectName);
    if (!process.env.TEST_WORKER_INDEX) {
      console.log(`[config] snapshotDir is set to = ${config.snapshotDir}`);
    }
  } catch (err) {
    console.warn('Failed to read active project configuration:', err);
  }

  const explicitSpecRequested = hasExplicitSpecFileArg(process.argv.slice(2));
  if (explicitSpecRequested) {
    // Avoid excluding explicitly selected spec files via restrictive project testMatch values.
    config.testMatch = '**/*.spec.ts';
  }

  // Runtime override: PW_PARALLEL_SCENARIO is set only by design panel runs (via server.js).
  // It bidirectionally overrides fullyParallel for that run without touching the JSON config.
  // Cycle runs do NOT set PW_PARALLEL_SCENARIO, so their fullyParallel always comes from JSON config.
  if (process.env.PW_PARALLEL_SCENARIO !== undefined) {
    const override = parseBoolean(process.env.PW_PARALLEL_SCENARIO, config.fullyParallel);
    if (!process.env.TEST_WORKER_INDEX && override !== config.fullyParallel) {
      console.log(`[config] fullyParallel overridden by parallelScenario: ${config.fullyParallel} \u2192 ${override}`);
    }
    config.fullyParallel = override;
  }

  return config as PlaywrightConfigSettings;
}

/**
 * Normalize and validate config values using parsing functions.
 */
function normalizeConfig(rawConfig: Record<string, any>, fallbacks: any): PlaywrightConfigSettings {
  return {
    testDir: String(rawConfig.testDir || fallbacks.testDir || '').trim() || fallbacks.testDir,
    testMatch: String(rawConfig.testMatch || fallbacks.testMatch || '').trim() || fallbacks.testMatch,
    browsers: parseBrowsers(
      rawConfig.browsers ? JSON.stringify(rawConfig.browsers) : undefined,
      fallbacks.browsers
    ),
    fullyParallel: parseBoolean(rawConfig.fullyParallel?.toString(), fallbacks.fullyParallel),
    forbidOnly: parseBoolean(rawConfig.forbidOnly?.toString(), fallbacks.forbidOnly),
    retries: parseNonNegativeInt(rawConfig.retries?.toString(), fallbacks.retries),
    workers: Math.max(1, parseNonNegativeInt(rawConfig.workers?.toString(), fallbacks.workers)),
    reporter: parseReporterArray(rawConfig.reporter, fallbacks.reporter),
    timeoutMs: parseNonNegativeInt(rawConfig.timeoutMs?.toString(), fallbacks.timeoutMs),
    expectTimeoutMs: parseNonNegativeInt(rawConfig.expectTimeoutMs?.toString(), fallbacks.expectTimeoutMs),
    actionTimeoutMs: parseNonNegativeInt(rawConfig.actionTimeoutMs?.toString(), fallbacks.actionTimeoutMs),
    navigationTimeoutMs: parseNonNegativeInt(rawConfig.navigationTimeoutMs?.toString(), fallbacks.navigationTimeoutMs),
    viewportWidth: Math.max(1, parseNonNegativeInt(rawConfig.viewportWidth?.toString(), fallbacks.viewportWidth)),
    viewportHeight: Math.max(1, parseNonNegativeInt(rawConfig.viewportHeight?.toString(), fallbacks.viewportHeight)),
    baseURL: String(rawConfig.baseURL || fallbacks.baseURL || '').trim(),
    ignoreHTTPSErrors: parseBoolean(rawConfig.ignoreHTTPSErrors?.toString(), fallbacks.ignoreHTTPSErrors),
    trace: parseEnum(
      rawConfig.trace,
      ['on', 'off', 'on-first-retry', 'retain-on-failure'] as const,
      fallbacks.trace
    ),
    slowMo: parseNonNegativeInt(rawConfig.slowMo?.toString(), fallbacks.slowMo),
    screenshot: parseEnum(
      rawConfig.screenshot,
      ['off', 'on', 'only-on-failure'] as const,
      fallbacks.screenshot
    ),
    video: parseEnum(
      rawConfig.video,
      ['off', 'on', 'retain-on-failure', 'on-first-retry'] as const,
      fallbacks.video
    ),
    snapshotDir: String(rawConfig.snapshotDir || fallbacks.snapshotDir || '').trim() || fallbacks.snapshotDir,
    // outputDir/outputFolder are intentionally independent per file (not inherited from fallbacks) —
    // getHtmlOutputFolder() in playwright.config.ts applies the reporter-based default when blank.
    outputDir: String(rawConfig.outputDir ?? '').trim(),
    outputFolder: String(rawConfig.outputFolder ?? '').trim(),
    launchArgs: Array.isArray(rawConfig.launchArgs)
      ? rawConfig.launchArgs.map((arg: any) => String(arg).trim()).filter(Boolean)
      : fallbacks.launchArgs,
      snapshotPathTemplate: String(rawConfig.snapshotPathTemplate || fallbacks.snapshotPathTemplate).trim(),
  };
}

function hasExplicitSpecFileArg(argv: string[]): boolean {
  return argv.some((arg) => /(^|[\\/]).+\.spec\.ts$/i.test(String(arg || '').trim()));
}

/**
 * Runtime Resolver
 *
 * Resolves active environment settings and derived runtime values
 * (base URLs, app endpoints) from project runtime configuration files.
 */

import * as fs from 'fs';
import * as path from 'path';
import {
  ActiveProjectConfig,
  FrameworkProjectConfig,
  ProjectRuntimeCatalog,
  ResolvedProjectRuntime,
  TestUsersConfig,
  TestUserCredentials,
} from './schema_types';

function getProjectRoot(project: FrameworkProjectConfig): string {
  return path.dirname(project.testsRootDir);
}

function resolveConfigFilePath(project: FrameworkProjectConfig, fileName: string): string {
  const projectRoot = getProjectRoot(project);
  const candidates = [
    path.join(projectRoot, 'test-configs', fileName),
    path.join(projectRoot, 'config', fileName),
  ];

  return candidates.find((candidate) => fs.existsSync(candidate)) || candidates[0];
}

function getApplicationsPath(project: FrameworkProjectConfig): string {
  return resolveConfigFilePath(project, 'applications.json');
}

function getTestUsersPath(project: FrameworkProjectConfig): string {
  return resolveConfigFilePath(project, 'credentials.json');
}

function getActiveProjectPath(): string {
  const candidates = [
    path.resolve(__dirname, '../../configs/active-project.json'),
    path.resolve(__dirname, '../active-project.json'),
  ];

  return candidates.find((candidate) => fs.existsSync(candidate)) || candidates[0];
}

function tryReadJson<T>(filePath: string): T | null {
  try {
    if (!fs.existsSync(filePath)) {
      return null;
    }

    const content = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(content) as T;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[runtime] Failed to read JSON: ${filePath} | ${message}`);
    return null;
  }
}

function getCatalogEnvironmentNames(catalog: ProjectRuntimeCatalog): string[] {
  const names = new Set<string>();
  for (const app of catalog.applications || []) {
    Object.keys(app.environments || {}).forEach((envName) => names.add(envName));
  }
  return Array.from(names).sort((a, b) => a.localeCompare(b));
}

function resolveEnvironmentName(project: FrameworkProjectConfig, catalog: ProjectRuntimeCatalog | null): string {
  const fromVariable = String(process.env.PW_ENV || '').trim();
  if (fromVariable) {
    return fromVariable;
  }

  const active = tryReadJson<ActiveProjectConfig>(getActiveProjectPath());
  const fromProjectMap = String(active?.environmentsByProject?.[project.name] || '').trim();
  if (fromProjectMap) {
    return fromProjectMap;
  }

  const fromCurrentProject =
    active?.projectName === project.name ? String(active?.environmentName || '').trim() : '';
  if (fromCurrentProject) {
    return fromCurrentProject;
  }

  const fromCatalog = String(catalog?.defaultEnvironment || '').trim();
  if (fromCatalog) {
    return fromCatalog;
  }

  if (catalog) {
    return getCatalogEnvironmentNames(catalog)[0] || '';
  }

  return '';
}

function resolveBaseUrl(
  project: FrameworkProjectConfig,
  catalog: ProjectRuntimeCatalog | null,
  values: Record<string, string>
): string | undefined {
  const defaultAppId = String(catalog?.defaultUiApplicationId || '').trim();
  if (defaultAppId && values[`${defaultAppId}.uiBaseUrl`]) {
    return values[`${defaultAppId}.uiBaseUrl`];
  }

  return project.baseURL;
}

/**
 * Inject all test users from credentials.json into the values map.
 * Each role's credentials are available as `user.{role}.{field}`.
 * The default/active role's credentials are also available as `user.{field}`.
 */
function injectTestUsers(
  usersConfig: TestUsersConfig | null,
  values: Record<string, string>,
  summaryLines: string[]
): void {
  if (!usersConfig) {
    return;
  }

  const activeRole =
    String(process.env.TEST_USER_ROLE || '').trim() || usersConfig.defaultRole || '';

  for (const [roleName, roleDef] of Object.entries(usersConfig.roles)) {
    const creds = roleDef.credentials;
    values[`user.${roleName}.id`] = roleName;
    for (const [field, fieldValue] of Object.entries(creds)) {
      values[`user.${roleName}.${field}`] = fieldValue;
    }
    summaryLines.push(`[users] role=${roleName} username=${creds.username}`);
  }

  if (activeRole && usersConfig.roles[activeRole]) {
    const activeCreds = usersConfig.roles[activeRole].credentials;
    values['user.id'] = activeRole;
    for (const [field, fieldValue] of Object.entries(activeCreds)) {
      values[`user.${field}`] = fieldValue;
    }
    summaryLines.push(`[users] activeRole=${activeRole}`);
  } else if (activeRole) {
    // OS user selected — not in credentials.json; synthesise identity from username
    values['user.id']       = activeRole;
    values['user.username'] = `${activeRole}@intactinsurance.com`;
    summaryLines.push(`[users] activeRole=${activeRole} (OS user, synthesised identity)`);
  }
}

function buildResolvedRuntime(
  project: FrameworkProjectConfig,
  catalog: ProjectRuntimeCatalog | null,
  environmentName: string
): ResolvedProjectRuntime {
  const values: Record<string, string> = {};
  const summaryLines: string[] = [];
  const applicationsPath = getApplicationsPath(project);
  const usersPath = getTestUsersPath(project);

  if (environmentName) {
    values.environment = environmentName;
  }

  if (catalog) {
    for (const app of catalog.applications || []) {
      const appEnv = app.environments?.[environmentName] || {};
      if (appEnv.uiBaseUrl) {
        values[`${app.id}.uiBaseUrl`] = appEnv.uiBaseUrl;
      }
      if (appEnv.apiBaseUrl) {
        values[`${app.id}.apiBaseUrl`] = appEnv.apiBaseUrl;
      }

      summaryLines.push(
        `[runtime] app=${app.id} uiBaseUrl=${appEnv.uiBaseUrl || '(not set)'} apiBaseUrl=${appEnv.apiBaseUrl || '(not set)'}`
      );
    }
  } else {
    summaryLines.push(`[runtime] warning=Missing or invalid runtime catalog at ${applicationsPath}`);
  }

  const usersConfig = tryReadJson<TestUsersConfig>(usersPath);
  if (!usersConfig) {
    summaryLines.push(`[users] warning=Missing or invalid credentials config at ${usersPath}`);
  }
  injectTestUsers(usersConfig, values, summaryLines);

  const baseURL = resolveBaseUrl(project, catalog, values);
  summaryLines.unshift(
    `[runtime] project=${project.name}`,
    `[runtime] environment=${environmentName || '(not set)'}`,
    `[runtime] baseURL=${baseURL || '(not set)'}`
  );

  return { environmentName, baseURL, values, summaryLines };
}

export function resolveProjectRuntime(project: FrameworkProjectConfig, environmentName?: string): ResolvedProjectRuntime {
  const catalog = tryReadJson<ProjectRuntimeCatalog>(getApplicationsPath(project));
  // If environment is provided, use it; otherwise resolve from config
  const resolvedEnvironment = environmentName || resolveEnvironmentName(project, catalog);
  return buildResolvedRuntime(project, catalog, resolvedEnvironment);
}

/**
 * Resolve runtime for a specific environment name, bypassing active-project.json / env variable resolution.
 * Used by the test cycle runner to honour per-stage / per-test env overrides.
 */
export function resolveProjectRuntimeForEnv(
  project: FrameworkProjectConfig,
  envName: string
): ResolvedProjectRuntime {
  const catalog = tryReadJson<ProjectRuntimeCatalog>(getApplicationsPath(project));
  return buildResolvedRuntime(project, catalog, envName);
}
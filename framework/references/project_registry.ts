/**
 * Project Registry
 *
 * Loads framework project configurations from configured and auto-discovered
 * project roots.
 */

import { FrameworkProjectConfig } from './schema_types';
import {
  getConfiguredProjectNames,
  getDiscoveredProjectNames,
  getProjectConfigModulePath,
  getProjectRootByName,
} from './project_roots';
import fs from 'fs';

let cachedProjects: FrameworkProjectConfig[] | null = null;

function isFrameworkProjectConfig(value: unknown): value is FrameworkProjectConfig {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const candidate = value as Partial<FrameworkProjectConfig>;
  return (
    typeof candidate.name === 'string' &&
    typeof candidate.testsRootDir === 'string' &&
    typeof candidate.testDataRootDir === 'string' &&
    typeof candidate.testFlowsRootDir === 'string' &&
    typeof candidate.pageFactories === 'object' &&
    candidate.pageFactories !== null
  );
}

function ensureTsConfigLoader(): void {
  const compilerOptions = process.env.TS_NODE_COMPILER_OPTIONS;
  let parsedOptions: Record<string, unknown> = {};

  if (compilerOptions) {
    try {
      parsedOptions = JSON.parse(compilerOptions) as Record<string, unknown>;
    } catch {
      parsedOptions = {};
    }
  }

  parsedOptions.module = parsedOptions.module || 'commonjs';
  parsedOptions.moduleResolution = parsedOptions.moduleResolution || 'node';
  parsedOptions.ignoreDeprecations = '6.0';

  process.env.TS_NODE_COMPILER_OPTIONS = JSON.stringify(parsedOptions);

  require('ts-node/register/transpile-only');
}

function loadProjectConfig(projectName: string, isConfiguredProject: boolean): FrameworkProjectConfig | null {
  const projectRoot = getProjectRootByName(projectName);
  const rootExists = projectRoot && fs.existsSync(projectRoot);

  const configPath = getProjectConfigModulePath(projectName);
  if (!configPath) {
    if (isConfiguredProject && rootExists) {
      // Root exists but config file is missing — that's a real misconfiguration.
      throw new Error(
        `Configured project '${projectName}' does not contain config/project.config.ts or config/project.config.js`
      );
    }

    return null;
  }

  if (configPath.endsWith('.ts')) {
    ensureTsConfigLoader();
  }

  const loadedModule = require(configPath) as Record<string, unknown>;
  const matchedExport = Object.values(loadedModule).find(isFrameworkProjectConfig);

  if (!matchedExport) {
    if (isConfiguredProject) {
      throw new Error(`Project '${projectName}' config did not export a FrameworkProjectConfig.`);
    }

    return null;
  }

  return matchedExport;
}

function getProjects(): FrameworkProjectConfig[] {
  if (cachedProjects) {
    return cachedProjects;
  }

  const configured = new Set(getConfiguredProjectNames().map((name) => name.toLowerCase()));
  const projects: FrameworkProjectConfig[] = [];

  for (const projectName of getDiscoveredProjectNames()) {
    const project = loadProjectConfig(projectName, configured.has(projectName.toLowerCase()));
    if (project) {
      projects.push(project);
    }
  }

  cachedProjects = projects;
  return cachedProjects;
}

export function getConfiguredProjects(): FrameworkProjectConfig[] {
  return [...getProjects()];
}

export function getProjectByName(name: string): FrameworkProjectConfig | undefined {
  const normalizedName = name.trim().toLowerCase();
  return getProjects().find((project) => project.name.toLowerCase() === normalizedName);
}

import * as fs from 'fs';
import * as path from 'path';

type ProjectRootsConfigFile = {
  version?: number;
  projectsBaseDir?: string;
  projects?: Record<string, string>;
};

export type ProjectRootsConfig = {
  version: number;
  projectsBaseDir: string;
  projects: Record<string, string>;
};

const REPO_ROOT = path.resolve(__dirname, '../..');
const PROJECT_ROOTS_FILE = path.resolve(REPO_ROOT, 'configs', 'project-roots.json');

function readJsonIfExists<T>(filePath: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as T;
  } catch {
    return fallback;
  }
}

function resolveFromRepoRoot(relativeOrAbsolutePath: string): string {
  if (!relativeOrAbsolutePath) {
    return '';
  }

  return path.isAbsolute(relativeOrAbsolutePath)
    ? relativeOrAbsolutePath
    : path.resolve(REPO_ROOT, relativeOrAbsolutePath);
}

export function loadProjectRootsConfig(): ProjectRootsConfig {
  const raw = readJsonIfExists<ProjectRootsConfigFile>(PROJECT_ROOTS_FILE, {});
  const rawProjects = raw.projects && typeof raw.projects === 'object' ? raw.projects : {};
  const projects: Record<string, string> = {};

  for (const [projectName, rootPath] of Object.entries(rawProjects)) {
    const normalizedName = String(projectName || '').trim();
    const normalizedPath = String(rootPath || '').trim();
    if (!normalizedName || !normalizedPath) {
      continue;
    }

    projects[normalizedName] = normalizedPath;
  }

  return {
    version: Number(raw.version) || 1,
    projectsBaseDir: resolveFromRepoRoot(String(raw.projectsBaseDir || './projects').trim()),
    projects,
  };
}

export function getConfiguredProjectNames(): string[] {
  return Object.keys(loadProjectRootsConfig().projects).sort((a, b) => a.localeCompare(b));
}

export function getDiscoveredProjectNames(): string[] {
  const config = loadProjectRootsConfig();
  const names = new Set<string>(Object.keys(config.projects));

  if (fs.existsSync(config.projectsBaseDir)) {
    for (const entry of fs.readdirSync(config.projectsBaseDir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        names.add(entry.name);
      }
    }
  }

  return Array.from(names).sort((a, b) => a.localeCompare(b));
}

export function getProjectRootByName(projectName: string): string {
  const normalizedName = String(projectName || '').trim();
  if (!normalizedName) {
    return '';
  }

  const config = loadProjectRootsConfig();
  const explicit = config.projects[normalizedName];
  if (explicit) {
    return resolveFromRepoRoot(explicit);
  }

  const ciMatch = Object.entries(config.projects).find(
    ([name]) => name.toLowerCase() === normalizedName.toLowerCase()
  );
  if (ciMatch?.[1]) {
    return resolveFromRepoRoot(ciMatch[1]);
  }

  return path.join(config.projectsBaseDir, normalizedName);
}

export function getProjectConfigModulePath(projectName: string): string | null {
  const projectRoot = getProjectRootByName(projectName);
  if (!projectRoot) {
    return null;
  }

  const candidates = [
    path.join(projectRoot, 'test-configs', 'project.config.ts'),
    path.join(projectRoot, 'test-configs', 'project.config.js'),
  ];

  return candidates.find((candidate) => fs.existsSync(candidate)) || null;
}

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '../..');
const PROJECT_ROOTS_FILE = path.join(REPO_ROOT, 'configs', 'project-roots.json');
const GITIGNORE_FILE = path.join(REPO_ROOT, '.gitignore');
const GITIGNORE_BLOCK_START = '# Managed project ignores';
const GITIGNORE_BLOCK_END = '# End managed project ignores';

function readJsonIfExists(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    return fallback;
  }
}

function toRepoRelativePath(absolutePath) {
  const relativePath = path.relative(REPO_ROOT, absolutePath).replace(/\\/g, '/');
  if (!relativePath || relativePath === '.') {
    return './';
  }

  return relativePath.startsWith('.') ? relativePath : `./${relativePath}`;
}

function resolveFromRepoRoot(relativeOrAbsolutePath) {
  if (!relativeOrAbsolutePath) {
    return '';
  }

  return path.isAbsolute(relativeOrAbsolutePath)
    ? relativeOrAbsolutePath
    : path.resolve(REPO_ROOT, relativeOrAbsolutePath);
}

function loadProjectRootsConfig() {
  const config = readJsonIfExists(PROJECT_ROOTS_FILE, {});
  const projects = config && typeof config.projects === 'object' ? config.projects : {};
  const projectsBaseDir = String(config.projectsBaseDir || './projects').trim() || './projects';

  return {
    version: Number(config.version) || 1,
    projectsBaseDir,
    resolvedProjectsBaseDir: resolveFromRepoRoot(projectsBaseDir),
    projects,
  };
}

function buildSyncedProjects(config) {
  const nextProjects = {};
  const baseDir = config.resolvedProjectsBaseDir;

  if (fs.existsSync(baseDir)) {
    for (const entry of fs.readdirSync(baseDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) {
        continue;
      }

      const projectRoot = path.join(baseDir, entry.name);
      nextProjects[entry.name] = toRepoRelativePath(projectRoot);
    }
  }

  for (const [projectName, projectPath] of Object.entries(config.projects)) {
    const normalizedName = String(projectName || '').trim();
    const normalizedPath = String(projectPath || '').trim();
    if (!normalizedName || !normalizedPath || nextProjects[normalizedName]) {
      continue;
    }

    const resolvedProjectPath = resolveFromRepoRoot(normalizedPath);
    const isInsideBaseDir = path.dirname(resolvedProjectPath) === baseDir;
    if (!isInsideBaseDir) {
      nextProjects[normalizedName] = normalizedPath.replace(/\\/g, '/');
    }
  }

  return Object.fromEntries(
    Object.entries(nextProjects).sort(([left], [right]) => left.localeCompare(right))
  );
}

function buildProjectGitignoreEntries(projectNames) {
  return projectNames
    .filter((projectName) => String(projectName || '').trim())
    .filter((projectName) => projectName.toLowerCase() !== 'saucedemo')
    .sort((left, right) => left.localeCompare(right))
    .map((projectName) => `/projects/${projectName}`);
}

function syncProjectGitignore(projectNames) {
  const existingContent = fs.existsSync(GITIGNORE_FILE)
    ? fs.readFileSync(GITIGNORE_FILE, 'utf-8')
    : '';
  const normalizedExisting = existingContent.replace(/\r\n/g, '\n');
  const managedEntries = buildProjectGitignoreEntries(projectNames);
  const managedBlock = [GITIGNORE_BLOCK_START, ...managedEntries, GITIGNORE_BLOCK_END].join('\n');
  const blockPattern = new RegExp(
    `${GITIGNORE_BLOCK_START.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\n?[\\s\\S]*?${GITIGNORE_BLOCK_END.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\n?`,
    'm'
  );

  let nextContent = normalizedExisting.replace(blockPattern, '');
  nextContent = nextContent
    .split('\n')
    .filter((line) => !/^\/projects\/[^/\s]+\/?$/.test(line.trim()))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trimEnd();

  nextContent = nextContent
    ? `${nextContent}\n\n${managedBlock}\n`
    : `${managedBlock}\n`;

  const changed = normalizedExisting !== nextContent;
  if (changed) {
    fs.writeFileSync(GITIGNORE_FILE, nextContent, 'utf-8');
  }

  return {
    changed,
    filePath: GITIGNORE_FILE,
    entries: managedEntries,
  };
}

function syncProjectRootsConfig() {
  const config = loadProjectRootsConfig();
  const nextConfig = {
    version: config.version,
    projectsBaseDir: config.projectsBaseDir.replace(/\\/g, '/'),
    projects: buildSyncedProjects(config),
  };
  const existingContent = readJsonIfExists(PROJECT_ROOTS_FILE, null);
  const changed = JSON.stringify(existingContent) !== JSON.stringify(nextConfig);

  if (changed) {
    fs.mkdirSync(path.dirname(PROJECT_ROOTS_FILE), { recursive: true });
    fs.writeFileSync(PROJECT_ROOTS_FILE, `${JSON.stringify(nextConfig, null, 2)}\n`, 'utf-8');
  }
// Function call to add project paths to .gitignore, currently disabled to avoid issues with existing projects. 
// Can be re-enabled once all projects are migrated to the new structure and we want to ensure new projects are ignored by default.
//  const gitignoreResult = syncProjectGitignore(Object.keys(nextConfig.projects));

  return {
    changed: changed, // || gitignoreResult.changed,
    projectRootsChanged: changed,
    gitignoreChanged: false, // gitignoreResult.changed,
    filePath: PROJECT_ROOTS_FILE,
    gitignoreFilePath: null, // gitignoreResult.filePath,
    projectNames: Object.keys(nextConfig.projects),
    config: nextConfig,
  };
}

if (require.main === module) {
  const result = syncProjectRootsConfig();
  console.log(
    `${result.changed ? 'Updated' : 'No changes in'} ${result.filePath} (${result.projectNames.length} projects)`
  );
}

module.exports = {
  syncProjectRootsConfig,
};
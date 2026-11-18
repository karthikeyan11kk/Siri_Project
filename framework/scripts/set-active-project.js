const fs = require('fs');
const path = require('path');

const [, , projectName] = process.argv;

if (!projectName || !projectName.trim()) {
  console.error('Usage: node framework/scripts/set-active-project.js <projectName>');
  process.exit(1);
}

const activeProjectFile = path.resolve(__dirname, '../../configs/active-project.json');

function readJsonIfExists(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    return fallback;
  }
}

function getProjectRuntimeApplicationsPath(name) {
  return path.resolve(__dirname, `../../projects/${name}/config/applications.json`);
}

function resolveDefaultEnvironment(name) {
  const catalog = readJsonIfExists(getProjectRuntimeApplicationsPath(name), null);
  const fromCatalog = String(catalog?.defaultEnvironment || '').trim();
  if (fromCatalog) {
    return fromCatalog;
  }

  const allEnvNames = new Set();
  for (const app of catalog?.applications || []) {
    Object.keys(app?.environments || {}).forEach((envName) => allEnvNames.add(envName));
  }

  return Array.from(allEnvNames)[0] || '';
}

const normalizedProjectName = projectName.trim();
const existing = readJsonIfExists(activeProjectFile, {});
const environmentsByProject = {
  ...(existing.environmentsByProject || {}),
};

const defaultEnvironment = resolveDefaultEnvironment(normalizedProjectName);
if (defaultEnvironment) {
  environmentsByProject[normalizedProjectName] = defaultEnvironment;
}

// Preserve or update scope and scopesByProject
const scopesByProject = {
  ...(existing.scopesByProject || {}),
};
// Default to 'project' scope for the selected project if not set
if (!scopesByProject[normalizedProjectName]) {
  scopesByProject[normalizedProjectName] = 'project';
}
const scope = scopesByProject[normalizedProjectName] || existing.scope || 'project';

const content = {
  projectName: normalizedProjectName,
  environmentName: environmentsByProject[normalizedProjectName] || String(existing.environmentName || '').trim() || '',
  environmentsByProject,
  scopesByProject,
  scope,
};

fs.writeFileSync(activeProjectFile, `${JSON.stringify(content, null, 2)}\n`, 'utf-8');
console.log(`Active project set to: ${content.projectName}`);
if (content.environmentName) {
  console.log(`Active environment set to: ${content.environmentName}`);
}

// Touch the test file to trigger VS Code test discovery refresh
const testFile = path.resolve(__dirname, '../../tests/csv-tests-driver.spec.ts');
try {
  const now = new Date();
  fs.utimesSync(testFile, now, now);
  console.log('Triggered test discovery refresh');
} catch (err) {
  console.warn('Could not trigger test discovery refresh:', err.message);
}

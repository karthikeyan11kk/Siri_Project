const fs = require('fs');
const path = require('path');

/**
 * Sync page classes from test-pages directory to project.config.ts
 * Reads all .ts files in test-pages, extracts class names, and updates project.config.ts
 * Usage: node sync-pages.js [projectName]
 * Example: node sync-pages.js s360-test-assets
 */

// Get project name from command line or use active project
let projectName = process.argv[2];

if (!projectName) {
  // Try to read from active-project.json
  try {
    const activeProjectFile = path.join(__dirname, '../../configs/active-project.json');
    const activeProject = JSON.parse(fs.readFileSync(activeProjectFile, 'utf8'));
    projectName = activeProject.activeProject;
  } catch (err) {
    console.error('Error: Project name not specified. Usage: node sync-pages.js <projectName>');
    process.exit(1);
  }
}

const projectDir = path.join(__dirname, '../../projects', projectName);
const testPagesDir = path.join(projectDir, 'test-pages');
const configFile = path.join(projectDir, 'test-configs', 'project.config.ts');

// Validate paths exist
if (!fs.existsSync(testPagesDir)) {
  console.error(`Error: Test pages directory not found: ${testPagesDir}`);
  process.exit(1);
}

if (!fs.existsSync(configFile)) {
  console.error(`Error: Config file not found: ${configFile}`);
  process.exit(1);
}

// Recursively collect all .ts files from test-pages and subfolders
function collectTsFiles(dir, baseDir) {
  let results = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results = results.concat(collectTsFiles(fullPath, baseDir));
    } else if (entry.isFile() && entry.name.endsWith('.ts')) {
      // Store relative path from test-pages root (e.g. "mod/ITSCoverageAPage.ts")
      results.push(path.relative(baseDir, fullPath).replace(/\\/g, '/'));
    }
  }
  return results;
}

const pageFiles = collectTsFiles(testPagesDir, testPagesDir).sort();

console.log(`[${projectName}] Found page files:`, pageFiles);

// Extract class names from each file
const pageClasses = pageFiles.map(file => {
  const filePath = path.join(testPagesDir, file);
  const content = fs.readFileSync(filePath, 'utf8');
  
  // Extract class name from export statement
  const classMatch = content.match(/export class (\w+)/);
  if (classMatch) {
    return {
      fileName: file,
      className: classMatch[1]
    };
  }
  return null;
}).filter(Boolean);

console.log(`[${projectName}] Extracted classes:`, pageClasses.map(c => c.className));

// Read current config file
let configContent = fs.readFileSync(configFile, 'utf8');

// Keep the generated sections deterministic and unique.
const uniquePageClasses = Array.from(
  new Map(pageClasses.map((p) => [p.className, p])).values()
);

// Generate import statements
const importStatements = uniquePageClasses.map(p => 
  `import { ${p.className} } from '../test-pages/${p.fileName.replace('.ts', '')}';`
).join('\n');

// Generate pageFactories entries
const pageFactoriesEntries = uniquePageClasses.map(p => {
  // Special handling for CustomMethods
  if (p.className === 'CustomMethods') {
    return `    ${p.className}: (page, dataContext) => new ${p.className}(page, dataContext),`;
  }
  return `    ${p.className}: (page) => new ${p.className}(page),`;
}).join('\n');

// Replace imports section
// Flexible regex to handle various line endings and spacing
const importsRegex = /^(import[\s\S]*?)(\r?\n){1,2}(?=export const )/m;
const newImportsSection = `import * as path from 'path';
import { FrameworkProjectConfig } from '../../../framework/references/schema_types';
${importStatements}

`;

if (!importsRegex.test(configContent)) {
  console.error(`Error: Could not locate import section in: ${configFile}`);
  console.error(`Debug: First 500 chars of file:\n${configContent.substring(0, 500)}`);
  process.exit(1);
}

configContent = configContent.replace(importsRegex, newImportsSection);

// Replace pageFactories section
const pageFactoriesRegex = /pageFactories: \{[\s\S]*?\},/;
const newPageFactoriesSection = `pageFactories: {
${pageFactoriesEntries}
  },`;

configContent = configContent.replace(pageFactoriesRegex, newPageFactoriesSection);

// Write back to config file
fs.writeFileSync(configFile, configContent, 'utf8');

console.log(`✓ [${projectName}] Successfully synced project.config.ts with page classes`);
console.log(`✓ [${projectName}] Updated ${uniquePageClasses.length} page classes`);
console.log(`✓ [${projectName}] Changes written to:`, configFile);


const { createProjectScaffold, normalizeProjectName } = require('./project-scaffold');
const { syncProjectRootsConfig } = require('./sync-project-roots');

const [, , rawProjectName] = process.argv;
const projectName = normalizeProjectName(rawProjectName);

if (!projectName) {
  console.error('Usage: node framework/scripts/create-project-scaffold.js <projectName>');
  process.exit(1);
}

createProjectScaffold(projectName)
  .then((result) => {
    const syncResult = syncProjectRootsConfig();
    console.log(`Project scaffold ready: ${result.projectName}`);
    console.log(`Project root: ${result.projectRoot}`);
    console.log(`Project roots ${syncResult.changed ? 'updated' : 'already current'}: ${syncResult.filePath}`);
  })
  .catch((err) => {
    console.error(String(err.message || err));
    process.exit(1);
  });
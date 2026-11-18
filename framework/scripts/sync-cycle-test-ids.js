const fs = require('fs/promises');
const path = require('path');
const { splitMetadata, prepareMetadataSave } = require('./csv-metadata');

function scriptKey(value) {
  return path.posix.normalize(String(value || '').trim().replace(/\\/g, '/'))
    .replace(/^\.\//, '').replace(/\.csv$/i, '').toLowerCase();
}

async function syncCycleTestIds(cyclesRoot, scriptPath, testId) {
  const result = { script: scriptPath, testId, updatedFiles: [], updatedEntries: 0, errors: [] };
  if (!cyclesRoot) return result;
  const target = scriptKey(scriptPath);

  async function visit(directory) {
    let entries;
    try { entries = await fs.readdir(directory, { withFileTypes: true }); }
    catch (error) {
      if (directory === cyclesRoot && error.code === 'ENOENT') return;
      result.errors.push(`${path.relative(cyclesRoot, directory) || '.'}: ${error.message}`);
      return;
    }
    for (const entry of entries) {
      const filename = path.join(directory, entry.name);
      if (entry.isDirectory()) { await visit(filename); continue; }
      if (!entry.isFile() || !/\.json$/i.test(entry.name)) continue;
      const relativePath = path.relative(cyclesRoot, filename).replace(/\\/g, '/');
      try {
        const raw = await fs.readFile(filename, 'utf8');
        const cycle = JSON.parse(raw);
        let changes = 0;
        for (const stage of cycle.stages || []) {
          for (const test of stage.tests || []) {
            if (test && scriptKey(test.test) === target && test.testId !== testId) {
              test.testId = testId;
              changes++;
            }
          }
        }
        if (changes) {
          await fs.writeFile(filename, JSON.stringify(cycle, null, 2), 'utf8');
          result.updatedFiles.push(relativePath);
          result.updatedEntries += changes;
        }
      } catch (error) { result.errors.push(`${relativePath}: ${error.message}`); }
    }
  }

  await visit(cyclesRoot);
  return result;
}

async function prepareCycleTestIdSave(cycle, edits, resolveScript, username, timestamp) {
  const proposals = new Map();
  const references = new Map();
  for (const stage of cycle.stages || []) {
    for (const entry of stage.tests || []) {
      if (String(entry.test || '').trim()) references.set(scriptKey(entry.test), entry.test);
    }
  }
  if (!Array.isArray(edits)) throw new Error('Cycle Test ID edits must be an array.');
  for (const edit of edits) {
    const key = scriptKey(edit.script);
    const testId = String(edit.testId ?? '').trim();
    if (!references.has(key)) throw new Error(`Edited script is not in this cycle: ${edit.script}`);
    if (proposals.has(key) && proposals.get(key) !== testId) {
      throw new Error(`Conflicting Test ID edits for script ${edit.script}. Use one ID for every occurrence.`);
    }
    proposals.set(key, testId);
  }

  const canonicalIds = new Map();
  const writes = [];
  const updates = [];
  for (const [key, script] of references) {
    const scriptPath = /\.csv$/i.test(script) ? script : `${script}.csv`;
    const filename = resolveScript(scriptPath.replace(/\\/g, '/'));
    let content;
    try { content = await fs.readFile(filename, 'utf8'); }
    catch (error) {
      if (!proposals.has(key) && error.code === 'ENOENT') continue;
      throw new Error(`Cannot read script ${script}: ${error.message}`);
    }
    const metadata = splitMetadata(content).metadata;
    if (proposals.has(key)) {
      const testId = proposals.get(key);
      if (String(metadata?.testId || '').trim() !== testId) {
        const saved = prepareMetadataSave(content, { testId }, content, false, false, username, timestamp);
        writes.push({ filename, content: saved.content, originalContent: content });
      }
      canonicalIds.set(key, testId);
      updates.push({ script, testId });
    } else if (metadata) {
      canonicalIds.set(key, String(metadata.testId || '').trim());
    }
  }
  for (const stage of cycle.stages || []) {
    for (const entry of stage.tests || []) {
      const key = scriptKey(entry.test);
      if (canonicalIds.has(key)) entry.testId = canonicalIds.get(key);
    }
  }
  return { cycle, writes, updates };
}

module.exports = { syncCycleTestIds, prepareCycleTestIdSave };
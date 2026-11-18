/**
 * Migration CLI - command-line interface for running migrations
 * Usage: npm run migrate:playwright -- <spec-file> --project=<project-name> [--dry-run]
 */

import * as path from 'path';
import * as fs from 'fs';
import { MigrationOrchestrator } from '../core/orchestrator';
import { MigrationOptions } from '../core/types';

// ─── Editable Defaults ───────────────────────────────────────────────────────
// Update these values to control migration input/output defaults.
const DEFAULT_SPEC_FILE = 'tests/recordings/recorded-test.spec.ts';
const DEFAULT_PROJECT_NAME = 's360-test-assets';
const DEFAULT_PAGE_OUTPUT_DIR_TEMPLATE = 'projects/{project}/test-pages';
const DEFAULT_CSV_OUTPUT_DIR_TEMPLATE = 'projects/{project}/test-scripts/generated';
const DEFAULT_CSV_FILE_NAME = 'migrated_test'; // e.g. 'tc_login_001' (without .csv). Empty = infer from spec file.
//
// Set to true to print line-by-line parse details and page object assignments.
// Can also be enabled at runtime via --verbose flag.
const VERBOSE_LOGGING = false;

function resolveTemplate(template: string, projectName: string): string {
  return template.replace('{project}', projectName);
}

function findSpecArg(args: string[]): string | null {
  for (const arg of args) {
    if (!arg.startsWith('--')) {
      return arg;
    }
  }
  return null;
}

async function main() {
  const args = process.argv.slice(2);

  const specFileArg = findSpecArg(args) || DEFAULT_SPEC_FILE;
  const options: MigrationOptions = {};
  let dryRun = false;

  // Parse options
  for (const arg of args) {
    if (!arg.startsWith('--')) {
      continue;
    }

    if (arg === '--dry-run') {
      options.dryRun = true;
      dryRun = true;
    } else if (arg.startsWith('--project=')) {
      options.projectName = arg.split('=')[1];
    } else if (arg.startsWith('--input=')) {
      // Optional named input form, equivalent to first positional spec-file argument.
      // If provided, it takes precedence over positional input.
      const value = arg.split('=')[1];
      if (value) {
        // set below after validation
      }
    } else if (arg.startsWith('--strategy=')) {
      const strategy = arg.split('=')[1];
      if (['reuse', 'rename', 'skip'].includes(strategy)) {
        options.mergeStrategy = strategy as 'reuse' | 'rename' | 'skip';
      }
    } else if (arg.startsWith('--script-name=')) {
      options.scriptName = arg.split('=')[1];
    } else if (arg.startsWith('--page-output-dir=')) {
      options.pageOutputDir = arg.split('=')[1];
    } else if (arg.startsWith('--csv-output-dir=')) {
      options.csvOutputDir = arg.split('=')[1];
    } else if (arg === '--verbose') {
      options.verbose = true;
    }
  }

  if (!options.verbose && VERBOSE_LOGGING) {
    options.verbose = true;
  }

  const inputOverride = args.find((arg) => arg.startsWith('--input='))?.split('=')[1];
  const finalSpecInput = (inputOverride && inputOverride.trim()) || specFileArg;

  const projectName = (options.projectName || '').trim() || DEFAULT_PROJECT_NAME;
  options.projectName = projectName;

  if (!options.scriptName && DEFAULT_CSV_FILE_NAME.trim()) {
    options.scriptName = DEFAULT_CSV_FILE_NAME.trim();
  }

  options.pageOutputDir =
    (options.pageOutputDir && options.pageOutputDir.trim()) ||
    resolveTemplate(DEFAULT_PAGE_OUTPUT_DIR_TEMPLATE, projectName);

  options.csvOutputDir =
    (options.csvOutputDir && options.csvOutputDir.trim()) ||
    resolveTemplate(DEFAULT_CSV_OUTPUT_DIR_TEMPLATE, projectName);

  // Validate spec file
  if (!finalSpecInput.endsWith('.ts')) {
    console.error('Error: Spec file must be a TypeScript file (.ts)');
    process.exit(1);
  }

  const specFile = resolveSpecFilePath(finalSpecInput);
  if (!specFile) {
    console.error(`Error: Spec file not found: ${finalSpecInput}`);
    console.error('Provide a full path or a file under tests/ or tests/recordings/.');
    process.exit(1);
  }

  // Run migration
  try {
    console.log('====================================');
    console.log('  Playwright to CSV Migration Tool');
    console.log('====================================\n');

    console.log(`[config] input=${specFile}`);
    console.log(`[config] project=${options.projectName}`);
    console.log(`[config] pageOutputDir=${options.pageOutputDir}`);
    console.log(`[config] csvOutputDir=${options.csvOutputDir}`);
    if (options.scriptName) {
      console.log(`[config] csvFileName=${options.scriptName}.csv`);
    }
    console.log('');

    if (dryRun) {
      console.log('[DRY-RUN MODE] No files will be written\n');
    }

    const report = await MigrationOrchestrator.migratePlaywrightSpec(specFile, options);
    MigrationOrchestrator.printReport(report);

    process.exit(report.success ? 0 : 1);
  } catch (error) {
    const err = error instanceof Error ? error.message : String(error);
    console.error(`Fatal error: ${err}`);
    process.exit(1);
  }
}

function resolveSpecFilePath(inputPath: string): string | null {
  const candidatePaths = [
    path.resolve(process.cwd(), inputPath),
    path.resolve(process.cwd(), 'tests', inputPath),
    path.resolve(process.cwd(), 'tests', 'recordings', inputPath),
  ];

  for (const candidate of candidatePaths) {
    if (path.isAbsolute(inputPath) && candidate !== candidatePaths[0]) {
      continue;
    }

    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
}

function printUsage() {
  console.log(`
Usage: npm run migrate:playwright -- [<spec-file>] [options]

Arguments:
  <spec-file>                  Path to Playwright spec file (*.ts), optional

Options:
  --input=<path>               Input spec file path (same as positional argument)
  --project=<name>             Project name
  --strategy=<strategy>        Merge strategy: reuse|rename|skip (default: reuse)
  --script-name=<name>         Custom name for generated CSV script
  --page-output-dir=<path>     Directory for generated page object .ts files
  --csv-output-dir=<path>      Directory for generated CSV file
  --dry-run                    Don't write files, just show what would happen

Defaults (editable at top of this file):
  DEFAULT_SPEC_FILE=${DEFAULT_SPEC_FILE}
  DEFAULT_PROJECT_NAME=${DEFAULT_PROJECT_NAME}
  DEFAULT_PAGE_OUTPUT_DIR_TEMPLATE=${DEFAULT_PAGE_OUTPUT_DIR_TEMPLATE}
  DEFAULT_CSV_OUTPUT_DIR_TEMPLATE=${DEFAULT_CSV_OUTPUT_DIR_TEMPLATE}
  DEFAULT_CSV_FILE_NAME=${DEFAULT_CSV_FILE_NAME || '(infer from spec file)'}

Examples:
  npm run migrate:playwright --
  npm run migrate:playwright -- recorded-test.spec.ts --project=s360
  npm run migrate:playwright -- --input=tests/recordings/recorded-test.spec.ts --project=saucedemo
  npm run migrate:playwright -- --project=s360 --page-output-dir=projects/s360/pages --csv-output-dir=projects/s360/test-scripts
`);
}

main();

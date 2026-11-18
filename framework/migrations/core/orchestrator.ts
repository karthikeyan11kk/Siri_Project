/**
 * Migration orchestrator - main entry point for conversion pipeline
 */

import * as fs from 'fs';
import * as path from 'path';
import { MigrationModel, MigrationOptions } from './types';
import { PlaywrightSpecParser } from '../adapters/playwright/spec-parser';
import { PageObjectManager } from './page-object-manager';
import { PageObjectEmitter } from '../emitters/page-object-emitter';
import { CSVScriptEmitter } from '../emitters/csv-script-emitter';

export interface MigrationReport {
  success: boolean;
  scriptName: string;
  projectName: string;
  pagesGenerated: string[];
  pagesUpdated: string[];
  csvScriptPath: string;
  errors: string[];
  warnings: string[];
}

export class MigrationOrchestrator {
  /**
   * Main entry point: convert Playwright recorded spec to page objects + CSV script
   */
  static async migratePlaywrightSpec(
    specFilePath: string,
    options: MigrationOptions = {}
  ): Promise<MigrationReport> {
    const projectName = (options.projectName || '').trim();
    if (!projectName) {
      throw new Error('projectName is required for migration. Pass --project=<name> in CLI usage.');
    }

    const report: MigrationReport = {
      success: false,
      scriptName: '',
      projectName,
      pagesGenerated: [],
      pagesUpdated: [],
      csvScriptPath: '',
      errors: [],
      warnings: [],
    };

    try {
      // Step 1: Parse Playwright spec
      console.log(`[Migration] Parsing Playwright spec: ${specFilePath}`);
      const defaultPageOutputDir = path.join('projects', report.projectName, 'pages_old');
      const defaultCsvOutputDir = path.join('projects', report.projectName, 'test-scripts');
      const model = PlaywrightSpecParser.parseSpecFile(specFilePath, report.projectName, {
        scriptName: options.scriptName,
        pageOutputDir: options.pageOutputDir || defaultPageOutputDir,
        verbose: options.verbose,
      });
      report.scriptName = model.scriptName;

      // Step 2: Process each page class
      console.log(`[Migration] Processing ${model.pages.size} page(s)...`);
      for (const [pageName, pageClass] of model.pages) {
        console.log(`  → ${pageName}`);

        // Load existing page class if it exists
        const existing = PageObjectManager.loadExistingPageClass(pageClass.filePath);

        if (existing) {
          // Merge with existing
          const mergeResult = PageObjectManager.mergePageObjects(
            existing,
            pageClass.objects,
            options.mergeStrategy || 'reuse'
          );

          console.log(`    Added: ${mergeResult.added.length}, Reused: ${mergeResult.reused.length}, Skipped: ${mergeResult.skipped.length}`);

          if (mergeResult.skipped.length > 0) {
            report.warnings.push(`${pageName}: ${mergeResult.skipped.length} objects skipped due to conflicts`);
          }

          PageObjectEmitter.writePageClass(existing, options.dryRun);
          report.pagesUpdated.push(pageName);
        } else {
          // Create new page class
          PageObjectEmitter.writePageClass(pageClass, options.dryRun);
          report.pagesGenerated.push(pageName);
        }
      }

      // Step 3: Generate CSV script
      console.log(`[Migration] Generating CSV script: ${model.scriptName}`);
      const csvDir = options.csvOutputDir || defaultCsvOutputDir;
      const csvPath = CSVScriptEmitter.writeCSVScript(model, csvDir, options.dryRun);
      report.csvScriptPath = csvPath;

      console.log(`[Migration] ✓ Success`);
      console.log(`  Generated pages: ${report.pagesGenerated.length}`);
      console.log(`  Updated pages: ${report.pagesUpdated.length}`);
      console.log(`  CSV script: ${csvPath}`);

      report.success = true;
    } catch (error) {
      const err = error instanceof Error ? error.message : String(error);
      report.errors.push(err);
      console.error(`[Migration] ✗ Error: ${err}`);
    }

    return report;
  }

  /**
   * Validate migration report and provide summary
   */
  static printReport(report: MigrationReport): void {
    console.log('\n=== Migration Report ===');
    console.log(`Status: ${report.success ? '✓ SUCCESS' : '✗ FAILED'}`);
    console.log(`Project: ${report.projectName}`);
    console.log(`Script: ${report.scriptName}`);
    console.log(`Pages Generated: ${report.pagesGenerated.length} (${report.pagesGenerated.join(', ')})`);
    console.log(`Pages Updated: ${report.pagesUpdated.length} (${report.pagesUpdated.join(', ')})`);
    console.log(`CSV Script: ${report.csvScriptPath}`);

    if (report.warnings.length > 0) {
      console.log('\nWarnings:');
      report.warnings.forEach((w) => console.log(`  ⚠ ${w}`));
    }

    if (report.errors.length > 0) {
      console.log('\nErrors:');
      report.errors.forEach((e) => console.log(`  ✗ ${e}`));
    }
  }
}

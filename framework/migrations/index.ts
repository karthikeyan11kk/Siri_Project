/**
 * Migrations package - export all public APIs
 */

export { MigrationOrchestrator, MigrationReport } from './core/orchestrator';
export { PageObjectManager } from './core/page-object-manager';
export { PageObjectEmitter } from './emitters/page-object-emitter';
export { CSVScriptEmitter } from './emitters/csv-script-emitter';
export { PlaywrightSpecParser } from './adapters/playwright/spec-parser';
export type { MigrationModel, PageClass, PageObject, TestAction, TestScript, MigrationOptions } from './core/types';

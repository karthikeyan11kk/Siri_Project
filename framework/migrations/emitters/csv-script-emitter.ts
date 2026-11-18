/**
 * CSV script emitter - generates CSV test scripts from migration model
 */

import * as fs from 'fs';
import * as path from 'path';
import { MigrationModel, TestAction } from '../core/types';

export class CSVScriptEmitter {
  /**
   * Generate CSV script content from migration model
   * Applies STRICT column contract transformations
   */
  static generateCSVScript(model: MigrationModel): string {
    const headers = 'Run,Step,Action,Page,Object,Condition,Data';
    const lines: string[] = [headers];

    for (let i = 0; i < model.testScript.actions.length; i++) {
      const action = model.testScript.actions[i];
      const step = i + 1;
      const csvLine = this.actionToCSVLine(action, step);
      lines.push(csvLine);
    }

    return lines.join('\n');
  }

  /**
   * Convert a test action to CSV line format with STRICT contract transformations
   * Format: Run,Step,Action,Page,Object,Condition,Data
   * STRICT rules:
   * - Dynamic params ONLY in Condition (FILL, CLICK, SELECT, etc.)
   * - Timeout ONLY in Data (CLICK_TO_SWITCH, SWITCH_CONTEXT, ASSERT)
   * - ASSERT state ONLY in Condition
   */
  private static actionToCSVLine(action: TestAction, step: number): string {
    const run = 'Y';
    const stepNum = step.toString();
    const actionType = action.action;
    const page = action.page || '';
    const object = action.object || '';

    // Apply STRICT contract transformations
    const { condition: strictCondition, data: strictData } = this.transformToStrict(action);

    const data = this.escapeCSVData(strictData || '');

    return `${run},${stepNum},${actionType},${page},${object},${strictCondition},${data}`;
  }

  /**
   * Transform TestAction to STRICT column contract format
   * Handles:
   * - Moving params from Data to Condition
   * - Moving timeout from Condition to Data
   * - Splitting packed values (e.g., op|expected → operator in Condition, expected in Data)
   */
  private static transformToStrict(action: TestAction): { condition: string; data: string } {
    let condition = action.condition || '';
    let data = action.data || '';

    switch (action.action.toUpperCase()) {
      // Dynamic params actions: params in Condition, value in Data (STRICT)
      case 'FILL':
      case 'SELECT':
      case 'TYPE_TEXT':
        // Data stays as-is (fill value or option value)
        // Condition may contain params from old format - keep as-is for STRICT
        break;

      case 'CLICK':
      case 'DOUBLE_CLICK':
      case 'RIGHT_CLICK':
      case 'HOVER':
        // params in Condition (STRICT), Data unused
        // Old format may have params in Data - move to Condition
        if (data && data.includes('|') && !condition) {
          condition = data; // Move pipe-separated params to Condition
          data = '';
        }
        break;

      case 'USE_FETCHED_VALUE':
        // Keys in Data (STRICT), Condition unused
        // Keep Data as-is (comma-separated keys)
        break;

      // Timeout actions: timeout ONLY in Data (STRICT)
      case 'CLICK_TO_SWITCH':
      case 'SWITCH_CONTEXT':
        // Old format may have timeout in Condition - move to Data
        if (condition && !data) {
          const timeoutValue = this.extractTimeout(condition);
          if (timeoutValue) {
            data = timeoutValue;
            condition = ''; // Clear Condition for STRICT
          }
        }
        // If both have values, prefer Data (STRICT)
        break;

      // ASSERT: state in Condition (STRICT), timeout in Data (STRICT)
      case 'ASSERT':
      case 'SOFTASSERT':
        // State must be in Condition (required for STRICT)
        // Timeout should be in Data (optional)
        if (!condition && data) {
          // Old format may have state in Data - move to Condition
          condition = data;
          data = '';
        }
        // If Data looks like timeout (numeric), keep it; otherwise clear
        if (data && !/^\d+$/.test(data)) {
          data = '';
        }
        break;

      // API Actions
      case 'API_STORE_JSON':
        // Object=jsonPath (handled by page/object), Data=store key (STRICT)
        // This is handled by spec parser, but ensure format
        break;

      case 'API_ASSERT_JSON':
      case 'API_SOFTASSERT_JSON':
        // STRICT format: Object=jsonPath, Condition=operator, Data=expected value
        // Migration doesn't generate these yet, but if it does:
        // condition = operator, data = expected value (unpacked)
        break;

      // Keep other actions as-is
      default:
        break;
    }

    return { condition, data };
  }

  /**
   * Extract timeout value from condition string
   * Handles: "5000" or "timeout=5000" → "5000"
   */
  private static extractTimeout(conditionStr: string): string {
    if (!conditionStr) return '';

    const trimmed = conditionStr.trim();

    // Already a number
    if (/^\d+$/.test(trimmed)) {
      return trimmed;
    }

    // timeout=<number> format
    const match = trimmed.match(/timeout\s*=\s*(\d+)/i);
    if (match) {
      return match[1];
    }

    return '';
  }

  /**
   * Escape and quote CSV data if needed
   */
  private static escapeCSVData(value: string): string {
    if (!value) {
      return '';
    }

    // Quote if contains comma, newline, or quote
    if (value.includes(',') || value.includes('\n') || value.includes('"')) {
      return `"${value.replace(/"/g, '""')}"`;
    }

    return value;
  }

  /**
   * Write CSV script file to disk
   */
  static writeCSVScript(model: MigrationModel, outputDir: string, dryRun: boolean = false): string {
    const content = this.generateCSVScript(model);
    const fileName = `${model.scriptName}.csv`;
    const filePath = path.join(outputDir, fileName);

    if (!dryRun) {
      if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
      }
      fs.writeFileSync(filePath, content, 'utf-8');
    }

    return filePath;
  }

  /**
   * Generate flow CSV (if needed to organize multiple test scripts)
   */
  static generateFlowCSV(scriptNames: string[]): string {
    const headers = 'Run,Step,Action,Data';
    const lines: string[] = [headers];

    for (let i = 0; i < scriptNames.length; i++) {
      const step = i + 1;
      lines.push(`Y,${step},RUN_SCRIPT,${scriptNames[i]}`);
    }

    return lines.join('\n');
  }
}

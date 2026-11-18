/**
 * CSV Parser
 *
 * Parses CSV test script/data files into normalized row objects
 * consumed by the CSV runner and data context.
 */

import * as fs from 'fs';
import * as path from 'path';
const { splitMetadata } = require('../scripts/csv-metadata');

export type CSVMetadata = {
  testId: string;
  createdBy: string;
  createdOn: string;
  updatedBy: string;
  updatedOn: string;
  labels: string;
};

export interface TestStep {
  run?: string;
  step: number;
  description?: string;
  action: string;
  page: string;
  object: string;
  condition: string;
  data: string;
  optional?: boolean;
}

export interface TestData {
  [key: string]: string | number | boolean;
}

export class CSVParser {
  static parseMetadata(filePath: string): CSVMetadata | null {
    return splitMetadata(fs.readFileSync(filePath, 'utf-8')).metadata;
  }
  /**
   * Simple CSV parser - parses CSV string into objects
   */
  private static parseCSVLine(line: string): string[] {
    const result: string[] = [];
    let current = '';
    let inQuotes = false;

    for (let i = 0; i < line.length; i++) {
      const char = line[i];
      const nextChar = line[i + 1];

      if (char === '"') {
        if (inQuotes && nextChar === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = !inQuotes;
        }
      } else if (char === ',' && !inQuotes) {
        result.push(current.trim());
        current = '';
      } else {
        current += char;
      }
    }

    result.push(current.trim());
    return result;
  }

  /**
   * Parses a CSV file and returns test steps
   */
  static parseTestSteps(filePath: string): TestStep[] {
    if (!fs.existsSync(filePath)) {
      console.warn(`CSV file not found: ${filePath}`);
      return [];
    }

    const fileContent = fs.readFileSync(filePath, 'utf-8');
    const lines = splitMetadata(fileContent).content.split('\n').filter((line) => line.trim());

    if (lines.length === 0) {
      return [];
    }

    // Parse header - Run-enabled schema is required.
    const headerLine = lines[0];
    const headers = this.parseCSVLine(headerLine).map((header) => header.trim().toLowerCase());
    const expectedHeaders = ['run', 'step', 'action', 'page', 'object', 'condition', 'data'];

    if (
      headers.length !== expectedHeaders.length ||
      headers.some((header, index) => header !== expectedHeaders[index])
    ) {
      throw new Error(
        `Invalid CSV header in ${filePath}. Expected: ${expectedHeaders.join(',')}. Received: ${headers.join(',')}`
      );
    }

    const stepIndex = headers.indexOf('step');
    const actionIndex = headers.indexOf('action');
    const pageIndex = headers.indexOf('page');
    const objectIndex = headers.indexOf('object');
    const conditionIndex = headers.indexOf('condition');
    const dataIndex = headers.indexOf('data');
    const runIndex = headers.indexOf('run');

    const records: TestStep[] = [];

    // Parse data rows
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;

      const values = this.parseCSVLine(line);
      const rowNumber = i + 1;

      if (values.length !== headers.length) {
        throw new Error(
          `Invalid CSV row in ${filePath} at line ${rowNumber}. ` +
          `\nExpected ${headers.length} columns (${expectedHeaders.join(',')}), received ${values.length}. ` +
          `\nRow: ${line}`
        );
      }

      const run = values[runIndex] || 'Y';
      const step = values[stepIndex] || '0';
      const action = values[actionIndex] || '';
      const page = values[pageIndex] || '';
      const object = values[objectIndex] || '';
      const condition = values[conditionIndex] || '';
      const data = values[dataIndex] || '';
      const parsedStep = Number(step);

      if (!Number.isFinite(parsedStep)) {
        throw new Error(
          `Invalid step value in ${filePath} at line ${rowNumber}. ` +
            `Step must be numeric, received '${step}'.`
        );
      }

      if (!action.trim()) {
        throw new Error(
          `Invalid action in ${filePath} at line ${rowNumber}. Action column cannot be empty.`
        );
      }

      records.push({
        run,
        step: parsedStep,
        description: `${page}.${object} ${action}`.trim(),
        page,
        object,
        condition,
        action,
        data,
        optional: false,
      });
    }

    return records;
  }

  /**
   * Parses test data CSV (e.g., users, products)
   */
  static parseTestData(filePath: string): TestData[] {
    if (!fs.existsSync(filePath)) {
      console.warn(`Data file not found: ${filePath}`);
      return [];
    }

    const fileContent = fs.readFileSync(filePath, 'utf-8');
    const lines = fileContent.split('\n').filter((line) => line.trim());

    if (lines.length === 0) {
      return [];
    }

    const headerLine = lines[0];
    const headers = this.parseCSVLine(headerLine);

    const records: TestData[] = [];

    for (let i = 1; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;

      const values = this.parseCSVLine(line);
      const record: TestData = {};

      headers.forEach((header, index) => {
        record[header.toLowerCase()] = values[index] || '';
      });

      records.push(record);
    }

    return records;
  }

  /**
   * Loads all test case CSVs from a directory
   */
  static loadAllTestCases(dirPath: string): Map<string, TestStep[]> {
    const allTestSteps = new Map<string, TestStep[]>();

    if (!fs.existsSync(dirPath)) {
      console.warn(`Directory not found: ${dirPath}`);
      return allTestSteps;
    }

    const files = fs.readdirSync(dirPath).filter((f) => f.endsWith('.csv'));

    files.forEach((file) => {
      const filePath = path.join(dirPath, file);
      const featureName = path.basename(file, '.csv');
      const steps = CSVParser.parseTestSteps(filePath);
      allTestSteps.set(featureName, steps);
    });

    return allTestSteps;
  }

  /**
   * Groups test steps by test ID. The current CSV schema is one test per file,
   * so steps are returned under a single default key.
   */
  static groupByTestID(testSteps: TestStep[]): Map<string, TestStep[]> {
    const grouped = new Map<string, TestStep[]>();
    grouped.set('default', testSteps);
    return grouped;
  }
}

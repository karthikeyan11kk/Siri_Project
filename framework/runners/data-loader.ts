/**
 * Data Loader - Manages test data from CSV and context
 */

import * as fs from 'fs';
import * as path from 'path';
import { CSVParser, TestData } from './csv-parser';

export class DataContext {
  private data: Map<string, any> = new Map();
  private testData: Map<string, TestData[]> = new Map();
  private testDataRootDir: string = '';

  private normalizeKey(key: string): string {
    return (key || '').toLowerCase();
  }

  private normalizeDataSourceKey(dataSource: string): string {
    return String(dataSource || '')
      .trim()
      .replace(/\\+/g, '/')
      .replace(/\.csv$/i, '')
      .toLowerCase();
  }

  private withRuntimePrefix(key: string): string {
    const normalized = this.normalizeKey(key);
    if (!normalized) {
      return normalized;
    }
    return normalized.startsWith('rt_') ? normalized : `rt_${normalized}`;
  }

  /**
   * Store a value in context
   */
  storeValue(key: string, value: any): void {
    this.data.set(this.normalizeKey(key), value);
  }

  /**
   * Store a value in context using rt_ runtime prefix convention.
   */
  storeValueWithRuntimePrefix(key: string, value: any): string {
    const prefixedKey = this.withRuntimePrefix(key);
    this.data.set(prefixedKey, value);
    return prefixedKey;
  }

  /**
   * Retrieve a stored value
   */
  getValue(key: string): any {
    const normalized = this.normalizeKey(key);
    if (!normalized) {
      return undefined;
    }
    return this.data.get(normalized);
  }

  /**
   * Set the root directory for lazy-loading test data
   */
  setTestDataRootDir(dir: string): void {
    this.testDataRootDir = dir;
  }

  /**
   * Lazy-load test data if not already loaded
   */
  private ensureTestDataLoaded(dataSource: string): void {
    const normalizedKey = this.normalizeDataSourceKey(dataSource);
    if (this.testData.has(normalizedKey)) {
      return; // Already loaded
    }

    if (!this.testDataRootDir) {
      throw new Error(`Test data root directory not set. Cannot lazy-load ${dataSource}`);
    }

    // Try to find and load the CSV file
    const findAndLoadCsv = (root: string, name: string): boolean => {
      const normalizedName = String(name || '').trim().replace(/\\+/g, '/').replace(/\.csv$/i, '');
      if (!normalizedName) return false;

      const checkFile = (filePath: string): boolean => {
        if (fs.existsSync(filePath)) {
          this.loadTestData(name, filePath);
          return true;
        }
        return false;
      };

      // Try direct path with extension
      if (checkFile(path.join(root, `${normalizedName}.csv`))) return true;

      // Try recursive search in subdirectories
      if (fs.existsSync(root)) {
        const searchInDir = (dir: string): boolean => {
          const entries = fs.readdirSync(dir, { withFileTypes: true });
          for (const entry of entries) {
            const fullPath = path.join(dir, entry.name);
            if (entry.isDirectory()) {
              if (searchInDir(fullPath)) return true;
              continue;
            }
            if (entry.isFile() && entry.name.toLowerCase().endsWith('.csv')) {
              const baseKey = this.normalizeDataSourceKey(path.basename(fullPath, '.csv'));
              const relKey = this.normalizeDataSourceKey(path.relative(root, fullPath));
              if (baseKey === normalizedKey || relKey === normalizedKey) {
                this.loadTestData(name, fullPath);
                return true;
              }
            }
          }
          return false;
        };
        return searchInDir(root);
      }
      return false;
    };

    findAndLoadCsv(this.testDataRootDir, dataSource);
    
    // If still not found after lazy-load attempt, throw error
    if (!this.testData.has(normalizedKey)) {
      throw new Error(`Test data source not found: ${dataSource}`);
    }
  }

  /**
   * Get test data from loaded CSV
   */
  getTestData(dataSource: string, filter?: Record<string, string>): TestData | undefined {
    this.ensureTestDataLoaded(dataSource);
    const dataSet = this.testData.get(this.normalizeDataSourceKey(dataSource));
    
    if (!dataSet) {
      throw new Error(`Test data source not found: ${dataSource}`);
    }

    if (!filter) {
      return dataSet[0];
    }

    // Find matching record
    return dataSet.find((record) => {
      return Object.entries(filter).every(([key, value]) => {
        return record[key.toLowerCase()] === value;
      });
    });
  }

  /**
   * Get all test data rows from a loaded CSV, optionally filtered.
   */
  getTestDataRows(dataSource: string, filter?: Record<string, string>): TestData[] {
    this.ensureTestDataLoaded(dataSource);
    const dataSet = this.testData.get(this.normalizeDataSourceKey(dataSource));

    if (!dataSet) {
      throw new Error(`Test data source not found: ${dataSource}`);
    }

    if (!filter) {
      return [...dataSet];
    }

    return dataSet.filter((record) => {
      return Object.entries(filter).every(([key, value]) => {
        return record[key.toLowerCase()] === value;
      });
    });
  }

  /**
   * Load a test data CSV
   */
  loadTestData(name: string, filePath: string): void {
    const data = CSVParser.parseTestData(filePath);
    this.testData.set(this.normalizeDataSourceKey(name), data);
  }

  /**
   * Load all test data from directory
   */
  loadAllTestData(dirPath: string): void {
    if (!fs.existsSync(dirPath)) {
      console.warn(`Data directory not found: ${dirPath}`);
      return;
    }

    const collectCsvFiles = (root: string, files: string[] = []): string[] => {
      const entries = fs.readdirSync(root, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(root, entry.name);
        if (entry.isDirectory()) {
          collectCsvFiles(fullPath, files);
          continue;
        }

        if (entry.isFile() && entry.name.toLowerCase().endsWith('.csv')) {
          files.push(fullPath);
        }
      }
      return files;
    };

    const csvFiles = collectCsvFiles(dirPath);

    for (const filePath of csvFiles) {
      const parsed = CSVParser.parseTestData(filePath);
      const relPathKey = this.normalizeDataSourceKey(path.relative(dirPath, filePath));
      const baseNameKey = this.normalizeDataSourceKey(path.basename(filePath, '.csv'));

      // Primary key: relative path from test-data root (supports subfolders, e.g. mod/mod_account_submission)
      this.testData.set(relPathKey, parsed);

      // Backward compatibility: base filename key when not already taken by another file
      if (!this.testData.has(baseNameKey)) {
        this.testData.set(baseNameKey, parsed);
      }
    }
  }

  /**
   * Update a CSV-backed data row by scenario name.
   */
  async writeDataToCsv(
    valueToWrite: string,
    dataSheet: string,
    scenarioName: string,
    columnName: string,
    testDataRootDir: string
  ): Promise<void> {
    if (!dataSheet || !columnName || !scenarioName) {
      throw new Error('WRITE_DATA requires Object=dataSheet, Condition=columnName, Data=scenarioName, Page=valueToWrite');
    }

    const findCsvFile = (root: string, name: string): string | undefined => {
      const normalizedName = String(name || '').trim().replace(/\\+/g, '/').replace(/\.csv$/i, '');
      if (!normalizedName) {
        return undefined;
      }

      // Support path-like sheet names (for example: mod/mod_account_submission)
      if (normalizedName.includes('/')) {
        const directCandidates = [
          path.join(root, `${normalizedName}.csv`),
          path.join(root, normalizedName),
        ];

        for (const candidate of directCandidates) {
          if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
            return candidate;
          }
        }
      }

      const candidates = [
        path.join(root, `${normalizedName}.csv`),
        path.join(root, normalizedName, `${path.basename(normalizedName)}.csv`),
      ];

      for (const candidate of candidates) {
        if (fs.existsSync(candidate)) {
          return candidate;
        }
      }

      if (fs.existsSync(root)) {
        for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
          if (!entry.isDirectory()) {
            continue;
          }

          const nestedMatch = findCsvFile(path.join(root, entry.name), normalizedName);
          if (nestedMatch) {
            return nestedMatch;
          }
        }
      }

      return undefined;
    };

    const csvFile = findCsvFile(testDataRootDir, dataSheet);
    if (!csvFile) {
      throw new Error(`WRITE_DATA: Could not find CSV file for data sheet '${dataSheet}' in ${testDataRootDir}`);
    }

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    let lockfile: any;
    try {
      lockfile = require('proper-lockfile');
    } catch {
      throw new Error('WRITE_DATA: proper-lockfile is not installed — run: npm install proper-lockfile');
    }

    let release: (() => Promise<void>) | null = null;
    try {
      release = await lockfile.lock(csvFile, {
        retries: { retries: 5, minTimeout: 100, maxTimeout: 2000 },
        stale: 10000,
      });

      // Re-read inside the lock so concurrent writers don't clobber each other
      const fileContent = fs.readFileSync(csvFile, 'utf-8');
      const lines = fileContent.split(/\r?\n/);
      if (lines.length < 2) {
        throw new Error(`WRITE_DATA: CSV file '${csvFile}' is empty or missing header.`);
      }

      const headers = lines[0].split(',').map((header) => header.trim());
      const scenarioIdx = headers.findIndex((header) => header.toLowerCase() === 'scenario');
      const columnIdx = headers.findIndex((header) => header.toLowerCase() === columnName.toLowerCase());

      if (scenarioIdx === -1) {
        throw new Error(`WRITE_DATA: No 'scenario' column in '${csvFile}'.`);
      }

      if (columnIdx === -1) {
        throw new Error(`WRITE_DATA: No column '${columnName}' in '${csvFile}'.`);
      }

      let found = false;
      for (let i = 1; i < lines.length; i++) {
        if (!lines[i].trim()) {
          continue;
        }

        const row = lines[i].split(',');
        if ((row[scenarioIdx] || '').trim() !== scenarioName) {
          continue;
        }

        row[columnIdx] = valueToWrite;
        lines[i] = row.join(',');
        found = true;
        break;
      }

      if (!found) {
        throw new Error(`WRITE_DATA: Scenario '${scenarioName}' not found in '${csvFile}'.`);
      }

      fs.writeFileSync(csvFile, lines.join('\n'), 'utf-8');
      console.log(`WRITE_DATA: Updated [${dataSheet}] scenario='${scenarioName}' column='${columnName}' with value='${valueToWrite}'`);
    } finally {
      if (release) {
        try { await release(); } catch { /* ignore unlock errors */ }
      }
    }
  }

  /**
   * Identify the likely source of a variable based on its naming pattern
   */
  private identifyVariableSource(varName: string): string {
    if (varName.includes('.')) {
      // Namespaced config like "S360.apiBaseUrl" or "Application.setting"
      const namespace = varName.split('.')[0];
      return `Application config: Check your configuration for the '${namespace}' namespace (project-roots.json, playwright-settings.json, or environment setup)`;
    }
    
    if (varName.toLowerCase().startsWith('last_')) {
      // Output from previous test step
      return `Previous test step output: Ensure the earlier step that stores '${varName}' was executed and succeeded`;
    }
    
    if (['environment', 'baseurl', 'apikey', 'timeout', 'project'].includes(varName.toLowerCase())) {
      // Common runtime/environment keys
      return `Runtime/environment configuration: Check project-roots.json, playwright-settings.json, or environment variables for '${varName}'`;
    }
    
    // Default to CSV column
    return `CSV data column: Check your test data sheet has a '${varName}' column with values`;
  }

  /**
   * Interpolate variables in a string (e.g., "Hello ${name}")
   * Throws an error if a variable is missing (strict mode for URLs, paths, headers, etc.)
   */
  interpolate(text: string): string {
    if (!text) return text;

    // Resolve env/environment token first so composite placeholders like
    // ${scenario_${env}} or ${var_${environment}} become
    // ${scenario_QA}/${var_QA} before regular interpolation.
    if (text.includes('${env}') || text.includes('${environment}')) {
      const environmentValue = this.getValue('environment') ?? this.getValue('env');
      if (environmentValue === undefined) {
        throw new Error(
          `Missing parameterized data: variable(s) [env/environment] not found in DataContext.\n\n` +
          `Likely sources:\n  • env/environment: ${this.identifyVariableSource('environment')}\n` +
          `Ensure the required data is provided from the correct data source before this step runs.`
        );
      }
      text = text.replace(/\$\{(?:environment|env)\}/g, String(environmentValue));
    }

    const missingVars: string[] = [];
    
    // Supports:
    //   ${key}       -> resolved value
    //   $UP{key}     -> resolved value uppercased
    //   $LO{key}     -> resolved value lowercased
    //   $PHONE{key}  -> resolved value formatted as XXX-XXX-XXXX (requires exactly 10 digits)
    //   $FEIN{key}   -> resolved value formatted as XX-XXXXXXX (requires exactly 9 digits)
    const result = text.replace(
      /\$\{([^}]+)\}|\$UP\{([^}]+)\}|\$LO\{([^}]+)\}|\$PHONE\{([^}]+)\}|\$FEIN\{([^}]+)\}/g,
      (match, normalKey, upperKey, lowerKey, phoneKey, feinKey) => {
        const key = (normalKey ?? upperKey ?? lowerKey ?? phoneKey ?? feinKey ?? '').trim();
        const value = this.getValue(key);

        if (value !== undefined) {
          const strValue = String(value);
          if (upperKey !== undefined) return strValue.toUpperCase();
          if (lowerKey !== undefined) return strValue.toLowerCase();

          if (phoneKey !== undefined) {
            const digits = strValue.replace(/\D/g, '');
            if (digits.length !== 10) {
              throw new Error(
                `$PHONE{${key}} requires a 10-digit value to format as XXX-XXX-XXXX. Received '${strValue}' (${digits.length} digit(s)).`
              );
            }
            return `${digits.slice(0, 3)}-${digits.slice(3, 6)}-${digits.slice(6)}`;
          }

          if (feinKey !== undefined) {
            const digits = strValue.replace(/\D/g, '');
            if (digits.length !== 9) {
              throw new Error(
                `$FEIN{${key}} requires a 9-digit value to format as XX-XXXXXXX. Received '${strValue}' (${digits.length} digit(s)).`
              );
            }
            return `${digits.slice(0, 2)}-${digits.slice(2)}`;
          }

          return strValue;
        }

        // Collect missing variables to report
        if (key && !missingVars.includes(key)) {
          missingVars.push(key);
        }
        return match;  // Keep placeholder if missing
      }
    );

    // Throw error if any variables are missing
    if (missingVars.length > 0) {
      const sourceDetails = missingVars
        .map((varName) => `  • ${varName}: ${this.identifyVariableSource(varName)}`)
        .join('\n');
      
      throw new Error(
        `Missing parameterized data: variable(s) [${missingVars.join(', ')}] not found in DataContext.\n\n` +
        `Likely sources:\n${sourceDetails}\n` +
        `Ensure the required data is provided from the correct data source before this step runs.`
      );
    }

    return result;
  }

  /**
   * Interpolate variables in a payload (JSON) with smart defaults
   * If a variable is missing:
   *   - Boolean fields (starting with "is") default to false
   *   - All other fields default to null
   */
  interpolatePayload(text: string): string {
    if (!text) return text;

    return text.replace(/\$\{([^}]+)\}/g, (match, key, offset, source) => {
      const value = this.getValue(key);
      const isQuotedPlaceholder = source[offset - 1] === '"' && source[offset + match.length] === '"';

      if (value !== undefined && value !== null) {
        const stringValue = String(value);
        if (stringValue !== '') {
          return stringValue;
        }

        if (isQuotedPlaceholder) {
          return '';
        }
      }
      
      // Variable not found in payload - use smart default
      if (isQuotedPlaceholder) {
        return '';
      }

      if (key.toLowerCase().startsWith('is')) {
        return 'false';  // Boolean fields default to false
      }
      
      return 'null';  // Other fields default to null
    });
  }

  /**
   * Clear all context data
   */
  clear(): void {
    this.data.clear();
  }

  /**
   * Get all stored values
   */
  getAllValues(): Record<string, any> {
    const result: Record<string, any> = {};
    this.data.forEach((value, key) => {
      result[key] = value;
    });
    return result;
  }
}

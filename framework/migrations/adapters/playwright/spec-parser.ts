/**
 * Playwright spec parser - converts recorded spec files to migration model
 * 
 * STRICT Format Note (May 2026+):
 * TestActions generated here are transformed to STRICT column contracts
 * at CSV output time (see CSVScriptEmitter.transformToStrict).
 * Transformations include:
 * - Moving dynamic params from Data to Condition
 * - Moving timeout from Condition to Data
 * - No fallback logic - strict enforcement of column contracts
 */

import * as fs from 'fs';
import * as path from 'path';
import { MigrationModel, PageClass, PageObject, TestAction, TestScript } from '../../core/types';
import { PageObjectEmitter } from '../../emitters/page-object-emitter';

type SpecParserOptions = {
  scriptName?: string;
  pageOutputDir?: string;
  verbose?: boolean;
};

export class PlaywrightSpecParser {
  private static normalizeExplicitPageName(raw: string): string {
    const trimmed = String(raw || '').trim();
    if (!trimmed) {
      return 'Page';
    }

    const compact = trimmed.replace(/[^a-zA-Z0-9]+/g, '');
    if (compact && /^[A-Z][A-Za-z0-9]*$/.test(compact)) {
      return compact.endsWith('Page') ? compact : `${compact}Page`;
    }

    return this.toPageClassName(trimmed, 'Page');
  }

  /** Lines like `//--**` / `//-- Section` — preserved in generated page classes */
  private static isSectionBannerLine(trimmedLine: string): boolean {
    return /^\/\/--/.test(trimmedLine);
  }

  /** Whether this action should consume a pending `//--…` banner (locator-backed, not page root). */
  private static actionIntroducesPageObject(action: TestAction): boolean {
    if (!action.object || action.object === 'page' || action.object === 'NA') {
      return false;
    }
    if (action.action === 'WAIT_FOR_SELECTOR') {
      return false;
    }
    return true;
  }

  /**
   * Parse a recorded Playwright spec file and extract test actions and page objects
   */
  static parseSpecFile(
    filePath: string,
    projectName: string = 's360',
    options: SpecParserOptions = {}
  ): MigrationModel {
    const content = fs.readFileSync(filePath, 'utf-8');
    const inferredScriptName = path
      .basename(filePath, '.ts')
      .replace('record-test', 'tc_recorded')
      .replace(/\.spec$/i, '');
    const scriptName = (options.scriptName || '').trim() || inferredScriptName;
    const pageOutputDir =
      options.pageOutputDir || path.join('projects', projectName, 'pages_old');

    const verbose = options.verbose === true;
    const actions = this.extractActions(content, verbose);
    const pages = this.extractPages(actions, pageOutputDir);

    const testScript: TestScript = {
      name: scriptName,
      description: `Generated from ${path.basename(filePath)}`,
      actions,
    };

    const model: MigrationModel = {
      projectName,
      scriptName,
      pages,
      testScript,
    };

    return model;
  }

  /**
   * Extract test actions from Playwright spec code
   * Uses regex to find all await statements directly, ignoring line boundaries
   */
  private static extractActions(content: string, verbose: boolean = false): TestAction[] {
    const actions: TestAction[] = [];

    const lines = content.split('\n');
    const statements = lines
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    const lineNumbers = new Map<string, number>();
    lines.forEach((line, idx) => {
      const trimmed = line.trim();
      if (trimmed && !lineNumbers.has(trimmed)) {
        lineNumbers.set(trimmed, idx + 1);
      }
    });

    // Tracks popup flows: const popupPromise = page.waitForEvent('popup');
    const popupPromises = new Map<string, string>();
    // Tracks which popup promise statements should be skipped (consolidated into CLICK_TO_SWITCH)
    const statementsToSkip = new Set<string>();
    // Tracks variable aliases to inferred page classes: page -> LoginPage, page1 -> TransactionPopupPage
    const pageAliases = new Map<string, string>([['page', 'Page']]);
    let currentMainPage = 'Page';
    let explicitPageOverride: string | null = null;
    // Tracks which page+object combos have already been printed (for verbose [page] line)
    const seenPageObjects = new Set<string>();
    // Tracks frame aliases per page for verbose logging so output mirrors generated page classes.
    const frameAliasesByPage = new Map<string, Map<string, string>>();
    const usedFrameAliasesByPage = new Map<string, Set<string>>();
    /** Consecutive `//--…` lines from the spec; applied to the next action that introduces a page object */
    const pendingSectionLines: string[] = [];

    // First pass: identify popup patterns to consolidate
    for (let idx = 0; idx < statements.length; idx++) {
      const stmt = statements[idx];
      const popupPromiseMatch = stmt.match(/const\s+(\w+)\s*=\s*(\w+)\.waitForEvent\(['"]popup['"]\)/);
      if (popupPromiseMatch) {
        const [, promiseVar] = popupPromiseMatch;
        // Look ahead for click followed by alias assignment
        for (let nextIdx = idx + 1; nextIdx < Math.min(idx + 3, statements.length); nextIdx++) {
          const nextStmt = statements[nextIdx];
          if (nextStmt.includes('.click()') || nextStmt.includes('.click({')) {
            // Found a click after popup promise, check for alias assignment
            for (let aliasIdx = nextIdx + 1; aliasIdx < Math.min(nextIdx + 3, statements.length); aliasIdx++) {
              const aliasStmt = statements[aliasIdx];
              const aliasMatch = aliasStmt.match(/const\s+(\w+)\s*=\s*await\s+(\w+)/);
              if (aliasMatch && aliasMatch[2] === promiseVar) {
                // Complete pattern found! Mark for consolidation
                statementsToSkip.add(stmt); // Skip waitForEvent line
                statementsToSkip.add(aliasStmt); // Skip await promise line
                break;
              }
            }
            break;
          }
        }
      }
    }

    for (let idx = 0; idx < statements.length; idx++) {
      const rawStatement = statements[idx];
      
      // Skip consolidated popup pattern lines
      if (statementsToSkip.has(rawStatement)) {
        continue;
      }

      const lineNum = lineNumbers.get(rawStatement) ?? 0;

      if (verbose) {
        console.log(`[parse] line ${String(lineNum).padStart(3, ' ')}: ${rawStatement}`);
      }

      const explicitPageMatch = rawStatement.match(/^\/\/#\s*(.+?)\s*$/);
      if (explicitPageMatch?.[1]) {
        explicitPageOverride = this.normalizeExplicitPageName(explicitPageMatch[1]);
        continue;
      }

      if (this.isSectionBannerLine(rawStatement)) {
        pendingSectionLines.push(rawStatement);
        continue;
      }

      if (rawStatement.startsWith('//')) {
        continue;
      }

      // Capture popup promise declarations (no await in this statement)
      const popupPromiseMatch = rawStatement.match(/const\s+(\w+)\s*=\s*(\w+)\.waitForEvent\(['"]popup['"]\)/);
      if (popupPromiseMatch) {
        const [, promiseVar, sourcePageVar] = popupPromiseMatch;
        popupPromises.set(promiseVar, sourcePageVar);
        continue;
      }

      // Capture popup page alias assignment: const page1 = await page1Promise;
      const popupAliasMatch = rawStatement.match(/const\s+(\w+)\s*=\s*await\s+(\w+)\s*;?/);
      if (popupAliasMatch) {
        const [, aliasVar, promiseVar] = popupAliasMatch;
        if (popupPromises.has(promiseVar)) {
          const sourcePageVar = popupPromises.get(promiseVar)!;
          const sourcePage = pageAliases.get(sourcePageVar) || currentMainPage;
          pageAliases.set(aliasVar, this.toPageClassName(`${sourcePage}Popup`, 'Page'));
        }
        continue;
      }

      if (!rawStatement.includes('await ')) {
        continue;
      }

      // Normalize to a parser-friendly statement starting with await
      const awaitIndex = rawStatement.indexOf('await ');
      const statement = rawStatement.slice(awaitIndex).replace(/;$/, '');

      const action = this.parseAction(statement);
      if (!action) {
        continue;
      }

      if (pendingSectionLines.length > 0 && this.actionIntroducesPageObject(action)) {
        action.sectionBanner = pendingSectionLines.join('\n');
        pendingSectionLines.length = 0;
      }

      // Check if this CLICK is part of a consolidated popup pattern
      if (action.action === 'CLICK') {
        // Look back for waitForEvent popup and ahead for alias assignment
        for (let lookBack = idx - 1; lookBack >= Math.max(0, idx - 2); lookBack--) {
          const prevStmt = statements[lookBack];
          const popupMatch = prevStmt.match(/const\s+(\w+)\s*=\s*(\w+)\.waitForEvent\(['"]popup['"]\)/);
          if (popupMatch) {
            const [, promiseVar] = popupMatch;
            // Found popup promise, now look ahead for alias
            for (let lookAhead = idx + 1; lookAhead < Math.min(idx + 2, statements.length); lookAhead++) {
              const nextStmt = statements[lookAhead];
              const aliasMatch = nextStmt.match(/const\s+(\w+)\s*=\s*await\s+(\w+)/);
              if (aliasMatch && aliasMatch[2] === promiseVar) {
                // Complete popup pattern found!
                action.action = 'CLICK_TO_SWITCH';
                if (verbose) {
                  console.log(`[consolidate] Converting CLICK → CLICK_TO_SWITCH (popup context switch pattern)`);
                }
                break;
              }
            }
            break;
          }
        }
      }

      const pageVarMatch = rawStatement.match(/await\s+(\w+)\./);
      const pageVar = pageVarMatch?.[1] || 'page';

      if (explicitPageOverride) {
        action.page = explicitPageOverride;

        if (pageVar === 'page') {
          currentMainPage = explicitPageOverride;
        }
        pageAliases.set(pageVar, explicitPageOverride);
      } else if (action.action === 'GOTO' && action.data) {
        const inferredPage = this.inferPageNameFromUrl(action.data);
        action.page = inferredPage;

        if (pageVar === 'page') {
          currentMainPage = inferredPage;
        }
        pageAliases.set(pageVar, inferredPage);
      } else {
        const framePage = this.inferFramePageFromStatement(rawStatement);
        if (framePage) {
          action.page = framePage;
        } else if (pageVar === 'page') {
          action.page = currentMainPage;
        } else {
          action.page = pageAliases.get(pageVar) || this.toPageClassName(pageVar, 'Page');
        }
      }

      if (verbose) {
        const pageLabel = action.page || '?';
        const objectLabel = action.object || '?';
        const key = `${pageLabel}::${objectLabel}`;
        if (objectLabel !== 'page'
          && objectLabel !== 'NA'
          && action.action !== 'WAIT_FOR_SELECTOR'
          && !seenPageObjects.has(key)) {
          seenPageObjects.add(key);
          const descriptor = action.description || objectLabel;
          const frameAliases = frameAliasesByPage.get(pageLabel) || new Map<string, string>();
          const usedAliases = usedFrameAliasesByPage.get(pageLabel) || new Set<string>();

          const frameMatch = descriptor.match(/^frame=(.*?)>>/);
          if (frameMatch?.[1]) {
            PageObjectEmitter.ensureFrameAlias(frameMatch[1], frameAliases, usedAliases);
          }

          frameAliasesByPage.set(pageLabel, frameAliases);
          usedFrameAliasesByPage.set(pageLabel, usedAliases);

          const locatorExpr = PageObjectEmitter.buildLocatorExpression(descriptor, frameAliases);
          console.log(`[page]  ${pageLabel} - ${objectLabel} = ${locatorExpr};`);
        }
        console.log(`[action] → action=${action.action} page=${pageLabel} object=${objectLabel} data=${action.data || ''}`);
        console.log('================================================================================');
      }

      actions.push(action);
    }

    return actions;
  }

  /**
   * Infer page class name from URL (query param `page` preferred, then path segment)
   */
  private static inferPageNameFromUrl(url: string): string {
    try {
      const parsed = new URL(url);
      const pageParam = parsed.searchParams.get('page');
      const pathSegment = parsed.pathname.split('/').filter(Boolean).pop() || '';
      const hostToken = parsed.hostname.split('.')[0] || 'page';

      const candidate = (pageParam || pathSegment || hostToken).replace(/\.[a-z0-9]+$/i, '');
      return this.toPageClassName(candidate, 'Page');
    } catch {
      // Fallback for partial/invalid URLs
      const safe = url.split('?')[0].split('/').filter(Boolean).pop() || 'page';
      return this.toPageClassName(safe, 'Page');
    }
  }

  /**
   * Infer frame-based page class from contentFrame locators
   */
  private static inferFramePageFromStatement(statement: string): string | null {
    const frameMatch = statement.match(/\.locator\(['"]#([^'"]+?)\s+iframe['"]\)\.contentFrame\(\)/i);
    if (!frameMatch) {
      return null;
    }

    const rawFrameId = frameMatch[1]
      .replace(/^panel-body\d+-/i, '')
      .replace(/^panel/i, '')
      .replace(/iframe$/i, '');

    return this.toPageClassName(rawFrameId || 'frame', 'FramePage');
  }

  /**
   * Convert arbitrary token to PascalCase page class name with suffix
   */
  private static toPageClassName(raw: string, suffix: string): string {
    const base = raw
      .replace(/[^a-zA-Z0-9]+/g, ' ')
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
      .join('');

    const normalized = base || 'Page';
    if (normalized.endsWith(suffix)) {
      return normalized;
    }
    if (normalized === 'Page' && suffix === 'Page') {
      return 'Page';
    }
    return `${normalized}${suffix}`;
  }

  /**
   * Parse a single line/statement into a TestAction
   */
  private static parseAction(statement: string): TestAction | null {
    // GOTO: await page.goto('...')
    const gotoMatch = statement.match(/await\s+(?:page\d*)\.goto\(['"]([^'"]+)['"]\)/);
    if (gotoMatch) {
      return {
        action: 'GOTO',
        page: 'page',
        object: 'page',
        data: gotoMatch[1],
      };
    }

    // GO_BACK: await page.goBack()
    const goBackMatch = statement.match(/await\s+(?:page\d*)\.goBack\(\)/);
    if (goBackMatch) {
      return {
        action: 'GO_BACK',
        page: 'page',
        object: 'page',
        data: '',
      };
    }

    // WAIT_FOR_LOAD_STATE: await page.waitForLoadState('domcontentloaded', { timeout: 5000 })
    const waitForLoadStateMatch = statement.match(
      /await\s+\w+\.waitForLoadState\(\s*(?:['"]([^'"]+)['"])?\s*(?:,\s*\{[^}]*timeout\s*:\s*(\d+)[^}]*\})?\s*\)/
    );
    if (waitForLoadStateMatch) {
      const [, stateRaw, timeoutRaw] = waitForLoadStateMatch;
      const state = (stateRaw || 'load').trim();
      return {
        action: 'WAIT_FOR_LOAD_STATE',
        page: 'page',
        object: 'NA',
        condition: state,
        data: timeoutRaw || '',
      };
    }

    // WAIT_TIME: await page.waitForTimeout(2000)
    const waitForTimeoutMatch = statement.match(/await\s+\w+\.waitForTimeout\(\s*(\d+)\s*\)/);
    if (waitForTimeoutMatch) {
      return {
        action: 'WAIT_TIME',
        page: 'page',
        object: 'page',
        condition: '',
        data: waitForTimeoutMatch[1],
      };
    }

    // WAIT_FOR_SELECTOR: await page.waitForSelector('.modal', { state: 'hidden', timeout: 15000 })
    const waitForSelectorMatch = statement.match(
      /await\s+\w+\.waitForSelector\(\s*(['"])(.*?)\1\s*(?:,\s*\{([^}]*)\})?\s*\)/
    );
    if (waitForSelectorMatch) {
      const [, , selector, optionsRaw = ''] = waitForSelectorMatch;
      const stateMatch = optionsRaw.match(/state\s*:\s*['"]([^'"]+)['"]/i);
      const timeoutMatch = optionsRaw.match(/timeout\s*:\s*(\d+)/i);

      const state = (stateMatch?.[1] || 'visible').trim().toLowerCase();

      return {
        action: 'WAIT_FOR_SELECTOR',
        page: 'page',
        object: selector,
        condition: state,
        data: timeoutMatch?.[1] || '',
        description: '',
      };
    }

    // ASSERT_TEXT: await expect(...).toContainText('...')
    const assertTextMatch = statement.match(/await\s+expect\(.*?\)\.toContainText\(['"]([^'"]+)['"]\)/);
    if (assertTextMatch) {
      const locatorInAssertMatch = statement.match(/expect\(\s*[^.]+\.locator\((['"])(.*?)\1\)\s*\)\.toContainText\(/);
      const selector = locatorInAssertMatch?.[2] || '';
      return {
        action: 'ASSERT_TEXT',
        page: 'page',
        object: selector ? this.selectorToObjectName(selector) : 'page',
        condition: 'contains',
        data: assertTextMatch[1],
        description: selector || `Assert text contains: ${assertTextMatch[1]}`,
      };
    }

    // ASSERT state for getByRole in expect(...)
    // Example: await expect(page.getByRole('button', { name: 'X' }).nth(1)).toBeVisible({ timeout: 15000 })
    // Supported: toBeVisible, toBeHidden, toBeEnabled, toBeDisabled, toBeAttached, not.toBeAttached
    const assertRoleStateMatch = statement.match(
      /await\s+expect\(.*?\.getByRole\(['"](\w+)['"],\s*\{\s*name:\s*['"]([^'"]+)['"](?:,\s*exact:\s*(?:true|false))?\s*\}\)(?:\.nth\((\d+)\))?\)\.(not\.)?(toBeVisible|toBeHidden|toBeEnabled|toBeDisabled|toBeAttached)\(\s*(?:\{[^}]*timeout\s*:\s*(\d+)[^}]*\})?\s*\)/
    );
    if (assertRoleStateMatch) {
      const [, role, name, nthIndex, negationToken, assertMethod] = assertRoleStateMatch;
      const frameSelector = this.extractFrameSelector(statement);
      const roleSelector = `role=${role}[name="${name.replace(/"/g, '\\"')}"]`;
      const selectorWithNth = nthIndex ? `${roleSelector}|nth=${nthIndex}` : roleSelector;
      return {
        action: 'ASSERT',
        page: 'page',
        object: this.roleBasedObjectName(role, name),
        condition: this.toAssertCondition(assertMethod, !!negationToken),
        data: '',
        description: frameSelector ? `frame=${frameSelector}>>${selectorWithNth}` : selectorWithNth,
      };
    }

    // ASSERT state for getByText in expect(...)
    const assertTextStateMatch = statement.match(
      /await\s+expect\(.*?\.getByText\(['"]([^'"]+)['"](?:,\s*\{[^}]*\})?\)(?:\.nth\((\d+)\))?\)\.(not\.)?(toBeVisible|toBeHidden|toBeEnabled|toBeDisabled|toBeAttached)\(\s*(?:\{[^}]*timeout\s*:\s*(\d+)[^}]*\})?\s*\)/
    );
    if (assertTextStateMatch) {
      const [, text, nthIndex, negationToken, assertMethod] = assertTextStateMatch;
      const frameSelector = this.extractFrameSelector(statement);
      const textSelector = `text=${text.replace(/"/g, '\\"')}`;
      const selectorWithNth = nthIndex ? `${textSelector}|nth=${nthIndex}` : textSelector;
      return {
        action: 'ASSERT',
        page: 'page',
        object: this.textBasedObjectName(text),
        condition: this.toAssertCondition(assertMethod, !!negationToken),
        data: '',
        description: frameSelector ? `frame=${frameSelector}>>${selectorWithNth}` : selectorWithNth,
      };
    }

    // ASSERT state for locator in expect(...)
    const assertLocatorStateMatch = statement.match(
      /await\s+expect\(.*?\.locator\((['"])(.*?)\1\)(?:\.first\(\)|\.nth\((\d+)\))?\)\.(not\.)?(toBeVisible|toBeHidden|toBeEnabled|toBeDisabled|toBeAttached)\(\s*(?:\{[^}]*timeout\s*:\s*(\d+)[^}]*\})?\s*\)/
    );
    if (assertLocatorStateMatch) {
      const [, , selector, nthIndex, negationToken, assertMethod] = assertLocatorStateMatch;
      const selectorWithNth = nthIndex ? `${selector}|nth=${nthIndex}` : selector;
      return {
        action: 'ASSERT',
        page: 'page',
        object: this.selectorToObjectName(selector),
        condition: this.toAssertCondition(assertMethod, !!negationToken),
        data: '',
        description: selectorWithNth,
      };
    }

    // Handle getByRole patterns
    // Pattern: page.getByRole('button', { name: 'Login' }).click()
    let match = statement.match(/\.getByRole\(['"](\w+)['"],\s*\{\s*name:\s*['"]([^'"]+)['"](?:,\s*exact:\s*(?:true|false))?\s*\}\)(?:\.nth\((\d+)\))?\.(click|fill|press)\(([^)]*)\)/);
    if (match) {
      const [, role, name, nthIndex, action, args] = match;
      const actionValue = this.extractStringArg(args);
      const frameSelector = this.extractFrameSelector(statement);
      const roleSelector = `role=${role}[name="${name.replace(/"/g, '\\"')}"]`;
      const selectorWithNth = nthIndex ? `${roleSelector}|nth=${nthIndex}` : roleSelector;
      return {
        action: action === 'click' ? 'CLICK' : action === 'fill' ? 'FILL' : 'PRESS',
        page: 'page',
        object: this.roleBasedObjectName(role, name),
        data: action === 'click' ? '' : actionValue,
        description: frameSelector ? `frame=${frameSelector}>>${selectorWithNth}` : selectorWithNth,
      };
    }

    // Handle getByText patterns
    match = statement.match(/\.getByText\(['"]([^'"]+)['"](?:,\s*\{[^}]*\})?\)(?:\.nth\((\d+)\))?\.(click|fill|press)\(([^)]*)\)/);
    if (match) {
      const [, text, nthIndex, action, args] = match;
      const actionValue = this.extractStringArg(args);
      const frameSelector = this.extractFrameSelector(statement);
      const textSelector = `text=${text.replace(/"/g, '\\"')}`;
      const selectorWithNth = nthIndex ? `${textSelector}|nth=${nthIndex}` : textSelector;
      return {
        action: action === 'click' ? 'CLICK' : action === 'fill' ? 'FILL' : 'PRESS',
        page: 'page',
        object: this.textBasedObjectName(text),
        data: action === 'click' ? '' : actionValue,
        description: frameSelector ? `frame=${frameSelector}>>${selectorWithNth}` : selectorWithNth,
      };
    }

    // Handle generic locator patterns
    // Pattern: page.locator('.selector').click() / fill('x') / press('Enter')
    match = statement.match(/\.locator\((['"])(.*?)\1\)(?:\.first\(\)|\.nth\((\d+)\))?\.(click|fill|press)\(([^)]*)\)/);
    if (match && statement.includes('await')) {
      const [, , selector, nthIndex, action, args] = match;
      const actionValue = this.extractStringArg(args);
      const selectorWithNth = nthIndex ? `${selector}|nth=${nthIndex}` : selector;
      return {
        action: action === 'click' ? 'CLICK' : action === 'fill' ? 'FILL' : 'PRESS',
        page: 'page',
        object: this.selectorToObjectName(selector),
        data: action === 'click' ? '' : actionValue,
        description: selectorWithNth,
      };
    }

    return null;
  }

  private static extractStringArg(args: string): string {
    const match = args.match(/['"]([^'"]*)['"]/);
    return match ? match[1] : '';
  }

  private static toAssertCondition(assertMethod: string, negated: boolean): string {
    switch (assertMethod) {
      case 'toBeVisible':
        return negated ? 'is not visible' : 'is visible';
      case 'toBeHidden':
        return negated ? 'is visible' : 'is hidden';
      case 'toBeEnabled':
        return negated ? 'is disabled' : 'is enabled';
      case 'toBeDisabled':
        return negated ? 'is enabled' : 'is disabled';
      case 'toBeAttached':
        return negated ? 'is not present' : 'is present';
      default:
        return negated ? 'is not present' : 'is present';
    }
  }

  private static extractFrameSelector(statement: string): string | null {
    const match = statement.match(/\.locator\((['"])([^'"]*iframe[^'"]*)\1\)\.contentFrame\(\)/i);
    return match ? match[2] : null;
  }

  private static toPascalFromPhrase(phrase: string): string {
    const parts = phrase.replace(/[^a-zA-Z0-9]+/g, ' ').trim().split(/\s+/).filter(Boolean);
    if (parts.length === 0) {
      return 'Item';
    }
    return parts.map((p) => p.charAt(0).toUpperCase() + p.slice(1).toLowerCase()).join('');
  }

  /** getByRole: `{role}{NameInPascal}` — avoids `linkFooLink` style doubling */
  private static roleBasedObjectName(role: string, accessibleName: string): string {
    const r = String(role || 'element').toLowerCase();
    return r + this.toPascalFromPhrase(accessibleName);
  }

  /** getByText: `text` + Pascal fragment */
  private static textBasedObjectName(text: string, maxLen = 48): string {
    const slice = String(text || '').slice(0, maxLen).trim();
    return 'text' + this.toPascalFromPhrase(slice);
  }

  /**
   * Flatten multi-line method chains into single lines
   * Preserves statement boundaries (semicolons)
   */
  private static flattenMultilineStatements(content: string): string {
    let result = '';
    let buffer = '';
    let parenDepth = 0;
    let braceDepth = 0;
    let bracketDepth = 0;

    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      
      // Skip empty lines and comments
      if (!trimmed || trimmed.startsWith('//')) {
        continue;
      }

      // Update depth trackers
      for (const char of trimmed) {
        if (char === '(') parenDepth++;
        if (char === ')') parenDepth--;
        if (char === '{') braceDepth++;
        if (char === '}') braceDepth--;
        if (char === '[') bracketDepth++;
        if (char === ']') bracketDepth--;
      }

      buffer += trimmed + ' ';

      // If line ends with semicolon and all parens/braces are closed, we have a complete statement
      if (trimmed.endsWith(';') && parenDepth === 0 && braceDepth === 0 && bracketDepth === 0) {
        result += buffer.trim() + '\n';
        buffer = '';
      }
      // If we're at closing brace of function/block, flush buffer
      else if (trimmed === '});' || trimmed === '}') {
        if (buffer.trim()) {
          result += buffer.trim() + '\n';
        }
        result += trimmed + '\n';
        buffer = '';
      }
    }

    if (buffer.trim()) {
      result += buffer.trim() + '\n';
    }

    return result;
  }

  /**
   * Parse locator string and extract selector and page name
   * e.g., "page.locator('[data-test=\"username\"]')" -> selector
   */
  private static parseLocatorString(locatorStr: string): { selector: string; page: string; objectName: string; description: string } | null {
    // Remove quotes and normalize
    const selector = locatorStr
      .replace(/^['"]|['"]$/g, '')
      .replace(/\\'/g, "'")
      .replace(/\\"/g, '"');

    // Generate object name from selector
    const objectName = this.selectorToObjectName(selector);

    return {
      selector,
      page: 'page', // will be inferred later by checking page class memberships
      objectName,
      description: selector,
    };
  }

  /**
   * Convert selector to a camelCase object name
   * e.g., '[data-test="username"]' -> 'inputUsername'
   * e.g., '.btn-primary' -> 'buttonPrimary'
   */
  private static selectorToObjectName(selector: string): string {
    let name = '';

    // Extract from id first (highest specificity for CSS selectors)
    const idMatch = selector.match(/#([a-zA-Z][a-zA-Z0-9_-]*)/);
    if (idMatch) {
      name = idMatch[1];
    }

    // Extract from data-test attribute
    const dataTestMatch = selector.match(/data-test=['"]([^'"]+)['"]/);
    if (dataTestMatch) {
      name = dataTestMatch[1];
    }

    // Extract from placeholder
    if (!name) {
      const placeholderMatch = selector.match(/placeholder=['"]([^'"]+)['"]/);
      if (placeholderMatch) {
        name = placeholderMatch[1];
      }
    }

    // Extract from name attribute
    if (!name) {
      const nameMatch = selector.match(/name=['"]([^'"]+)['"]/);
      if (nameMatch) {
        name = nameMatch[1];
      }
    }

    // Extract from class names
    if (!name) {
      const classMatch = selector.match(/\.([a-z][a-z0-9-]*)/i);
      if (classMatch) {
        name = classMatch[1];
      }
    }

    // Extract from tag + attribute
    if (!name) {
      const tagMatch = selector.match(/(\w+)\[/);
      if (tagMatch) {
        name = tagMatch[1];
      }
    }

    // Fallback to selector hash
    if (!name) {
      name = 'element_' + Math.abs(selector.split('').reduce((a, b) => ((a << 5) - a) + b.charCodeAt(0), 0)).toString(36).slice(0, 8);
    }

    return this.toObjectName(name);
  }

  /**
   * Normalize a token to a camelCase object name; element kind is a **prefix** only (`inputX` / `buttonX` / `linkX`),
   * never a suffix, so names are not doubled (e.g. `linkFooLink`).
   */
  private static toObjectName(rawName: string): string {
    const normalized = rawName.replace(/[^a-zA-Z0-9]+/g, ' ').trim();
    if (!normalized) {
      return 'element';
    }

    const camelCase = normalized
      .toLowerCase()
      .split(/\s+/)
      .filter(Boolean)
      .map((word, idx) => (idx === 0 ? word : word.charAt(0).toUpperCase() + word.slice(1)))
      .join('');

    let safeBase = /^[a-zA-Z_]/.test(camelCase)
      ? camelCase
      : `element${camelCase.charAt(0).toUpperCase()}${camelCase.slice(1)}`;

    for (let i = 0; i < 4; i++) {
      const next = safeBase.replace(/(Button|Link|Input)$/i, '');
      if (!next || next === safeBase) {
        break;
      }
      safeBase = next;
    }

    const lower = safeBase.toLowerCase();
    if (/^(button|link|text|input|combobox|menuitem)\w*/i.test(safeBase)) {
      return safeBase;
    }

    const pascalRest = (s: string): string => {
      if (!s) {
        return 'Item';
      }
      return s.charAt(0).toUpperCase() + s.slice(1);
    };

    const wantsInput =
      lower.includes('password') ||
      lower.includes('username') ||
      lower.includes('email') ||
      (lower.includes('user') && (lower.includes('name') || lower.endsWith('id')));

    if (wantsInput) {
      return 'input' + pascalRest(safeBase);
    }
    if (lower.includes('btn') || lower.includes('button')) {
      return 'button' + pascalRest(safeBase);
    }
    if (lower.includes('link') || lower.includes('href')) {
      return 'link' + pascalRest(safeBase);
    }

    return safeBase;
  }

  /**
   * Extract unique page classes from actions
   * Groups objects by their likely page (can be inferred by user or guessed)
   * FIX: Creates default 'Page' class for actions with page === 'page' instead of skipping them
   */
  private static extractPages(actions: TestAction[], pageOutputDir: string): Map<string, PageClass> {
    const pages = new Map<string, PageClass>();

    // Collect objects by page, defaulting to 'Page' for all 'page' references
    const objectsByPage = new Map<string, Set<string>>();
    const objectDetails = new Map<string, PageObject>();

    for (const action of actions) {
      if (action.action === 'WAIT_FOR_SELECTOR') {
        continue;
      }

      // Skip actions without objects
      if (!action.object || action.object === 'page' || action.object === 'NA') {
        continue;
      }

      // Use 'Page' as default page class if action.page is 'page' or unset
      const pageName = (action.page && action.page !== 'page') ? action.page : 'Page';

      if (!objectsByPage.has(pageName)) {
        objectsByPage.set(pageName, new Set());
      }

      objectsByPage.get(pageName)!.add(action.object);

      // Store object with selector from action description or generate default.
      // If an object appears both inside and outside a frame, prefer the frame selector
      // so generated page classes keep the iframe chain.
      const nextSelector = action.description || `[data-test="${action.object}"]`;
      const existing = objectDetails.get(action.object);
      const existingUsesFrame = !!existing?.selector?.startsWith('frame=');
      const nextUsesFrame = nextSelector.startsWith('frame=');

      const mergedComment = existing?.leadingSectionComment || action.sectionBanner;

      if (!existing || (!existingUsesFrame && nextUsesFrame)) {
        objectDetails.set(action.object, {
          name: action.object,
          selector: nextSelector,
          description: action.description,
          leadingSectionComment: mergedComment,
        });
      } else if (existing && action.sectionBanner && !existing.leadingSectionComment) {
        objectDetails.set(action.object, {
          ...existing,
          leadingSectionComment: action.sectionBanner,
        });
      }
    }

    // Build page classes
    for (const [pageName, objectNames] of objectsByPage) {
      const pageClass: PageClass = {
        name: pageName,
        filePath: path.join(pageOutputDir, `${pageName}.ts`),
        objects: new Map(),
        methods: new Map(),
      };

      for (const objectName of objectNames) {
        const obj = objectDetails.get(objectName)!;
        pageClass.objects.set(objectName, obj);
      }

      pages.set(pageName, pageClass);
    }

    return pages;
  }
}

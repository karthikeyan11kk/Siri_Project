/**
 * CSV Test Runner - Main execution engine
 * Executes test steps from CSV files using test.step()
 */

import { APIResponse, Locator, Page, expect, test } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { CSVParser, TestStep } from './csv-parser';
import { DataContext } from './data-loader';
import { ActionMapper } from './action-mapper';
import { PageObjectFactoryMap } from '../references/schema_types';
import { takeCsvStepScreenshot, setActiveStepContext, setActiveScreenshotContext } from '../references/screenshot-util';


export type CSVRunnerOptions = {
  testsRootDir?: string;
  flowsRootDir?: string;
  testDataRootDir?: string;
  pageFactories?: PageObjectFactoryMap;
  runtimeValues?: Record<string, string>;
  stepScreenshot?: {
    mode?: 'off' | 'all-steps';
    fullPage?: boolean;
    highlight?: boolean;
  };
  timeouts?: {
    testTimeoutMs: number;
    expectTimeoutMs: number;
    actionTimeoutMs: number;
    navigationTimeoutMs: number;
  };
  breakpoint?: {
    mode?: 'off' | 'ui';
    pauseOnFailure?: boolean;
    runId?: string;
    controlFilePath?: string;
    pollIntervalMs?: number;
  };
};

type ConditionalBlock = {
  openerIndex: number;
  branchIndices: number[];
  elseIndex?: number;
  endIndex: number;
};

type ConditionalBlockDraft = Omit<ConditionalBlock, 'endIndex'> & { endIndex?: number };

type ConditionalStructure = {
  blockByControlIndex: Map<number, ConditionalBlock>;
};

type ConditionalExecutionFrame = {
  block: ConditionalBlock;
  branchTaken: boolean;
};

export class CSVTestRunner {
  private dataContext: DataContext;
  private actionMapper: ActionMapper;
  private readonly testsRootDir: string;
  private readonly flowsRootDir: string;
  private readonly testDataRootDir: string;
  private readonly runtimeValueMap: Record<string, string>;
  private flowExecutionStack: string[] = [];
  private apiHeaderOverrides: Record<string, string> = {};
  private mainPage: Page;
  private openedPages: Page[] = [];
  private currentPageIndex: number = 0;
  private currentTestFilePath: string = '';
  private currentTestName: string = '';
  private breakpointSerial: number = 0;
  private executionPauseActive: boolean = false;
  private scrollStyleInjected: boolean = false;
  private readonly breakpointConfig: {
    mode: 'off' | 'ui';
    pauseOnFailure: boolean;
    runId: string;
    controlFilePath: string;
    pollIntervalMs: number;
  };
  private resolvedTimeouts?: {
    testTimeoutMs: number;
    expectTimeoutMs: number;
    actionTimeoutMs: number;
    navigationTimeoutMs: number;
  };
  private readonly stepScreenshotConfig: {
    mode: 'off' | 'all-steps';
    fullPage: boolean;
    highlight: boolean;
  };

  private syncActivePage(activePage: Page): void {
    this.page = activePage;
    this.actionMapper.rebindPage(activePage);
    setActiveScreenshotContext(activePage, this.stepScreenshotConfig);
  }

  constructor(private page: Page, options: CSVRunnerOptions = {}) {
    this.dataContext = new DataContext();
    this.testsRootDir = options.testsRootDir ?? path.resolve(process.cwd(), 'test-scripts');
    this.flowsRootDir = options.flowsRootDir ?? path.resolve(process.cwd(), 'test-flows');
    this.testDataRootDir = options.testDataRootDir ?? path.resolve(process.cwd(), 'test-data');
    this.dataContext.setTestDataRootDir(this.testDataRootDir);
    this.runtimeValueMap = { ...(options.runtimeValues ?? {}) };
    this.actionMapper = new ActionMapper(page, options.pageFactories ?? {}, this.dataContext);
    this.resolvedTimeouts = options.timeouts;
    this.stepScreenshotConfig = {
      mode: options.stepScreenshot?.mode === 'all-steps' ? 'all-steps' : 'off',
      fullPage: options.stepScreenshot?.fullPage === true,
      highlight: options.stepScreenshot?.highlight !== false,
    };
    this.breakpointConfig = {
      mode: options.breakpoint?.mode === 'ui' ? 'ui' : 'off',
      pauseOnFailure: options.breakpoint?.pauseOnFailure === true,
      runId: String(options.breakpoint?.runId || '').trim(),
      controlFilePath: String(options.breakpoint?.controlFilePath || '').trim(),
      pollIntervalMs: Number(options.breakpoint?.pollIntervalMs) > 0 ? Number(options.breakpoint?.pollIntervalMs) : 400,
    };
    setActiveScreenshotContext(page, this.stepScreenshotConfig);

    // Track pages for popup/window switching
    this.mainPage = page;
    this.openedPages = [page];
    this.currentPageIndex = 0;

    this.applyRuntimeValues();
  }

  private isRawSelectorCandidate(value: string): boolean {
    const raw = (value || '').trim();
    if (!raw) {
      return false;
    }

    return (
      /^(#|\.|\[|\/\/|\(\/\/|xpath=|css=|text=|id=|role=)/i.test(raw) ||
      /[>~:+\[\]]/.test(raw) ||
      /\s/.test(raw)
    );
  }

  /**
   * Resolve locator for actions that use CSV Page/Object columns.
   * Page and Object are mandatory here.
   * - Object='page' => page root alias
   * - Selector-like Object => raw selector via page.locator(object)
   * - Otherwise => PageObject member lookup
   */
  private async resolveStepLocator(pageNameRaw: string, objectNameRaw: string, dataParams: string[] = []): Promise<Locator> {
    const pageName = (pageNameRaw || '').trim();
    const objectName = (objectNameRaw || '').trim();

    if (!pageName) {
      throw new Error('Page column is required for this action and cannot be empty.');
    }

    if (!objectName) {
      throw new Error('Object column is required for this action and cannot be empty.');
    }

    if (!this.actionMapper.pageExists(pageName)) {
      throw new Error(
        `Page object not found: ${pageName}. Check the Page column value and project pageFactories registration.`
      );
    }

    if (objectName === 'page') {
      return this.page.locator('body');
    }

    if (this.isRawSelectorCandidate(objectName)) {
      return this.page.locator(objectName);
    }

    const pageObject = this.actionMapper.getPageObject(pageName) as unknown as Record<string, unknown>;
    const member = pageObject[objectName];

    if (member === undefined) {
      throw new Error(`Member not found: ${pageName}.${objectName}`);
    }

    let resolved: unknown = member;
    if (typeof member === 'function') {
      const method = member as (this: unknown, ...args: string[]) => unknown;
      resolved = await method.apply(pageObject, dataParams);
    }

    if (resolved && typeof resolved === 'object' && 'click' in resolved && 'fill' in resolved) {
      return resolved as Locator;
    }

    if (typeof resolved === 'string') {
      return this.page.locator(resolved);
    }

    throw new Error(`Resolved member is not a locator: ${pageName}.${objectName}`);
  }

  private getStepTarget(step: TestStep): string {
    return [step.page, step.object].filter(Boolean).join('.');
  }

  private extractPlaceholderKeys(text: string): string[] {
    if (!text) {
      return [];
    }

    return [...text.matchAll(/\$\{([^}]+)\}/g)]
      .map((match) => String(match[1] ?? '').trim())
      .filter((key) => key !== '');
  }

  private shouldSkipStepForEmptyInterpolatedData(rawData: string, interpolatedData: string): {
    skip: boolean;
    emptyPlaceholderKeys: string[];
  } {
    const placeholderKeys = this.extractPlaceholderKeys(rawData);
    if (placeholderKeys.length === 0) {
      return { skip: false, emptyPlaceholderKeys: [] };
    }

    const emptyPlaceholderKeys = placeholderKeys.filter((key) => {
      const value = this.dataContext.getValue(key);
      return String(value ?? '').trim() === '';
    });

    if (emptyPlaceholderKeys.length === 0) {
      return { skip: false, emptyPlaceholderKeys: [] };
    }

    const dedupedEmptyKeys = emptyPlaceholderKeys.filter((k, i, arr) => arr.indexOf(k) === i);

    // Case 1: entire interpolated data resolves to empty (e.g. Data = "${Key}" → "")
    if ((interpolatedData || '').trim() === '') {
      return { skip: true, emptyPlaceholderKeys: dedupedEmptyKeys };
    }

    // Case 2: operator|value format where the value slot is a pure placeholder that resolved to empty.
    // e.g. rawData = "equals | ${Surcharge}" → interpolatedData = "equals | " → skip.
    // Only triggers when the segment after the last | in rawData is exactly one placeholder (${...}).
    if (rawData.includes('|')) {
      const rawValuePart = (rawData.split('|').pop() ?? '').trim();
      const interpolatedValuePart = (interpolatedData.split('|').pop() ?? '').trim();
      if (rawValuePart.startsWith('${') && rawValuePart.endsWith('}') && interpolatedValuePart === '') {
        return { skip: true, emptyPlaceholderKeys: dedupedEmptyKeys };
      }
    }

    return { skip: false, emptyPlaceholderKeys: [] };
  }

  private parseTimeoutFromCondition(condition: string): number | undefined {
    const raw = (condition || '').trim();
    if (!raw) {
      return undefined;
    }

    // Helper to convert timeout value to milliseconds
    // Supports: value in ms (default), value + 's' = seconds, value + 'ms' = explicit milliseconds
    const convertToMs = (value: string, unit: string): number => {
      const num = Number(value);
      if (!Number.isFinite(num) || num <= 0) {
        throw new Error(`Invalid timeout value '${raw}'. Timeout must be a positive number.`);
      }
      return unit.toLowerCase() === 's' ? num * 1000 : num;
    };

    // Format 1: Plain number or with unit suffix
    // Supports: 5000, 5000ms, 5s
    const plainMatch = raw.match(/^(\d+)(ms|s)?$/i);
    if (plainMatch) {
      const value = plainMatch[1];
      const unit = plainMatch[2] || 'ms'; // default to milliseconds if no unit specified
      return convertToMs(value, unit);
    }

    // Format 2: timeout=value with optional unit
    // Supports: timeout=5000, timeout=5000ms, timeout=5s, timeout:5s
    const timeoutMatch = raw.match(/timeout\s*[:=]\s*(\d+)(ms|s)?/i);
    if (timeoutMatch) {
      const value = timeoutMatch[1];
      const unit = timeoutMatch[2] || 'ms'; // default to milliseconds if no unit specified
      return convertToMs(value, unit);
    }

    return undefined;
  }

  private parseWaitStateFromCondition(condition: string): 'attached' | 'detached' | 'visible' | 'hidden' | undefined {
    const raw = (condition || '').trim();
    if (!raw) {
      return undefined;
    }

    const explicitState = raw.match(/(?:^|\||,|\s)state\s*[:=]\s*(attached|detached|visible|hidden)(?:$|\||,|\s)/i);
    if (explicitState?.[1]) {
      return explicitState[1].toLowerCase() as 'attached' | 'detached' | 'visible' | 'hidden';
    }

    // Backward-compatible fallback when only a bare state token is provided.
    const bareState = raw.match(/^(attached|detached|visible|hidden)$/i);
    if (bareState?.[1]) {
      return bareState[1].toLowerCase() as 'attached' | 'detached' | 'visible' | 'hidden';
    }

    return undefined;
  }

  private parseScreenshotOptions(options: string[]): {
    timeout?: number;
    maxDiffPixelRatio?: number;
    maxDiffPixels?: number;
    threshold?: number;
    fullPage?: boolean;
    animations?: 'disabled' | 'allow';
    caret?: 'hide' | 'initial';
    scale?: 'css' | 'device';
    maskSelectors?: string[];
  } {
    const screenshotOptions: {
      timeout?: number;
      maxDiffPixelRatio?: number;
      maxDiffPixels?: number;
      threshold?: number;
      fullPage?: boolean;
      animations?: 'disabled' | 'allow';
      caret?: 'hide' | 'initial';
      scale?: 'css' | 'device';
      maskSelectors?: string[];
    } = {};

    for (const option of options) {
      if (!option) {
        continue;
      }

      const timeoutMs = this.parseTimeoutFromCondition(option);
      if (timeoutMs !== undefined) {
        screenshotOptions.timeout = timeoutMs;
        continue;
      }

      if (/^\d*\.\d+$/.test(option)) {
        screenshotOptions.maxDiffPixelRatio = Number(option);
        continue;
      }

      if (/^\d+$/.test(option)) {
        screenshotOptions.maxDiffPixels = Number(option);
        continue;
      }

      const fullPageMatch = option.match(/^fullpage\s*[:=]\s*(true|false)$/i);
      if (fullPageMatch) {
        screenshotOptions.fullPage = fullPageMatch[1].toLowerCase() === 'true';
        continue;
      }

      const maxDiffPixelRatioMatch = option.match(/^maxdiffpixelratio\s*[:=]\s*(\d*\.?\d+)$/i);
      if (maxDiffPixelRatioMatch) {
        screenshotOptions.maxDiffPixelRatio = Number(maxDiffPixelRatioMatch[1]);
        continue;
      }

      const maxDiffPixelsMatch = option.match(/^maxdiffpixels\s*[:=]\s*(\d+)$/i);
      if (maxDiffPixelsMatch) {
        screenshotOptions.maxDiffPixels = Number(maxDiffPixelsMatch[1]);
        continue;
      }

      const thresholdMatch = option.match(/^threshold\s*[:=]\s*(\d*\.?\d+)$/i);
      if (thresholdMatch) {
        screenshotOptions.threshold = Number(thresholdMatch[1]);
        continue;
      }

      const animationsMatch = option.match(/^animations\s*[:=]\s*(disabled|allow)$/i);
      if (animationsMatch) {
        screenshotOptions.animations = animationsMatch[1].toLowerCase() as 'disabled' | 'allow';
        continue;
      }

      const caretMatch = option.match(/^caret\s*[:=]\s*(hide|initial)$/i);
      if (caretMatch) {
        screenshotOptions.caret = caretMatch[1].toLowerCase() as 'hide' | 'initial';
        continue;
      }

      const scaleMatch = option.match(/^scale\s*[:=]\s*(css|device)$/i);
      if (scaleMatch) {
        screenshotOptions.scale = scaleMatch[1].toLowerCase() as 'css' | 'device';
        continue;
      }

      // mask=<selector>  or  mask=[<sel1>][<sel2>]  — single or bracketed list of CSS selectors to mask
      const maskMatch = option.match(/^mask\s*[:=]\s*(.+)$/i);
      if (maskMatch) {
        const raw = maskMatch[1].trim();
        if (raw.startsWith('[')) {
          // Bracketed format: [sel1][sel2]...
          const extracted = [...raw.matchAll(/\[([^\]]+)\]/g)].map((m) => m[1].trim()).filter(Boolean);
          screenshotOptions.maskSelectors = extracted;
        } else {
          // Single selector: mask=.my-element
          screenshotOptions.maskSelectors = [raw];
        }
        continue;
      }

      throw new Error(`ASSERT_SCREENSHOT: unsupported option '${option}'. Supported options: timeout, fullPage, maxDiffPixelRatio, maxDiffPixels, threshold, animations, caret, scale, mask.`);
    }

    return screenshotOptions;
  }

  private parseRetryUntilOptions(options: string[]): {
    timeoutMs: number;
    intervalMs: number;
    maxRetries?: number;
  } {
    const { actionTimeoutMs } = this.getResolvedTimeouts();
    let timeoutMs = actionTimeoutMs;
    let intervalMs = 500;
    let maxRetries: number | undefined;

    for (const option of options) {
      const token = option.trim();
      if (!token) {
        continue;
      }

      const parsedTimeout = this.parseTimeoutFromCondition(token);
      if (parsedTimeout !== undefined) {
        timeoutMs = parsedTimeout;
        continue;
      }

      const retryMatch = token.match(/^(?:retry|retries|maxretries)\s*[:=]\s*(\d+)$/i);
      if (retryMatch) {
        maxRetries = Number(retryMatch[1]);
        continue;
      }

      const intervalMatch = token.match(/^interval\s*[:=]\s*(\d+)(ms|s)?$/i);
      if (intervalMatch) {
        intervalMs = this.parseTimeoutFromCondition(`timeout=${intervalMatch[1]}${intervalMatch[2] || 'ms'}`) ?? intervalMs;
        continue;
      }

      throw new Error(`RETRY_UNTIL: unsupported Data option '${token}'. Supported options: timeout, interval, retries.`);
    }

    return { timeoutMs, intervalMs, maxRetries };
  }

  private parseDateBuilderOptions(conditionParams: string[]): { offsetDays: number; offsetMonths: number; offsetYears: number; timezone: string; adjustToBusinessDay: 'none' | 'next' | 'prev' } {
    let offsetDays = 0;
    let offsetMonths = 0;
    let offsetYears = 0;
    let timezone = 'local';
    let adjustToBusinessDay: 'none' | 'next' | 'prev' = 'none';

    for (const token of conditionParams) {
      const t = token.trim();
      if (!t) continue;

      const tzMatch = t.match(/^tz\s*[:=]\s*(\S+)$/i);
      if (tzMatch) {
        timezone = tzMatch[1].trim();
        continue;
      }

      const offsetMatch = t.match(/^([+-]?\d+)(d|m|y)$/i);
      if (offsetMatch) {
        const val = Number(offsetMatch[1]);
        const unit = offsetMatch[2].toLowerCase();
        if (unit === 'd') offsetDays += val;
        else if (unit === 'm') offsetMonths += val;
        else if (unit === 'y') offsetYears += val;
        continue;
      }

      // Business day flags: biznext = roll to Monday, bizprev = roll to Friday
      if (/^biznext$/i.test(t)) { adjustToBusinessDay = 'next'; continue; }
      if (/^bizprev$/i.test(t)) { adjustToBusinessDay = 'prev'; continue; }

      throw new Error(`DATE_BUILDER: unsupported Condition token '${t}'. Supported: +10d, -2m, +1y, tz=UTC, biznext, bizprev.`);
    }

    return { offsetDays, offsetMonths, offsetYears, timezone, adjustToBusinessDay };
  }

  private applyDateOffset(base: Date, offsetDays: number, offsetMonths: number, offsetYears: number): Date {
    const d = new Date(base);
    if (offsetYears)  d.setFullYear(d.getFullYear() + offsetYears);
    if (offsetMonths) d.setMonth(d.getMonth() + offsetMonths);
    if (offsetDays)   d.setDate(d.getDate() + offsetDays);
    return d;
  }

  private adjustToNearestBusinessDay(date: Date, mode: 'next' | 'prev'): Date {
    const day = date.getDay(); // 0=Sun, 6=Sat
    if (day !== 0 && day !== 6) {
      return date; // already a weekday, no adjustment needed
    }
    const d = new Date(date);
    if (mode === 'next') {
      // Roll forward to Monday: Sat+2, Sun+1
      d.setDate(d.getDate() + (day === 6 ? 2 : 1));
    } else {
      // Roll back to Friday: Sat-1, Sun-2
      d.setDate(d.getDate() - (day === 6 ? 1 : 2));
    }
    return d;
  }

  private storeDateParts(groupKey: string, date: Date): void {
    const pad = (n: number) => String(n).padStart(2, '0');
    const SHORT_MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    const LONG_MONTHS  = ['January','February','March','April','May','June','July','August','September','October','November','December'];
    const SHORT_DAYS   = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
    const LONG_DAYS    = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];

    const dd   = pad(date.getDate());
    const ddd  = String(date.getDate());
    const dddd = SHORT_DAYS[date.getDay()];
    const ddddd = LONG_DAYS[date.getDay()];
    const mm   = pad(date.getMonth() + 1);
    const mmm  = SHORT_MONTHS[date.getMonth()];
    const mmmm = LONG_MONTHS[date.getMonth()];
    const yy   = String(date.getFullYear()).slice(-2);
    const yyyy = String(date.getFullYear());
    const iso  = date.toISOString().slice(0, 10);
    const isoDatetime = date.toISOString();
    const epoch = String(date.getTime());

    const store = (suffix: string, value: string) => {
      const key = `rt_${groupKey}_${suffix}`;
      this.dataContext.storeValue(key, value);
      console.log(`DATE_BUILDER: stored ${key} = ${value}`);
    };

    store('dd',    dd);
    store('ddd',   ddd);
    store('dddd',  dddd);
    store('ddddd', ddddd);
    store('mm',    mm);
    store('mmm',   mmm);
    store('mmmm',  mmmm);
    store('yy',    yy);
    store('yyyy',  yyyy);
    store('iso',   iso);
    store('iso_datetime', isoDatetime);
    store('epoch', epoch);
  }

  private async takeStepScreenshot(
    step: TestStep,
    stepIndex: number | string,
    preResolvedLocator?: Locator
  ): Promise<void> {
    await takeCsvStepScreenshot(this.page, this.stepScreenshotConfig, step, stepIndex, preResolvedLocator);
  }

  private evaluateRetryUntilMatcher(actualValue: string, exists: boolean, operator: string, expectedValue: string): boolean {
    switch (operator) {
      case 'exists':
      case 'is present':
        return exists;
      case 'not exists':
      case 'is not present':
      case 'is absent':
        return !exists;
      case 'equals':
        return actualValue === expectedValue;
      case 'not equals':
        return actualValue !== expectedValue;
      case 'contains':
        return actualValue.includes(expectedValue);
      case 'not contains':
        return !actualValue.includes(expectedValue);
      case 'starts with':
        return actualValue.startsWith(expectedValue);
      case 'not starts with':
        return !actualValue.startsWith(expectedValue);
      case 'ends with':
        return actualValue.endsWith(expectedValue);
      case 'not ends with':
        return !actualValue.endsWith(expectedValue);
      case 'matches regex':
        return new RegExp(expectedValue).test(actualValue);
      default:
        throw new Error(`RETRY_UNTIL: unknown matcher '${operator}'. Supported: exists, not exists, equals, not equals, contains, not contains, starts with, not starts with, ends with, not ends with, matches regex.`);
    }
  }

  private isConditionalAction(action: string): boolean {
    return /^(IF|IF_STATE|IF_TEXT|IF_VALUE|ELSE_IF|ELSEIF_STATE|ELSE_IF_STATE|ELSEIF_TEXT|ELSE_IF_TEXT|ELSEIF_VALUE|ELSE_IF_VALUE|ELSE|END_IF)$/i.test(action.trim());
  }

  private buildConditionalStructure(steps: TestStep[]): ConditionalStructure {
    const completedBlocks: ConditionalBlock[] = [];
    const stack: ConditionalBlockDraft[] = [];
    const openerActions = new Set(['IF', 'IF_STATE', 'IF_TEXT', 'IF_VALUE']);
    const elseIfActions = new Set([
      'ELSE_IF', 'ELSEIF_STATE', 'ELSE_IF_STATE', 'ELSEIF_TEXT', 'ELSE_IF_TEXT', 'ELSEIF_VALUE', 'ELSE_IF_VALUE',
    ]);

    for (let index = 0; index < steps.length; index++) {
      const step = steps[index];
      const action = step.action.trim().toUpperCase();
      if (!this.isConditionalAction(action)) continue;

      if (String(step.run ?? 'Y').trim().toUpperCase() === 'N') {
        throw new Error(`Conditional control action ${action} at step ${step.step} cannot use Run=N; disable its branch body steps instead.`);
      }

      if (openerActions.has(action)) {
        const draft: ConditionalBlockDraft = { openerIndex: index, branchIndices: [index] };
        stack.push(draft);
        continue;
      }

      if (elseIfActions.has(action)) {
        const current = stack[stack.length - 1];
        if (!current) throw new Error(`${action} at step ${step.step} has no matching IF.`);
        if (current.elseIndex !== undefined) throw new Error(`${action} at step ${step.step} cannot appear after ELSE.`);
        current.branchIndices.push(index);
        continue;
      }

      if (action === 'ELSE') {
        const current = stack[stack.length - 1];
        if (!current) throw new Error(`ELSE at step ${step.step} has no matching IF.`);
        if (current.elseIndex !== undefined) throw new Error(`IF block opened at step ${steps[current.openerIndex].step} has more than one ELSE.`);
        current.elseIndex = index;
        current.branchIndices.push(index);
        continue;
      }

      const current = stack.pop();
      if (!current) throw new Error(`END_IF at step ${step.step} has no matching IF.`);
      completedBlocks.push({ ...current, endIndex: index });
    }

    const unclosed = stack[stack.length - 1];
    if (unclosed) {
      throw new Error(`IF at step ${steps[unclosed.openerIndex].step} has no matching END_IF.`);
    }

    const blockByControlIndex = new Map<number, ConditionalBlock>();
    for (const block of completedBlocks) {
      for (const branchIndex of block.branchIndices) blockByControlIndex.set(branchIndex, block);
      blockByControlIndex.set(block.endIndex, block);
    }

    return { blockByControlIndex };
  }

  private getNextConditionalBranch(block: ConditionalBlock, currentIndex: number): number {
    return block.branchIndices.find((branchIndex) => branchIndex > currentIndex) ?? block.endIndex;
  }

  // Shared ASSERT-family state vocabulary — one source of truth for both ASSERT's error message
  // and IF_STATE's validation list.
  private static readonly ASSERT_STATE_TOKENS = [
    'is visible', 'is not visible', 'is hidden', 'is present', 'is not present', 'is absent',
    'is enabled', 'is disabled', 'is checked', 'is unchecked',
  ];

  // Runs a Playwright assertion (which polls up to its timeout, then throws on mismatch) and
  // converts that throw into `false` instead — used only by IF/ELSEIF conditions, so a slow app
  // gets the same poll-and-wait behavior as ASSERT, but a real (still-unmatched) result becomes
  // a branch decision rather than a failed test. Genuine structural errors (missing page/member,
  // invalid regex, etc.) must be thrown by the caller *before* calling this, since anything thrown
  // inside `run` is treated as "condition not met".
  private async resolveAssertionAsBoolean(run: () => Promise<void>): Promise<boolean> {
    try {
      await run();
      return true;
    } catch {
      return false;
    }
  }

  // Pulls an optional `timeout=Xs` token out of a pipe-delimited token list (same convention as
  // RETRY_UNTIL), returning the remaining tokens separately.
  private extractTimeoutToken(tokens: string[]): { timeoutMs?: number; rest: string[] } {
    const timeoutToken = tokens.find((t) => /^timeout\s*[:=]/i.test(t.trim()));
    const rest = tokens.filter((t) => t !== timeoutToken);
    return { timeoutMs: timeoutToken ? this.parseTimeoutFromCondition(timeoutToken) : undefined, rest };
  }

  // Shared by ASSERT (throws on mismatch) and IF_STATE (wraps this in resolveAssertionAsBoolean)
  // so both poll with the identical Playwright matchers and timeout behavior.
  private async runStateMatch(assertion: any, locator: Locator, state: string, options?: { timeout?: number }): Promise<void> {
    switch (state) {
      case 'is visible':     await assertion(locator).toBeVisible(options); return;
      case 'is not visible':
      case 'is hidden':      await assertion(locator).toBeHidden(options); return;
      case 'is present':     await assertion(locator).toBeAttached(options); return;
      case 'is not present':
      case 'is absent':      await assertion(locator).not.toBeAttached(options); return;
      case 'is enabled':     await assertion(locator).toBeEnabled(options); return;
      case 'is disabled':    await assertion(locator).toBeDisabled(options); return;
      case 'is checked':     await assertion(locator).toBeChecked({ checked: true, ...(options ?? {}) }); return;
      case 'is unchecked':   await assertion(locator).toBeChecked({ checked: false, ...(options ?? {}) }); return;
      default:
        throw new Error(`Unknown state "${state}". Supported: ${CSVTestRunner.ASSERT_STATE_TOKENS.join(', ')}`);
    }
  }

  // Shared by ASSERT_TEXT/ASSERT_VALUE (throw on mismatch) and IF_TEXT/IF_VALUE (wrap this in
  // resolveAssertionAsBoolean) so both poll with the identical Playwright matchers.
  private async runTextOrValueMatch(
    assertion: any,
    locator: Locator,
    mode: 'text' | 'value',
    operator: string,
    expected: string,
    actionName: string,
    options?: { timeout?: number }
  ): Promise<void> {
    const escaped = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

    if (mode === 'value') {
      switch (operator) {
        case 'equals':          await assertion(locator).toHaveValue(expected, options); return;
        case 'not equals':      await assertion(locator).not.toHaveValue(expected, options); return;
        case 'contains':        await assertion(locator).toHaveValue(new RegExp(escaped(expected)), options); return;
        case 'not contains':    await assertion(locator).not.toHaveValue(new RegExp(escaped(expected)), options); return;
        case 'starts with':     await assertion(locator).toHaveValue(new RegExp('^' + escaped(expected)), options); return;
        case 'not starts with': await assertion(locator).not.toHaveValue(new RegExp('^' + escaped(expected)), options); return;
        case 'ends with':       await assertion(locator).toHaveValue(new RegExp(escaped(expected) + '$'), options); return;
        case 'not ends with':   await assertion(locator).not.toHaveValue(new RegExp(escaped(expected) + '$'), options); return;
        case 'matches regex':   await assertion(locator).toHaveValue(new RegExp(expected), options); return;
        default:
          throw new Error(`${actionName}: unknown operator "${operator}". Supported: equals, not equals, contains, not contains, starts with, ends with, matches regex`);
      }
    }

    switch (operator) {
      case 'equals':         await assertion(locator.first()).toHaveText(expected, options); return;
      case 'not equals':     await assertion(locator.first()).not.toHaveText(expected, options); return;
      case 'contains':       await assertion(locator.first()).toContainText(expected, options); return;
      case 'not contains':   await assertion(locator.first()).not.toContainText(expected, options); return;
      case 'matches regex':  await assertion(locator.first()).toHaveText(new RegExp(expected), options); return;
      case 'starts with':
      case 'not starts with':
      case 'ends with':
      case 'not ends with': {
        await assertion(locator.first()).toBeVisible(options);
        const actual = ((await locator.first().textContent()) || '').trim();
        if (operator === 'starts with')     { assertion(actual.startsWith(expected)).toBe(true); return; }
        if (operator === 'not starts with') { assertion(actual.startsWith(expected)).toBe(false); return; }
        if (operator === 'ends with')       { assertion(actual.endsWith(expected)).toBe(true); return; }
        assertion(actual.endsWith(expected)).toBe(false);
        return;
      }
      default:
        throw new Error(`${actionName}: unknown operator "${operator}". Use ASSERT with Data=is absent to check element absence. Supported text operators: equals, not equals, contains, not contains, starts with, not starts with, ends with, not ends with, matches regex`);
    }
  }

  private async evaluateConditionalMatch(step: TestStep): Promise<boolean> {
    const action = step.action.trim().toUpperCase();
    const pageName = this.dataContext.interpolate(step.page || '');
    const objectName = this.dataContext.interpolate(step.object || '');
    const condition = this.dataContext.interpolate(step.condition || '');
    const data = this.dataContext.interpolate(step.data || '');
    const conditionParams = condition ? condition.split('|').map((part) => part.trim()) : [];
    const dataParams = data ? data.split('|').map((part) => part.trim()) : [];
    const locatorConditionParams = conditionParams[0] === '' ? [] : conditionParams;

    if (action === 'IF' || action === 'ELSE_IF') {
      const rawVariable = String(step.condition || '').trim();
      const wrappedVariable = rawVariable.match(/^\$\{([^}]+)\}$/);
      const variableName = (wrappedVariable?.[1] ?? rawVariable).trim();
      if (!variableName) throw new Error('IF requires Condition=variable name or ${variableName}.');

      const [operatorRaw = '', ...expectedParts] = dataParams;
      const operator = operatorRaw.toLowerCase();
      const expected = expectedParts.join('|');
      if (!operator) throw new Error('IF requires Data=operator|expectedValue (or exists/not exists).');
      if (!['exists', 'not exists', 'is present', 'is not present', 'is absent'].includes(operator) && expectedParts.length === 0) {
        throw new Error('IF requires an expected value after the operator.');
      }

      let value = this.dataContext.getValue(variableName);
      if (value === undefined && !variableName.toLowerCase().startsWith('rt_')) {
        value = this.dataContext.getValue(`rt_${variableName}`);
      }
      const exists = value !== undefined && value !== null;
      return this.evaluateRetryUntilMatcher(exists ? String(value) : '', exists, operator, expected);
    }

    if (action === 'IF_STATE' || action === 'ELSEIF_STATE' || action === 'ELSE_IF_STATE') {
      const { timeoutMs, rest } = this.extractTimeoutToken(dataParams);
      const state = (rest[0] || '').trim().toLowerCase().replace(/\s+/g, ' ');
      if (!CSVTestRunner.ASSERT_STATE_TOKENS.includes(state)) {
        throw new Error(`${action} requires Data to be a supported state matcher: ${CSVTestRunner.ASSERT_STATE_TOKENS.join(', ')} (optionally followed by |timeout=Xs).`);
      }

      const locator = await this.resolveStepLocator(pageName, objectName, locatorConditionParams);
      const options = timeoutMs !== undefined ? { timeout: timeoutMs } : undefined;

      // Polls with the same Playwright matcher ASSERT uses (auto-waits for a slow app), but a
      // timeout/mismatch here resolves to `false` (take ELSE) instead of failing the test.
      return this.resolveAssertionAsBoolean(() => this.runStateMatch(expect, locator, state, options));
    }

    if (action === 'IF_TEXT' || action === 'ELSEIF_TEXT' || action === 'ELSE_IF_TEXT' || action === 'IF_VALUE' || action === 'ELSEIF_VALUE' || action === 'ELSE_IF_VALUE') {
      const { timeoutMs, rest } = this.extractTimeoutToken(dataParams);
      const [operatorRaw = '', ...expectedParts] = rest;
      const operator = operatorRaw.trim().toLowerCase();
      const expected = expectedParts.join('|');
      if (!operator || expectedParts.length === 0) {
        throw new Error(`${action} requires Data=operator|expectedValue (optionally followed by |timeout=Xs).`);
      }

      const mode = action.endsWith('VALUE') ? 'value' : 'text';
      const allowedOperators = mode === 'value'
        ? ['equals', 'not equals', 'contains', 'not contains', 'starts with', 'not starts with', 'ends with', 'not ends with', 'matches regex']
        : ['equals', 'not equals', 'contains', 'not contains', 'matches regex', 'starts with', 'not starts with', 'ends with', 'not ends with'];
      if (!allowedOperators.includes(operator)) {
        throw new Error(`${action}: unknown operator "${operator}". Supported: ${allowedOperators.join(', ')}`);
      }
      if (operator === 'matches regex') {
        try { new RegExp(expected); } catch { throw new Error(`${action}: invalid regular expression in Data: ${expected}`); }
      }

      const locator = await this.resolveStepLocator(pageName, objectName, locatorConditionParams);
      const options = timeoutMs !== undefined ? { timeout: timeoutMs } : undefined;
      // Same matcher ASSERT_TEXT/ASSERT_VALUE use (which already polls for attachment as part of
      // its own auto-waiting); a timeout/mismatch here — including a target that never appears —
      // resolves to `false` (take ELSE) instead of failing the test, consistent with IF_STATE.
      return this.resolveAssertionAsBoolean(() => this.runTextOrValueMatch(expect, locator, mode, operator, expected, action, options));
    }

    throw new Error(`Unsupported conditional action: ${action}`);
  }

  private async processConditionalStep(
    steps: TestStep[],
    index: number,
    structure: ConditionalStructure,
    executionStack: ConditionalExecutionFrame[]
  ): Promise<number | undefined> {
    const step = steps[index];
    const action = step.action.trim().toUpperCase();
    if (!this.isConditionalAction(action)) return undefined;

    const block = structure.blockByControlIndex.get(index);
    if (!block) throw new Error(`${action} at step ${step.step} is not inside a valid conditional block.`);

    if (action === 'END_IF') {
      const frame = executionStack.pop();
      if (!frame || frame.block !== block) throw new Error(`Conditional execution stack is invalid at END_IF step ${step.step}.`);
      return undefined;
    }

    if (action === 'ELSE') {
      const frame = executionStack[executionStack.length - 1];
      if (!frame || frame.block !== block) throw new Error(`Conditional execution stack is invalid at ELSE step ${step.step}.`);
      if (frame.branchTaken) return block.endIndex;
      frame.branchTaken = true;
      return undefined;
    }

    const isOpener = ['IF', 'IF_STATE', 'IF_TEXT', 'IF_VALUE'].includes(action);
    if (isOpener) {
      const matches = await this.evaluateConditionalMatch(step);
      const frame = { block, branchTaken: matches };
      executionStack.push(frame);
      return matches ? undefined : this.getNextConditionalBranch(block, index);
    }

    const frame = executionStack[executionStack.length - 1];
    if (!frame || frame.block !== block) throw new Error(`Conditional execution stack is invalid at ${action} step ${step.step}.`);
    if (frame.branchTaken) return block.endIndex;

    const matches = await this.evaluateConditionalMatch(step);
    frame.branchTaken = matches;
    return matches ? undefined : this.getNextConditionalBranch(block, index);
  }

  private async executeConditionalStep(
    steps: TestStep[],
    index: number,
    stepIndex: number | string,
    structure: ConditionalStructure,
    executionStack: ConditionalExecutionFrame[]
  ): Promise<number | undefined> {
    const step = steps[index];
    setActiveStepContext(step, stepIndex);
    let jumpTo: number | undefined;
    const description = `[${stepIndex}] ${step.action} - ${this.getStepTarget(step)} - ${step.condition} - ${step.data}`;
    await test.step(description, async () => {
      jumpTo = await this.processConditionalStep(steps, index, structure, executionStack);
    });
    return jumpTo;
  }

  private getResolvedTimeouts(): {
    testTimeoutMs: number;
    expectTimeoutMs: number;
    actionTimeoutMs: number;
    navigationTimeoutMs: number;
  } {
    if (this.resolvedTimeouts) {
      return this.resolvedTimeouts;
    }

    const fallback = {
      testTimeoutMs: 5 * 60 * 1000,
      expectTimeoutMs: 10000,
      actionTimeoutMs: 20000,
      navigationTimeoutMs: 20000,
    };

    this.resolvedTimeouts = fallback;

    return this.resolvedTimeouts;
  }

  private parseExplicitTimeoutFromData(actionName: string, rawData: string): number | undefined {
    const action = String(actionName || '').trim().toUpperCase();
    const supportsTimeoutInData = new Set([
      'CLICK_IF_VISIBLE',
      'CLICK_TO_SWITCH',
      'SWITCH_CONTEXT',
      'ASSERT_CSS',
      'SOFTASSERT_CSS',
      'RETRY_UNTIL',
      'RELOAD_UNTIL',
    ]);
    if (!supportsTimeoutInData.has(action)) {
      return undefined;
    }

    // This is diagnostic classification only; it must never replace the original step error.
    try {
      return this.parseTimeoutFromCondition(String(rawData || '').trim());
    } catch {
      return undefined;
    }
  }

  private resolveTimeoutSource(actionName: string, errorMsg: string, rawData: string): string {
    const { testTimeoutMs, expectTimeoutMs, actionTimeoutMs, navigationTimeoutMs } = this.getResolvedTimeouts();
    const observedTimeout = Number((errorMsg.match(/(\d+)\s*ms/i) || [])[1]);
    const hasObservedTimeout = Number.isFinite(observedTimeout);
    const explicitTimeout = this.parseExplicitTimeoutFromData(actionName, rawData);
    const isAssertionAction = actionName.startsWith('ASSERT') || actionName.startsWith('SOFTASSERT') || actionName.startsWith('API_ASSERT') || actionName.startsWith('API_SOFTASSERT');
    const isNavigationAction = actionName === 'NAVIGATE' || actionName === 'GOTO' || actionName === 'GO_BACK' || actionName === 'WAIT_FOR_URL';

    if (/test timeout/i.test(errorMsg) || (hasObservedTimeout && observedTimeout === testTimeoutMs)) {
      return `GLOBAL_TEST_TIMEOUT (config.timeoutMs=${testTimeoutMs})`;
    }

    if (explicitTimeout && hasObservedTimeout && observedTimeout === explicitTimeout) {
      return `STEP_TIMEOUT_FROM_DATA (Data=${explicitTimeout}ms)`;
    }

    if (isAssertionAction && hasObservedTimeout && observedTimeout === expectTimeoutMs) {
      return `EXPECT_TIMEOUT (config.expectTimeoutMs=${expectTimeoutMs})`;
    }

    if (isNavigationAction && hasObservedTimeout && observedTimeout === navigationTimeoutMs) {
      return `NAVIGATION_TIMEOUT (config.navigationTimeoutMs=${navigationTimeoutMs})`;
    }

    if (hasObservedTimeout && observedTimeout === actionTimeoutMs) {
      return `ACTION_TIMEOUT (config.actionTimeoutMs=${actionTimeoutMs})`;
    }

    if (explicitTimeout) {
      return `STEP_TIMEOUT_FROM_DATA (Data=${explicitTimeout}ms)`;
    }

    if (hasObservedTimeout) {
      return `TIMEOUT_${observedTimeout}MS (unmapped: config.timeoutMs=${testTimeoutMs}, config.expectTimeoutMs=${expectTimeoutMs}, config.actionTimeoutMs=${actionTimeoutMs}, config.navigationTimeoutMs=${navigationTimeoutMs})`;
    }

    return `UNKNOWN_TIMEOUT_SOURCE (config.timeoutMs=${testTimeoutMs}, config.expectTimeoutMs=${expectTimeoutMs}, config.actionTimeoutMs=${actionTimeoutMs}, config.navigationTimeoutMs=${navigationTimeoutMs})`;
  }

  private shouldExecuteStep(step: TestStep): boolean {
    const runValue = String(step.run ?? 'Y').trim().toUpperCase();
    return runValue !== 'N';
  }

  private isBreakpointStep(step: TestStep): boolean {
    const runValue = String(step.run ?? 'Y').trim().toUpperCase();
    return runValue === 'B';
  }

  private emitRuntimeEvent(payload: Record<string, unknown>): void {
    console.log(`[runtime] ${JSON.stringify(payload)}`);
  }

  private isUiBreakpointEnabled(): boolean {
    return this.breakpointConfig.mode === 'ui' && this.breakpointConfig.controlFilePath !== '';
  }

  private async sleep(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }

  private async readUiControlCommand(): Promise<{ breakpointId?: string; action?: string } | null> {
    try {
      const raw = await fs.promises.readFile(this.breakpointConfig.controlFilePath, 'utf8');
      const trimmed = raw.trim();
      if (!trimmed) {
        return null;
      }

      const command = JSON.parse(trimmed) as { breakpointId?: string; action?: string };
      await fs.promises.writeFile(this.breakpointConfig.controlFilePath, '', 'utf8').catch(() => undefined);
      return command;
    } catch {
      return null;
    }
  }

  private async waitForUiExecutionControl(step: TestStep, stepIndex: number): Promise<'continue' | 'abort'> {
    if (!this.isUiBreakpointEnabled()) {
      return 'continue';
    }

    const stepTarget = this.getStepTarget(step);

    while (true) {
      const command = await this.readUiControlCommand();
      const action = String(command?.action || '').trim().toLowerCase();

      if (command && !command.breakpointId) {
        if (action === 'abort') {
          this.emitRuntimeEvent({
            event: 'execution_abort',
            runId: this.breakpointConfig.runId || undefined,
            test: this.currentTestName,
            filePath: this.currentTestFilePath,
            stepIndex,
            stepNumber: step.step,
            action: step.action,
            target: stepTarget,
          });
          return 'abort';
        }

        if (action === 'pause' && !this.executionPauseActive) {
          this.executionPauseActive = true;
          this.emitRuntimeEvent({
            event: 'execution_paused',
            runId: this.breakpointConfig.runId || undefined,
            test: this.currentTestName,
            filePath: this.currentTestFilePath,
            stepIndex,
            stepNumber: step.step,
            action: step.action,
            target: stepTarget,
          });
        } else if (action === 'resume' && this.executionPauseActive) {
          this.executionPauseActive = false;
          this.emitRuntimeEvent({
            event: 'execution_resumed',
            runId: this.breakpointConfig.runId || undefined,
            test: this.currentTestName,
            filePath: this.currentTestFilePath,
            stepIndex,
            stepNumber: step.step,
            action: step.action,
            target: stepTarget,
          });
        }
      }

      if (!this.executionPauseActive) {
        return 'continue';
      }

      await this.sleep(this.breakpointConfig.pollIntervalMs);
    }
  }

  private async waitForUiBreakpoint(step: TestStep, stepIndex: number): Promise<'continue' | 'abort'> {
    if (!this.isBreakpointStep(step) || !this.isUiBreakpointEnabled()) {
      return 'continue';
    }

    const breakpointId = `${this.breakpointConfig.runId || 'ui-run'}:${++this.breakpointSerial}`;
    const stepTarget = this.getStepTarget(step);

    this.emitRuntimeEvent({
      event: 'breakpoint_hit',
      breakpointId,
      runId: this.breakpointConfig.runId || undefined,
      test: this.currentTestName,
      filePath: this.currentTestFilePath,
      stepIndex,
      stepNumber: step.step,
      action: step.action,
      target: stepTarget,
      page: step.page,
      object: step.object,
      condition: step.condition,
      data: step.data,
    });

    while (true) {
      const command = await this.readUiControlCommand();
      const action = String(command?.action || '').trim().toLowerCase();

      if (!command) {
        await this.sleep(this.breakpointConfig.pollIntervalMs);
        continue;
      }

      if (!command.breakpointId && action === 'abort') {
        this.emitRuntimeEvent({
          event: 'execution_abort',
          runId: this.breakpointConfig.runId || undefined,
          test: this.currentTestName,
          filePath: this.currentTestFilePath,
          stepIndex,
          stepNumber: step.step,
          action: step.action,
          target: stepTarget,
        });
        return 'abort';
      }

      if (command.breakpointId === breakpointId && (action === 'resume' || action === 'abort')) {
        this.emitRuntimeEvent({
          event: action === 'resume' ? 'breakpoint_resume' : 'breakpoint_abort',
          breakpointId,
          runId: this.breakpointConfig.runId || undefined,
          test: this.currentTestName,
          filePath: this.currentTestFilePath,
          stepIndex,
          stepNumber: step.step,
          action: step.action,
          target: stepTarget,
        });
        return action === 'resume' ? 'continue' : 'abort';
      }

      await this.sleep(this.breakpointConfig.pollIntervalMs);
    }
  }

  private async waitForUiFailureControl(
    step: TestStep,
    stepIndex: number | string,
    error: unknown
  ): Promise<'retry' | 'resume' | 'abort'> {
    if (!this.isUiBreakpointEnabled() || !this.breakpointConfig.pauseOnFailure) {
      return 'abort';
    }

    const breakpointId = `${this.breakpointConfig.runId || 'ui-run'}:${++this.breakpointSerial}`;
    const stepTarget = this.getStepTarget(step);
    const errorMessage = error instanceof Error ? error.message : String(error);

    this.emitRuntimeEvent({
      event: 'failure_paused',
      breakpointId,
      runId: this.breakpointConfig.runId || undefined,
      test: this.currentTestName,
      filePath: this.currentTestFilePath,
      stepIndex,
      stepNumber: step.step,
      action: step.action,
      target: stepTarget,
      page: step.page,
      object: step.object,
      condition: step.condition,
      data: step.data,
      error: errorMessage,
    });

    while (true) {
      const command = await this.readUiControlCommand();
      const action = String(command?.action || '').trim().toLowerCase();

      if (command && !command.breakpointId && action === 'abort') {
        this.emitRuntimeEvent({
          event: 'execution_abort',
          runId: this.breakpointConfig.runId || undefined,
          test: this.currentTestName,
          filePath: this.currentTestFilePath,
          stepIndex,
          stepNumber: step.step,
          action: step.action,
          target: stepTarget,
        });
        return 'abort';
      }

      if (command?.breakpointId === breakpointId && ['retry', 'resume', 'abort'].includes(action)) {
        this.emitRuntimeEvent({
          event: action === 'abort' ? 'breakpoint_abort' : 'failure_control',
          breakpointId,
          action,
          runId: this.breakpointConfig.runId || undefined,
          test: this.currentTestName,
          filePath: this.currentTestFilePath,
          stepIndex,
          stepNumber: step.step,
          target: stepTarget,
        });
        return action as 'retry' | 'resume' | 'abort';
      }

      await this.sleep(this.breakpointConfig.pollIntervalMs);
    }
  }

  private getApiDataRows(dataSource: string): Array<Record<string, any>> {
    return this.dataContext.getTestDataRows(dataSource) as Array<Record<string, any>>;
  }

  private getApiEndpoint(service: string, endpointKey: string): Record<string, any> {
    const normalizedService = (service || '').trim().toLowerCase();
    const normalizedEndpoint = (endpointKey || '').trim().toLowerCase();

    if (!normalizedService || !normalizedEndpoint) {
      throw new Error(
        'API action requires Page=service and Object=endpointKey. Example: API_POST,submission,create,...'
      );
    }

    const endpoints = this.getApiDataRows('api_endpoints');
    const match = endpoints.find((row) => {
      const rowService = String(row.service ?? row.scenario ?? '').trim().toLowerCase();
      const rowEndpoint = String(row.endpointkey ?? row.endpoint ?? '').trim().toLowerCase();
      return rowService === normalizedService && rowEndpoint === normalizedEndpoint;
    });

    if (!match) {
      throw new Error(
        `Endpoint not found in api_endpoints.csv for service='${service}' endpointKey='${endpointKey}'.`
      );
    }

    return match;
  }

  private resolveApiUrl(endpoint: Record<string, any>): string {
    const rawPathOrUrl = String(endpoint.path ?? endpoint.url ?? '').trim();
    if (!rawPathOrUrl) {
      throw new Error('api_endpoints.csv row must define path (or url).');
    }

    const endpointName = String(endpoint.endpointkey ?? '').trim() || '(unknown)';
    const scenarioName = String(endpoint.scenario ?? endpoint.service ?? '').trim() || '(unknown)';
    const rawPlaceholderKeys = [...rawPathOrUrl.matchAll(/\$\{([^}]+)\}/g)].map((match) => String(match[1] ?? '').trim());
    const baseUrlKey = String(endpoint.baseurlkey ?? '').trim();
    const applicationNames = [
      ...Object.keys(this.runtimeValueMap),
      ...rawPlaceholderKeys,
      baseUrlKey,
    ]
      .filter((key) => /\./.test(key))
      .map((key) => key.split('.')[0])
      .filter((value, index, values) => value && values.indexOf(value) === index);
    const applicationName = applicationNames.join(', ') || '(unknown)';
    const environmentName = String(this.runtimeValueMap.environment ?? this.dataContext.getValue('environment') ?? '').trim() ||
      '(unknown)';

    const interpolatedPathOrUrl = this.dataContext.interpolate(rawPathOrUrl);
    const unresolvedPlaceholders = [...interpolatedPathOrUrl.matchAll(/\$\{([^}]+)\}/g)].map((match) => match[1]);
    if (unresolvedPlaceholders.length > 0) {
      throw new Error(
        `Unable to resolve Request URL for scenario '${scenarioName}' endpoint '${endpointName}' ` +
          `\nfor application '${applicationName}' in environment '${environmentName}'. ` +
          `\nMissing runtime value(s): ${unresolvedPlaceholders.join(', ')}.`
      );
    }

    if (/^https?:\/\//i.test(interpolatedPathOrUrl)) {
      return interpolatedPathOrUrl;
    }

    if (!baseUrlKey) {
      throw new Error(
        `api_endpoints.csv row for scenario '${scenarioName}' endpoint '${endpointName}' ` +
          `\nfor application '${applicationName}' in environment '${environmentName}' ` +
          `\nmust define either an absolute/interpolated url or a baseUrlKey for relative path '${interpolatedPathOrUrl}'.`
      );
    }

    const runtimeApiBaseUrl = String(this.dataContext.getValue(baseUrlKey) ?? '').trim();

    if (!runtimeApiBaseUrl) {
      throw new Error(
        `Unable to resolve Request URL for scenario '${scenarioName}' endpoint '${endpointName}' ` +
          `for application '${applicationName}' in environment '${environmentName}'. ` +
          `Endpoint path '${interpolatedPathOrUrl}' could not be joined because ` +
          `Runtime key '${baseUrlKey}' was not found in DataContext. ` +
          `Update api_endpoints.csv baseUrlKey or ensure the runtime resolver populates that key.`
      );
    }

    return `${runtimeApiBaseUrl.replace(/\/+$/, '')}/${interpolatedPathOrUrl.replace(/^\/+/, '')}`;
  }

  private getHeaderSet(scenarioName: string): Record<string, string> {
    if (!scenarioName) {
      return {};
    }

    const row = this.dataContext.getTestData('api_headers', { scenario: scenarioName });
    if (!row) {
      throw new Error(`Header scenario '${scenarioName}' not found in api_headers.csv.`);
    }

    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(row)) {
      if (key === 'scenario') {
        continue;
      }

      const textValue = String(value ?? '').trim();
      if (!textValue) {
        continue;
      }

      headers[key] = this.dataContext.interpolate(textValue);
    }

    return headers;
  }

  private resolvePayload(payloadRef: string): unknown {
    const ref = (payloadRef || '').trim();
    if (!ref) {
      return undefined;
    }

    if (ref.startsWith('{') || ref.startsWith('[')) {
      return JSON.parse(this.dataContext.interpolatePayload(ref));
    }

    const normalizedRef = ref.toLowerCase().endsWith('.json') ? ref : `${ref}.json`;
    const candidates = [
      path.join(this.testDataRootDir, 'payloads', normalizedRef),
      path.join(this.testDataRootDir, normalizedRef),
    ];

    const payloadFilePath = candidates.find((candidate) => fs.existsSync(candidate));
    if (!payloadFilePath) {
      throw new Error(
        `Payload file '${normalizedRef}' not found. Checked: ${candidates
          .map((candidate) => path.relative(this.testDataRootDir, candidate).replace(/\\/g, '/'))
          .join(', ')}`
      );
    }

    const rawPayload = fs.readFileSync(payloadFilePath, 'utf-8');
    return JSON.parse(this.dataContext.interpolatePayload(rawPayload));
  }

  private storeApiRequest(method: string, url: string, headers: Record<string, string>, body: unknown, service?: string, endpointKey?: string): void {
    let bodyForStorage: unknown = body;
    
    // Convert body to string for storage if it's an object
    if (typeof body === 'object' && body !== null) {
      try {
        bodyForStorage = JSON.stringify(body);
      } catch {
        bodyForStorage = String(body);
      }
    }

    this.dataContext.storeValue('last_request_method', method);
    this.dataContext.storeValue('last_request_url', url);
    this.dataContext.storeValue('last_request_headers', headers);
    this.dataContext.storeValue('last_request_body', bodyForStorage);
    this.dataContext.storeValue('last_request_service', service || '');
    this.dataContext.storeValue('last_request_endpoint_key', endpointKey || '');
  }

  private async storeApiResponse(response: APIResponse): Promise<void> {
    const status = response.status();
    const url = response.url();
    const headers = response.headers();
    const text = await response.text();

    let body: unknown = text;
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }

    this.dataContext.storeValue('last_response_status', status);
    this.dataContext.storeValue('last_response_url', url);
    this.dataContext.storeValue('last_response_headers', headers);
    this.dataContext.storeValue('last_response_text', text);
    this.dataContext.storeValue('last_response_body', body);

    /*console.log('Request:', {
      service: this.dataContext.getValue('last_request_service'),
      endpoint: this.dataContext.getValue('last_request_endpoint_key'),
      scenario: this.dataContext.getValue('scenario'),
      method: this.dataContext.getValue('last_request_method'),
      url: this.dataContext.getValue('last_request_url'),
      headers: this.dataContext.getValue('last_request_headers'),
      body: this.dataContext.getValue('last_request_body'),
    });
    console.log('Response:', {
      status: this.dataContext.getValue('last_response_status'),
      headers: this.dataContext.getValue('last_response_headers'),
      body: this.dataContext.getValue('last_response_body'),
    });*/
    await this.attachApiRequestResponseToReport();
  }

  private async attachApiRequestResponseToReport(): Promise<void> {
    const requestService = this.dataContext.getValue('last_request_service');
    const requestEndpointKey = this.dataContext.getValue('last_request_endpoint_key');
    const scenario = this.dataContext.getValue('scenario');
    const requestMethod = this.dataContext.getValue('last_request_method');
    const requestUrl = this.dataContext.getValue('last_request_url');
    const requestHeaders = this.dataContext.getValue('last_request_headers');
    let requestBody: unknown = this.dataContext.getValue('last_request_body');
    const responseStatus = this.dataContext.getValue('last_response_status');
    const responseHeaders = this.dataContext.getValue('last_response_headers');
    const responseBody = this.dataContext.getValue('last_response_body');

    // Parse request body if it's a stringified JSON (to match response body handling)
    if (typeof requestBody === 'string') {
      try {
        requestBody = JSON.parse(requestBody);
      } catch {
        // Keep as string if parsing fails
      }
    }

    // Create combined request/response report with endpoint and scenario info
    const report = {
      scenario: scenario,
      brk: '=================================================================',
      request: {
        method: requestMethod,
        url: requestUrl,
        headers: requestHeaders,
        body: requestBody,
      },
      brk_: '================================================================',
      response: {
        status: responseStatus,
        headers: responseHeaders,
        body: responseBody,
      },
    };

    // Attach to Playwright report as JSON
    test.info().attach(`${requestEndpointKey}-${requestService}-api-request-response`, {
      body: JSON.stringify(report, null, 2),
      contentType: 'application/json',
    });
  }

  private getJsonPathValue(source: unknown, jsonPath: string): unknown {
    const normalized = (jsonPath || '').trim();
    if (!normalized || normalized === '$') {
      return source;
    }

    if (!normalized.startsWith('$')) {
      throw new Error(`JSON path must start with '$'. Received: ${jsonPath}`);
    }

    const tokens = normalized
      .replace(/^\$\.?/, '')
      .replace(/\[(\d+)\]/g, '.$1')
      .split('.')
      .map((token) => token.trim())
      .filter((token) => token.length > 0);

    let current: any = source;
    for (const token of tokens) {
      if (current === null || current === undefined) {
        return undefined;
      }
      current = current[token];
    }

    return current;
  }

  private async executeApiRequest(
    actionMethod: string,
    service: string,
    endpointKey: string,
    headerScenario: string,
    payloadRef: string
  ): Promise<void> {
    const endpoint = this.getApiEndpoint(service, endpointKey);
    const endpointMethod = String(endpoint.method ?? '').trim().toUpperCase();
    const method = (actionMethod || endpointMethod || 'GET').toUpperCase();

    if (endpointMethod && actionMethod && endpointMethod !== method) {
      throw new Error(
        `Method mismatch for endpoint ${service}.${endpointKey}: action=${method}, configured=${endpointMethod}`
      );
    }

    const url = this.resolveApiUrl(endpoint);
    const configuredHeaderScenario = String(endpoint.headerscenario ?? '').trim();
    const headers = {
      ...this.getHeaderSet(headerScenario || configuredHeaderScenario),
      ...this.apiHeaderOverrides,
    };

    const bodyCapableMethods = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
    const requestBody = bodyCapableMethods.has(method) ? this.resolvePayload(payloadRef) : undefined;

    // Store request details for debugging, including endpoint and scenario info
    this.storeApiRequest(method, url, headers, requestBody, service, endpointKey);

    const response = await this.page.request.fetch(url, {
      method,
      headers,
      data: requestBody,
    });

    await this.storeApiResponse(response);
  }

  private findFlowMatchesByName(dirPath: string, fileName: string, matches: string[] = []): string[] {
    if (!fs.existsSync(dirPath)) {
      return matches;
    }

    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        this.findFlowMatchesByName(fullPath, fileName, matches);
      } else if (entry.isFile() && entry.name.toLowerCase() === fileName.toLowerCase()) {
        matches.push(fullPath);
      }
    }

    return matches;
  }

  private applyRuntimeValues(): void {
    for (const [key, value] of Object.entries(this.runtimeValueMap)) {
      this.dataContext.storeValue(key, value);
    }
  }

  private restoreContext(values: Record<string, any>): void {
    this.dataContext.clear();
    this.applyRuntimeValues();
    for (const [key, value] of Object.entries(values)) {
      this.dataContext.storeValue(key, value);
    }
  }

  private getScenarioRows(dataSource: string, selector: string): Array<Record<string, any>> {
    const trimmedSelector = (selector || 'ALL').trim();
    const selectorLower = trimmedSelector.toLowerCase();

    if (selectorLower === 'all') {
      return this.dataContext.getTestDataRows(dataSource) as Array<Record<string, any>>;
    }

    const availableRows = this.dataContext.getTestDataRows(dataSource) as Array<Record<string, any>>;
    const allScenarioNames = availableRows.map((row) => String(row.scenario ?? '').trim());

    if (trimmedSelector.includes('...')) {
      const parts = trimmedSelector.split('...');
      if (parts.length !== 2) {
        throw new Error(
          `Invalid range selector '${trimmedSelector}'. Expected format: startScenario...endScenario`
        );
      }
      const [start, end] = parts.map((p) => p.trim());
      const startIdx = allScenarioNames.indexOf(start);
      const endIdx = allScenarioNames.indexOf(end);
      if (startIdx === -1) {
        throw new Error(`Range start scenario '${start}' not found in ${dataSource}.csv`);
      }
      if (endIdx === -1) {
        throw new Error(`Range end scenario '${end}' not found in ${dataSource}.csv`);
      }
      if (startIdx > endIdx) {
        throw new Error(
          `Range start '${start}' comes after range end '${end}' in ${dataSource}.csv`
        );
      }
      return availableRows.slice(startIdx, endIdx + 1);
    }

    const requestedScenarios = trimmedSelector
      .split('|')
      .map((value) => value.trim())
      .filter((value) => value.length > 0);

    if (requestedScenarios.length === 0) {
      throw new Error(`RUN_FLOW requires at least one scenario or ALL for data source '${dataSource}'.`);
    }

    const rowMap = new Map<string, Record<string, any>>();
    for (const row of availableRows) {
      const scenarioName = String(row.scenario ?? '').trim();
      if (scenarioName) {
        rowMap.set(scenarioName, row);
      }
    }

    const missing = requestedScenarios.filter((scenario) => !rowMap.has(scenario));
    if (missing.length > 0) {
      throw new Error(`Scenario(s) not found in ${dataSource}.csv: ${missing.join(', ')}`);
    }

    return requestedScenarios.map((scenario) => rowMap.get(scenario) as Record<string, any>);
  }

  private async executeFlowForDataScenarios(
    flowRef: string,
    dataSource: string,
    selector: string,
    scope: 'flows' | 'tests',
    parentStepIndex?: number | string
  ): Promise<void> {
    if (!flowRef.trim() || !dataSource.trim()) {
      throw new Error(
        "Flow data iteration expects Page=flowRef, Object=dataSource, Data=ALL or scenario list (pipe-separated)."
      );
    }

    const baseContext = this.dataContext.getAllValues();
    const scenarioRows = this.getScenarioRows(dataSource, selector || 'ALL');

    for (const row of scenarioRows) {
      const scenarioName = String(row.scenario ?? '').trim() || 'unnamed-scenario';

      await test.step(`Scenario iteration: ${scenarioName}`, async () => {
        this.restoreContext(baseContext);

        for (const [key, value] of Object.entries(row)) {
          this.dataContext.storeValue(key, value);
        }

        await this.executeFlow(flowRef, scope, parentStepIndex);
      });
    }

    this.restoreContext(baseContext);
  }

  private resolveFlowFilePath(flowRef: string, scope: 'flows' | 'tests'): string {
    const raw = (flowRef || '').trim();
    if (!raw) {
      throw new Error('Flow action requires a CSV file reference in the Page column.');
    }

    const scopeRoot = scope === 'flows' ? this.flowsRootDir : this.testsRootDir;
    const scopeLabel = scope === 'flows' ? 'test-flows' : 'tests';

    const normalizedRef = raw.replace(/\\/g, '/');
    const hasExtension = normalizedRef.toLowerCase().endsWith('.csv');
    const fileName = hasExtension ? path.basename(normalizedRef) : `${path.basename(normalizedRef)}.csv`;

    const candidates = [
      path.join(scopeRoot, normalizedRef),
      path.join(scopeRoot, hasExtension ? normalizedRef : `${normalizedRef}.csv`),
    ];

    for (const candidate of candidates) {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
        return candidate;
      }
    }

    const nameMatches = this.findFlowMatchesByName(scopeRoot, fileName);
    if (nameMatches.length === 1) {
      return nameMatches[0];
    }

    if (nameMatches.length > 1) {
      const relative = nameMatches.map((p) => path.relative(scopeRoot, p).replace(/\\/g, '/'));
      throw new Error(
        `Flow reference is ambiguous for '${raw}'. Use a relative path from ${scopeLabel}/. Matches: ${relative.join(', ')}`
      );
    }

    throw new Error(`Flow file not found in ${scopeLabel}/: ${raw}`);
  }

  private async executeFlow(flowRef: string, scope: 'flows' | 'tests', parentStepIndex?: number | string): Promise<void> {
    const flowFilePath = this.resolveFlowFilePath(flowRef, scope);
    const scopeRoot = scope === 'flows' ? this.flowsRootDir : this.testsRootDir;

    if (this.flowExecutionStack.includes(flowFilePath)) {
      const chain = [...this.flowExecutionStack, flowFilePath]
        .map((p) => path.relative(scopeRoot, p).replace(/\\/g, '/'))
        .join(' -> ');
      throw new Error(`Flow recursion detected: ${chain}`);
    }

    this.flowExecutionStack.push(flowFilePath);
    try {
      const flowSteps = CSVParser.parseTestSteps(flowFilePath);
      const conditionalStructure = this.buildConditionalStructure(flowSteps);
      const conditionalStack: ConditionalExecutionFrame[] = [];
      for (let i = 0; i < flowSteps.length; i++) {
        const step = flowSteps[i];
        const childLabel = parentStepIndex !== undefined ? `${parentStepIndex}.${i + 1}` : i + 1;
        if (this.isConditionalAction(step.action)) {
          let stepCompleted = false;
          while (!stepCompleted) {
            try {
              const jumpTo = await this.executeConditionalStep(flowSteps, i, childLabel, conditionalStructure, conditionalStack);
              if (jumpTo !== undefined) i = jumpTo - 1;
              stepCompleted = true;
            } catch (error) {
              if (step.optional) {
                console.warn(`Optional conditional step cannot be skipped: ${error}`);
                throw error;
              }
              const failureDecision = await this.waitForUiFailureControl(step, childLabel, error);
              if (failureDecision === 'retry') continue;
              if (failureDecision === 'resume') {
                stepCompleted = true;
                continue;
              }
              throw error;
            }
          }
          continue;
        }
        if (!this.shouldExecuteStep(step)) {
          const stepTarget = this.getStepTarget(step);
          console.log(`Skipping flow step [${childLabel}] ${step.action} - ${stepTarget} (Run=N)`);
          continue;
        }
        let stepCompleted = false;
        while (!stepCompleted) {
          try {
            await this.executeStep(step, childLabel);
            stepCompleted = true;
          } catch (error) {
            if (step.optional) {
              console.warn(`⚠️  Optional flow step skipped: ${error}`);
              stepCompleted = true;
              continue;
            }

            const failureDecision = await this.waitForUiFailureControl(step, childLabel, error);
            if (failureDecision === 'retry') {
              continue;
            }
            if (failureDecision === 'resume') {
              stepCompleted = true;
              continue;
            }
            throw error;
          }
        }
      }
    } finally {
      this.flowExecutionStack.pop();
    }
  }

  /**
   * Execute a single test step
   */
  private async executeStep(step: TestStep, stepIndex: number | string): Promise<void> {
    setActiveStepContext(step, stepIndex);
    const stepTarget = this.getStepTarget(step);
    const stepDescription = `[${stepIndex}] ${step.action} - ${stepTarget} - ${step.condition} - ${step.data}`;

    await test.step(stepDescription, async (stepInfo) => {
      const interpolatedPage = this.dataContext.interpolate(step.page || '');
      const interpolatedObject = this.dataContext.interpolate(step.object || '');
      const interpolatedCondition = this.dataContext.interpolate(step.condition || '');
      const interpolatedData = this.dataContext.interpolate(step.data);
      // Pipe-delimited Params can come from Condition or Data depending on the action — we'll parse both and let the action handler decide which to use
      const dataParams = interpolatedData ? interpolatedData.split('|').map((part) => part.trim()) : [];
      const conditionParams = interpolatedCondition ? interpolatedCondition.split('|').map((part) => part.trim()) : [];
      const displayValue = (value: string | undefined | null): string => {
        const txt = String(value ?? '').trim();
        return txt === '' ? '<empty>' : txt;
      };
      let actionExecutionContext = `step.columns: [Condition: ${displayValue(step.condition)}]: [Data: ${displayValue(step.data)}]`;

      const skipDataResult = this.shouldSkipStepForEmptyInterpolatedData(step.data || '', interpolatedData);
      if (skipDataResult.skip) {
        const skipReason =`Data interpolation resolved to empty for placeholder(s): ${skipDataResult.emptyPlaceholderKeys.join(', ')}`;
        //console.log(`Skipping ${step.action}: ${skipReason}`);
        stepInfo.skip(true, skipReason);
        return;
      }

      const actionNameUpper = step.action.toUpperCase();

      try {
        switch (actionNameUpper) {
        //Console Message
        case 'ECHO':
          {
            console.log(`ECHO: ${displayValue(interpolatedData)}`);
          }
          break;
        // Navigation
        case 'NAVIGATE':
        case 'GOTO':
          {
            const url = this.dataContext.interpolate(step.data || '/') || '/';
            actionExecutionContext = `page.goto: [Url(Data): ${displayValue(url)}]`;
            await this.page.goto(url, { waitUntil: 'load' });
            await this.takeStepScreenshot(step, stepIndex);
          }
          break;

        case 'GO_BACK':
          {
            actionExecutionContext = 'page.goBack: [Action: execute]';
            await this.page.goBack({ waitUntil: 'load' });
            await this.takeStepScreenshot(step, stepIndex);
          }
          break;

        case 'GO_FORWARD':
          {
            actionExecutionContext = 'page.goForward: [Action: execute]';
            await this.page.goForward({ waitUntil: 'load' });
            await this.takeStepScreenshot(step, stepIndex);
          }
          break;
        
        case 'RELOAD':
          {
            actionExecutionContext = 'page.reload: [Action: execute]';
            await this.page.reload({ waitUntil: 'load' });
            await this.takeStepScreenshot(step, stepIndex);
          }
          break;

        // RELOAD_FRAME: reloads a specific iframe via a POM FrameLocator member.
        // Page=page class; Object=FrameLocator member/method; Condition=optional locator params
        case 'RELOAD_FRAME':
          {
            actionExecutionContext = `frame.evaluate(reload): [Page: ${displayValue(interpolatedPage)}]: [Object: ${displayValue(interpolatedObject)}]: [Params(Condition): ${displayValue(interpolatedCondition)}]`;
            if (!interpolatedPage || !interpolatedObject) {
              throw new Error('RELOAD_FRAME requires Page=pageClass and Object=frameLocator member/method.');
            }
            const frameRef = await this.actionMapper.executeAction(interpolatedPage, interpolatedObject, ...conditionParams);
            // FrameLocator.owner() returns the Locator for the <iframe> element itself
            const iframeLocator = (frameRef as any).owner?.();
            if (!iframeLocator) {
              throw new Error('RELOAD_FRAME: Object must resolve to a FrameLocator (a POM member with .owner()). Ensure it is declared as page.frameLocator(...).');
            }
            const elementHandle = await iframeLocator.elementHandle();
            const frame = await elementHandle?.contentFrame();
            if (!frame) {
              throw new Error('RELOAD_FRAME: could not resolve Frame — ensure the iframe is attached and visible before reloading.');
            }
            await frame.evaluate(() => location.reload());
            await frame.waitForLoadState('load');
            await this.takeStepScreenshot(step, stepIndex);
          }
          break;

        // Input actions
        // FILL: Page=target page; Object=target locator; Condition=optional dynamic locator params; Data=input value (STRICT)
        case 'FILL':
          {
            actionExecutionContext = `locator.fill: [Page: ${displayValue(interpolatedPage)}]: [Object: ${displayValue(interpolatedObject)}]: [Value(Data): ${displayValue(interpolatedData)}]`;
            if (conditionParams.length > 0 && conditionParams[0] === '') {
              conditionParams.length = 0; // Clear if only empty string
            }
            const locator = await this.resolveStepLocator(interpolatedPage, interpolatedObject, conditionParams);
            await locator.fill(interpolatedData);           
            await this.takeStepScreenshot(step, stepIndex, locator);
          }
          break;

        // CLICK: strict — Playwright's built-in actionability handles visibility+enabled; throws if not met.
        // CLICK_IF_VISIBLE: soft — skips silently if element not visible within timeout (Data=ms, default 3000).
        // CLICK_IF_ENABLED: soft — skips silently if element is disabled at click time.
        // Page=target page; Object=target locator/method; Condition=optional dynamic locator params
        case 'CLICK':
        case 'CLICK_IF_VISIBLE':
        case 'CLICK_IF_ENABLED':
          {
            const ifVisible = actionNameUpper === 'CLICK_IF_VISIBLE';
            const ifEnabled = actionNameUpper === 'CLICK_IF_ENABLED';
            const qualifier = ifVisible ? ' (if visible)' : ifEnabled ? ' (if enabled)' : '';
            actionExecutionContext = `locator.click${qualifier}: [Page: ${displayValue(interpolatedPage)}]: [Object: ${displayValue(interpolatedObject)}]: [LocatorParams(Condition): ${displayValue(interpolatedCondition)}]`;
            if (conditionParams.length > 0 && conditionParams[0] === '') {
              conditionParams.length = 0;
            }
            const locator = await this.resolveStepLocator(interpolatedPage, interpolatedObject, conditionParams);
            if (ifVisible) {
              const visibilityTimeout = interpolatedData ? Number(interpolatedData.replace(/[^0-9]/g, '')) || 3000 : 3000;
              let isVisible = false;
              try {
                await locator.waitFor({ state: 'visible', timeout: visibilityTimeout });
                isVisible = true;
              } catch {
                // element did not appear within timeout — skip silently
              }
              if (!isVisible) {
                console.log(`ℹ  CLICK_IF_VISIBLE: element not visible within ${visibilityTimeout}ms — step skipped.`);
                try { stepInfo.skip(true, 'Element not visible — step skipped'); } catch { /* outside test context */ }
                break;
              }
            }
            if (ifEnabled) {
              const isEnabled = await locator.isEnabled();
              if (!isEnabled) {
                console.log(`ℹ  CLICK_IF_ENABLED: element is disabled — step skipped.`);
                try { stepInfo.skip(true, 'Element disabled — step skipped'); } catch { /* outside test context */ }
                break;
              }
            }
            await this.takeStepScreenshot(step, stepIndex, locator);
            await locator.click();
          }
          break;

        // DOUBLE_CLICK: Page=target page; Object=target locator/method; Condition=optional dynamic locator params; Data=unused (STRICT)
        case 'DOUBLE_CLICK':
          {
            actionExecutionContext = `locator.dblclick: [Page: ${displayValue(interpolatedPage)}]: [Object: ${displayValue(interpolatedObject)}]: [LocatorParams(Condition): ${displayValue(interpolatedCondition)}]`;
            if (conditionParams.length > 0 && conditionParams[0] === '') {
              conditionParams.length = 0;
            }
            const locator = await this.resolveStepLocator(interpolatedPage, interpolatedObject, conditionParams);
            await this.takeStepScreenshot(step, stepIndex, locator);
            await locator.dblclick();
          }
          break;

        // RIGHT_CLICK: Page=target page; Object=target locator/method; Condition=optional dynamic locator params; Data=unused (STRICT)
        case 'RIGHT_CLICK':
          {
            actionExecutionContext = `locator.click(button=right): [Page: ${displayValue(interpolatedPage)}]: [Object: ${displayValue(interpolatedObject)}]: [LocatorParams(Condition): ${displayValue(interpolatedCondition)}]`;
            if (conditionParams.length > 0 && conditionParams[0] === '') {
              conditionParams.length = 0;
            }
            const locator = await this.resolveStepLocator(interpolatedPage, interpolatedObject, conditionParams);
            await this.takeStepScreenshot(step, stepIndex, locator);
            await locator.click({ button: 'right' });
          }
          break;

        // SELECT: Page=target page; Object=target locator; Condition=optional dynamic locator params; Data=option value
        case 'SELECT':
          {
            actionExecutionContext = `locator.selectOption: [Page: ${displayValue(interpolatedPage)}]: [Object: ${displayValue(interpolatedObject)}]: [Option(Data): ${displayValue(interpolatedData)}]`;
            const locator = await this.resolveStepLocator(interpolatedPage, interpolatedObject, conditionParams);
            await this.takeStepScreenshot(step, stepIndex, locator);
            await locator.selectOption(interpolatedData);
          }
          break;

        // HOVER: Page=target page; Object=target locator/method; Condition=optional dynamic locator params; Data=unused (STRICT)
        case 'HOVER':
          {
            actionExecutionContext = `locator.hover: [Page: ${displayValue(interpolatedPage)}]: [Object: ${displayValue(interpolatedObject)}]: [LocatorParams(Condition): ${displayValue(interpolatedCondition)}]`;
            if (conditionParams.length > 0 && conditionParams[0] === '') {
              conditionParams.length = 0;
            }
            const locator = await this.resolveStepLocator(interpolatedPage, interpolatedObject, conditionParams);
            //await locator.scrollIntoViewIfNeeded();
            await locator.hover();
            await this.takeStepScreenshot(step, stepIndex, locator);
          }
          break;

        case 'SCROLL':
          {
            const [x = '0', y = '300'] = dataParams;
            actionExecutionContext = `window.scrollBy: [X(Data): ${displayValue(x)}]: [Y(Data): ${displayValue(y)}]`;
            await this.page.evaluate(
              ([scrollX, scrollY]) => window.scrollBy(Number(scrollX), Number(scrollY)),
              [x, y]
            );
            await this.takeStepScreenshot(step, stepIndex);
          }
          break;

        // SCROLL_TO: absolute scroll — resets outer window to exact x,y coordinates.
        // Use Data=x|y (default 0|0). Useful after iframe-based pages auto-scroll on load.
        case 'SCROLL_TO':
          {
            const [x = '0', y = '0'] = dataParams;
            actionExecutionContext = `window.scrollTo: [X(Data): ${displayValue(x)}]: [Y(Data): ${displayValue(y)}]`;
            await this.page.evaluate(
              ([scrollX, scrollY]) => window.scrollTo(Number(scrollX), Number(scrollY)),
              [x, y]
            );
            await this.takeStepScreenshot(step, stepIndex);
          }
          break;
          
        // SCROLL_TO_ELEMENT: Page=target page; Object=target locator; Condition=optional dynamic locator params; Data=optional scroll behavior (auto|smooth, default: auto)
        case 'SCROLL_TO_ELEMENT':
          {
            const behavior = (interpolatedData && interpolatedData.trim() !== '') ? interpolatedData.trim() : 'auto';
            actionExecutionContext = `locator.scrollIntoViewIfNeeded / evaluate: [Page: ${displayValue(interpolatedPage)}]: [Object: ${displayValue(interpolatedObject)}]: [Behavior(Data): ${behavior}]`;
            const locator = await this.resolveStepLocator(interpolatedPage, interpolatedObject, conditionParams);
            if (behavior === 'smooth') {
              await locator.evaluate((el) => el.scrollIntoView({ behavior: 'smooth', block: 'center' }));
            } else {
              await locator.scrollIntoViewIfNeeded();
            }
            await this.takeStepScreenshot(step, stepIndex, locator);
          }
          break;

        // TYPE: Page=target page; Object=target locator; Condition=optional dynamic locator params; Data=text to type
        case 'TYPE':
          {
            actionExecutionContext = `locator.type: [Page: ${displayValue(interpolatedPage)}]: 
              [Object: ${displayValue(interpolatedObject)}]: 
              [Text(Data): ${displayValue(interpolatedData)}]`;
            const locator = await this.resolveStepLocator(interpolatedPage, interpolatedObject, conditionParams);
            await locator.focus();
            await locator.pressSequentially(interpolatedData, { delay: 100 });
            await this.takeStepScreenshot(step, stepIndex, locator);
          }
          break;

          case 'CHECK':
          {
            actionExecutionContext = `locator.setChecked: [Page: ${displayValue(interpolatedPage)}]: [Object: ${displayValue(interpolatedObject)}]: [LocatorParams(Condition): ${displayValue(interpolatedCondition)}]`;
            if (conditionParams.length > 0 && conditionParams[0] === '') {
              conditionParams.length = 0;
            }
            const locator = await this.resolveStepLocator(interpolatedPage, interpolatedObject, conditionParams);
            await locator.setChecked(true);
            await this.takeStepScreenshot(step, stepIndex, locator);
          }
          break;

          case 'UNCHECK':
          {
            actionExecutionContext = `locator.setChecked: [Page: ${displayValue(interpolatedPage)}]: [Object: ${displayValue(interpolatedObject)}]: [LocatorParams(Condition): ${displayValue(interpolatedCondition)}]`;
            if (conditionParams.length > 0 && conditionParams[0] === '') {
              conditionParams.length = 0;
            }
            const locator = await this.resolveStepLocator(interpolatedPage, interpolatedObject, conditionParams);
            await locator.setChecked(false);
            await this.takeStepScreenshot(step, stepIndex, locator);
          }
          break;
        
        // PRESS: Page=target page; Object=target locator (optional — omit for global keyboard press); Condition=optional dynamic locator params; Data=key to press
        //   Uses Playwright's native key syntax: plain key (Enter, Tab, Escape, ArrowDown) or modifier+key (Shift+Enter, Control+A, Alt+F4).
        //   Modifier combos use + not |; the | separator in Data is NOT used here.
        case 'PRESS':
          {
            if (!interpolatedData || interpolatedData.trim() === '') {
              throw new Error('PRESS requires a key name in the Data column (e.g. Enter, Tab, Escape, Shift+Enter, Control+A).');
            }
            const key = interpolatedData.trim();
            if (interpolatedObject && interpolatedObject.trim() !== '') {
              actionExecutionContext = `locator.press: [Page: ${displayValue(interpolatedPage)}]: [Object: ${displayValue(interpolatedObject)}]: [Key(Data): ${key}]`;
              const locator = await this.resolveStepLocator(interpolatedPage, interpolatedObject, conditionParams);
              await locator.press(key);
              await this.takeStepScreenshot(step, stepIndex, locator);
            } else {
              actionExecutionContext = `page.keyboard.press: [Page: ${displayValue(interpolatedPage)}]: [Key(Data): ${key}]`;
              await this.page.keyboard.press(key);
              await this.takeStepScreenshot(step, stepIndex);
            }
          }
          break;
        
          // SET_INPUT_FILES: Page=target page; Object=file input locator; Condition=optional dynamic locator params; Data=file path(s), pipe-separated for multiple files
        case 'SET_INPUT_FILES':
          {
            if (!interpolatedData || interpolatedData.trim() === '') {
                throw new Error('SET_INPUT_FILES requires one or more file paths in the Data column (use | to separate multiple files).');
            }
            const filePaths = dataParams.filter((p) => p.length > 0);
            const files = filePaths.length === 1 ? filePaths[0] : filePaths;
              actionExecutionContext = `locator.setInputFiles: [Page: ${displayValue(interpolatedPage)}]: [Object: ${displayValue(interpolatedObject)}]: [Files(Data): ${filePaths.join(' | ')}]`;
            const locator = await this.resolveStepLocator(interpolatedPage, interpolatedObject, conditionParams);
            await this.takeStepScreenshot(step, stepIndex, locator);
            await locator.setInputFiles(files);
          }
          break;
        
        // DRAG_DROP: Page=target page; Object=source locator; Condition=target locator; Data=optional options (timeout=5000|force=true)
        case 'DRAG_DROP':
          {
            if (!interpolatedCondition || interpolatedCondition.trim() === '') {
              throw new Error('DRAG_DROP requires the target locator in the Condition column.');
            }

            const timeoutMs = this.parseTimeoutFromCondition(interpolatedData);
            const forceOption = dataParams.find((part) => /^force(?:\s*[:=]\s*(true|false))?$/i.test(part));
            const forceMatch = forceOption?.match(/^force(?:\s*[:=]\s*(true|false))?$/i);
            const force = forceMatch ? (forceMatch[1] ? forceMatch[1].toLowerCase() === 'true' : true) : undefined;
            const dragOptions: { timeout?: number; force?: boolean } = {};

            if (timeoutMs !== undefined) {
              dragOptions.timeout = timeoutMs;
            }
            if (force !== undefined) {
              dragOptions.force = force;
            }

            actionExecutionContext = `locator.dragTo: [Page: ${displayValue(interpolatedPage)}]: [Source(Object): ${displayValue(interpolatedObject)}]: [Target(Condition): ${displayValue(interpolatedCondition)}]: [Options(Data): ${displayValue(interpolatedData)}]`;
            const sourceLocator = await this.resolveStepLocator(interpolatedPage, interpolatedObject);
            await this.takeStepScreenshot(step, stepIndex, sourceLocator);
            const targetLocator = await this.resolveStepLocator(interpolatedPage, interpolatedCondition);
            await sourceLocator.dragTo(targetLocator, dragOptions);
          }
          break;

        // Page/window/frame switching

        // CLICK_TO_SWITCH: Page=target page; Object=target locator/method; Condition=optional locator params; Data=timeout (STRICT - must be in Data)
        case 'CLICK_TO_SWITCH':
          {
            const timeoutMs = this.parseTimeoutFromCondition(interpolatedData) ?? 15000;
            actionExecutionContext = `click-and-wait-popup: [Page: ${displayValue(interpolatedPage)}]: [Object: ${displayValue(interpolatedObject)}]: [Timeout(Data): ${timeoutMs}ms]`;
            const locator = await this.resolveStepLocator(interpolatedPage, interpolatedObject, conditionParams);
            await this.takeStepScreenshot(step, stepIndex, locator);
            const popupPromise = this.page.context().waitForEvent('page', { timeout: timeoutMs });
            await locator.click();
            const popup = await popupPromise;
            await popup.waitForLoadState('domcontentloaded', { timeout: timeoutMs });
            this.openedPages.push(popup);
            this.currentPageIndex = this.openedPages.length - 1;
            this.syncActivePage(popup);
            console.log(`CLICK_TO_SWITCH: switched to new tab. Total pages: ${this.openedPages.length}`);
          }
          break;

        // SWITCH_CONTEXT: Page=ignored; Object=ignored; Condition=unused; Data=timeout (STRICT - must be in Data)
        case 'SWITCH_CONTEXT':
          {
            const timeoutMs = this.parseTimeoutFromCondition(interpolatedData) ?? 5000;
            actionExecutionContext = `wait-and-switch-popup: [Timeout(Data): ${timeoutMs}ms]`;
            await this.takeStepScreenshot(step, stepIndex);
            // If the popup already opened (e.g. fast page), grab it directly
            const alreadyOpen = this.page.context().pages().find((p) => !this.openedPages.includes(p));
            const popup = alreadyOpen ?? await this.page.context().waitForEvent('page', { timeout: timeoutMs });
            if (!this.openedPages.includes(popup)) {
              this.openedPages.push(popup);
            }
            this.currentPageIndex = this.openedPages.length - 1;
            this.syncActivePage(popup);
            console.log(`SWITCH_CONTEXT: switched to popup. Total pages: ${this.openedPages.length}`);
          }
          break;

        case 'SWITCH_TO_PAGE':
          {
            const pageIndexStr = interpolatedData.trim();
            actionExecutionContext = `switchToPage: [Index(Data): ${displayValue(pageIndexStr)}]: [OpenPages: ${this.openedPages.length}]`;
            await this.takeStepScreenshot(step, stepIndex);
            const pageIndex = Number(pageIndexStr);
            if (Number.isNaN(pageIndex) || pageIndex < 0 || pageIndex >= this.openedPages.length) {
              throw new Error(
                `SWITCH_TO_PAGE: invalid page index '${pageIndexStr}'. Available: 0..${this.openedPages.length - 1}`
              );
            }
            this.syncActivePage(this.openedPages[pageIndex]);
            this.currentPageIndex = pageIndex;
            console.log(`SWITCH_TO_PAGE: switched to page ${pageIndex}.`);
          }
          break;

        case 'SWITCH_TO_MAIN':
          {
            actionExecutionContext = 'switchToMainPage: [Action: execute]';
            await this.takeStepScreenshot(step, stepIndex);
            if (!this.mainPage) {
              throw new Error('SWITCH_TO_MAIN: no main page available.');
            }
            this.syncActivePage(this.mainPage);
            this.currentPageIndex = 0;
            console.log('SWITCH_TO_MAIN: switched back to main page.');
          }
          break;

        // CLOSE_TAB: closes the currently active tab and switches focus to the previous one
        case 'CLOSE_TAB':
          {
            actionExecutionContext = 'closeTab: [Action: execute]';
            await this.takeStepScreenshot(step, stepIndex);
            if (this.currentPageIndex === 0) {
              throw new Error('CLOSE_TAB: cannot close the main page (index 0). Use SWITCH_TO_PAGE or SWITCH_TO_MAIN first.');
            }
            const pageToClose = this.openedPages[this.currentPageIndex];
            this.openedPages.splice(this.currentPageIndex, 1);
            this.currentPageIndex = this.currentPageIndex - 1;
            const targetPage = this.openedPages[this.currentPageIndex];
            this.syncActivePage(targetPage);
            await pageToClose.close();
            console.log(`CLOSE_TAB: closed tab. Switched to page index ${this.currentPageIndex}. Remaining pages: ${this.openedPages.length}`);
          }
          break;

        // Waits
        case 'WAIT_FOR_SELECTOR':
          {
            const selector = (interpolatedObject || '').trim();
            actionExecutionContext = `page.waitForSelector: [Selector(Object): ${displayValue(selector)}]: [Timeout(Condition): ${displayValue(interpolatedCondition)}]: [State(Data): ${displayValue(interpolatedData)}]`;
            if (!selector) {
              throw new Error('WAIT_FOR_SELECTOR requires Object=selector');
            }

            const locator = await this.resolveStepLocator(interpolatedPage, interpolatedObject);
            const state = this.parseWaitStateFromCondition(interpolatedData) ?? 'visible';
            const timeoutMs = this.parseTimeoutFromCondition(interpolatedCondition);

            if (timeoutMs !== undefined) {
              await locator.first().waitFor({ state, timeout: timeoutMs });
            } else {
              await locator.first().waitFor({ state });
            }
            await this.takeStepScreenshot(step, stepIndex);
          }
          break;

        case 'WAIT_FOR_ELEMENT':
          {
            actionExecutionContext = `locator.waitFor: [Page: ${displayValue(interpolatedPage)}]: [Object: ${displayValue(interpolatedObject)}]: [Timeout(Condition): ${displayValue(interpolatedCondition)}]: [State(Data): ${displayValue(interpolatedData)}]`;
            const locator = await this.resolveStepLocator(interpolatedPage, interpolatedObject);
            const state = this.parseWaitStateFromCondition(interpolatedData) ?? 'visible';
            const timeoutMs = this.parseTimeoutFromCondition(interpolatedCondition);
            if (timeoutMs !== undefined) {
              await locator.waitFor({ state, timeout: timeoutMs });
            } else {
              await locator.waitFor({ state });
            }
            await this.takeStepScreenshot(step, stepIndex);
          }
          break;

        case 'WAIT_FOR_URL':
          {
            const urlPattern = this.dataContext.interpolate(interpolatedData);
            const timeoutMs = this.parseTimeoutFromCondition(interpolatedCondition);
            actionExecutionContext = `page.waitForURL: [Timeout(Condition): ${displayValue(interpolatedCondition)}]: [Url(Data): ${displayValue(urlPattern)}]`;
            if (timeoutMs !== undefined) {
              await this.page.waitForURL(new RegExp(urlPattern), { timeout: timeoutMs });
            } else {
              await this.page.waitForURL(new RegExp(urlPattern));
            }
            await this.takeStepScreenshot(step, stepIndex);
          }
          break;

        case 'WAIT_FOR_TEXT':
          {
            const waitData = this.dataContext.interpolate(interpolatedData);
            const waitParts = waitData.split('|');
            const waitOperator = waitParts.length > 1 ? waitParts.shift()?.trim().toLowerCase() : '';
            const expectedText = waitParts.join('|').trim();
            const isRegex = waitOperator === 'matches regex';
            const text = isRegex ? expectedText : waitData;
            actionExecutionContext = `waitForText: [Timeout(Condition): ${displayValue(interpolatedCondition)}]: [Matcher(Data): ${displayValue(waitData)}]: [Page: ${displayValue(interpolatedPage)}]: [Object: ${displayValue(interpolatedObject)}]`;
            if (!text) {
              throw new Error('WAIT_FOR_TEXT requires Data=text or Data=matches regex|pattern');
            }
            if (waitOperator && !isRegex) {
              throw new Error(`WAIT_FOR_TEXT: unknown matcher '${waitOperator}'. Use literal text or matches regex|pattern.`);
            }
            const timeoutMs = this.parseTimeoutFromCondition(interpolatedCondition);
            // Element mode only when Page is a real page name AND Object is a real label.
            // Empty, or 'page' in Object always triggers body scan.

            // Use element mode if both Page and Object are provided and non-empty
            const hasTarget = !!interpolatedPage && interpolatedPage.trim() !== ''
              && !!interpolatedObject && interpolatedObject.trim() !== '';

            if (hasTarget) {
              // Wait for specific element to contain literal text or match a regex.
              const locator = await this.resolveStepLocator(interpolatedPage, interpolatedObject);
              const assertion = expect(locator);
              if (isRegex) {
                const matcher = new RegExp(text);
                if (timeoutMs !== undefined) {
                  await assertion.toContainText(matcher, { timeout: timeoutMs });
                } else {
                  await assertion.toContainText(matcher);
                }
              } else if (timeoutMs !== undefined) {
                await assertion.toContainText(text, { timeout: timeoutMs });
              } else {
                await assertion.toContainText(text);
              }
              await this.takeStepScreenshot(step, stepIndex, locator);
            } else {
              // Fall back to full-body search using the same literal/regex matcher.
              if (isRegex) {
                const matcher = new RegExp(text);
                if (timeoutMs !== undefined) {
                  await this.page.waitForFunction(
                    ({ pattern, flags }) => new RegExp(pattern, flags).test(document.body.innerText),
                    { pattern: matcher.source, flags: matcher.flags },
                    { timeout: timeoutMs }
                  );
                } else {
                  await this.page.waitForFunction(
                    ({ pattern, flags }) => new RegExp(pattern, flags).test(document.body.innerText),
                    { pattern: matcher.source, flags: matcher.flags }
                  );
                }
              } else if (timeoutMs !== undefined) {
                await this.page.waitForFunction(
                  (searchText) => document.body.innerText.includes(searchText),
                  text,
                  { timeout: timeoutMs }
                );
              } else {
                await this.page.waitForFunction(
                  (searchText) => document.body.innerText.includes(searchText),
                  text
                );
              }
              await this.takeStepScreenshot(step, stepIndex);
            }
          }
          break;

        case 'WAIT_FOR_LOAD':
          {
            // Condition carries timeout. Data carries load-state token.
            const stateToken = (interpolatedData || 'load').trim().toLowerCase();
            actionExecutionContext = `page.waitForLoadState: [Timeout(Condition): ${displayValue(interpolatedCondition)}]: [State(Data): ${displayValue(stateToken)}]`;
            const state = (['load', 'domcontentloaded', 'networkidle'].includes(stateToken)
              ? stateToken
              : 'load') as 'load' | 'domcontentloaded' | 'networkidle';
            const timeoutMs = this.parseTimeoutFromCondition(interpolatedCondition);

            if (timeoutMs !== undefined) {
              await this.page.waitForLoadState(state, { timeout: timeoutMs });
            } else {
              await this.page.waitForLoadState(state);
            }
            await this.takeStepScreenshot(step, stepIndex);
          }
          break;

        case 'WAIT_TIME':
          {
            // WAIT_TIME reads duration from Condition (e.g. "500" or "timeout=500"). Data is unused.
            const ms = this.parseTimeoutFromCondition(interpolatedCondition) ?? 1000;
            actionExecutionContext = `page.waitForTimeout: [Duration(Condition): ${ms}ms]`;
            await this.page.waitForTimeout(ms);
            await this.takeStepScreenshot(step, stepIndex);
          }
          break;

        // Assertions
        // ASSERT|SOFTASSERT: Page=target page; Object=target locator; Condition=state matcher; Data=timeout
        // Removed backward-compat fallback; state must be in Condition. Timeout is optional in Data.
        // ASSERT: Page=target page; Object=target locator; Condition=optional dynamic locator params; Data=state token (required)
        case 'ASSERT':
        case 'SOFTASSERT':
          {
            actionExecutionContext = `assertElementState: [Page: ${displayValue(interpolatedPage)}]: [Object: ${displayValue(interpolatedObject)}]: [LocatorParams(Condition): ${displayValue(interpolatedCondition)}]: [State(Data): ${displayValue(interpolatedData)}]`;
            const assertion = step.action.toUpperCase().startsWith('SOFT') ? expect.soft : expect;
            const locator = await this.resolveStepLocator(interpolatedPage, interpolatedObject, conditionParams);
            const state = interpolatedData
              .trim()
              .toLowerCase()
              .replace(/\s+/g, ' ');

            if (!state) {
              throw new Error(`ASSERT requires Data=state matcher (${CSVTestRunner.ASSERT_STATE_TOKENS.join(', ')}).`);
            }
            if (!CSVTestRunner.ASSERT_STATE_TOKENS.includes(state)) {
              throw new Error(`ASSERT: unknown state "${state}". Supported: ${CSVTestRunner.ASSERT_STATE_TOKENS.join(', ')}`);
            }

            await this.runStateMatch(assertion, locator, state);
            // Don't highlight element for screenshot if assertion is about absence or hidden state
            switch (state) {
              case 'is not visible':
              case 'is hidden':      
              case 'is not present':
              case 'is absent':      await this.takeStepScreenshot(step, stepIndex); break;
              default:
                await this.takeStepScreenshot(step, stepIndex, locator);
            }
            
          }
          break;

        // ASSERT_URL: Page=ignored; Object=ignored; Condition=unused; Data=URL regex pattern
        case 'ASSERT_URL':
        case 'SOFTASSERT_URL':
          {
            actionExecutionContext = `assertUrl: [Url(Data): ${displayValue(interpolatedData)}]`;
            const assertion = step.action.toUpperCase().startsWith('SOFT') ? expect.soft : expect;
            const expectedUrl = this.dataContext.interpolate(interpolatedData);
            await assertion(this.page).toHaveURL(new RegExp(expectedUrl));
            await this.takeStepScreenshot(step, stepIndex);
          }
          break;

        // ASSERT_TEXT: compare element textContent.
        // Condition=optional dynamic locator params; Data=operator|expectedText (operator optional, defaults to contains).
        case 'ASSERT_TEXT':
        case 'SOFTASSERT_TEXT':
          {
            actionExecutionContext = `assertText: [Page: ${displayValue(interpolatedPage)}]: [Object: ${displayValue(interpolatedObject)}]: [LocatorParams(Condition): ${displayValue(interpolatedCondition)}]: [OperatorAndText(Data): ${displayValue(interpolatedData)}]`;
            const assertion = step.action.toUpperCase().startsWith('SOFT') ? expect.soft : expect;
            const locator = await this.resolveStepLocator(interpolatedPage, interpolatedObject, conditionParams);
            const [rawTextOp = '', ...txtParts] = dataParams;
            const rawTextToken = rawTextOp.trim();
            const op = txtParts.length > 0 ? (rawTextToken.toLowerCase() || 'contains') : 'contains';
            const txt = txtParts.length > 0 ? txtParts.join('|').trim() : rawTextToken;

            // Uses Playwright's locator-based expect matchers where possible so
            // they auto-retry until the condition is met (avoids flakiness from
            // reading textContent once before the page finishes updating).
            await this.runTextOrValueMatch(assertion, locator, 'text', op, txt, 'ASSERT_TEXT');
            await this.takeStepScreenshot(step, stepIndex, locator);
          }
          break;

        // ASSERT_VALUE: compare form input value.
        // Condition=optional dynamic locator params; Data=operator|expectedValue (operator optional, defaults to equals).
        case 'ASSERT_VALUE':
        case 'SOFTASSERT_VALUE':
          {
            actionExecutionContext = `assertValue: [Page: ${displayValue(interpolatedPage)}]: [Object: ${displayValue(interpolatedObject)}]: [LocatorParams(Condition): ${displayValue(interpolatedCondition)}]: [OperatorAndValue(Data): ${displayValue(interpolatedData)}]`;
            const assertion = step.action.toUpperCase().startsWith('SOFT') ? expect.soft : expect;
            const locator = await this.resolveStepLocator(interpolatedPage, interpolatedObject, conditionParams);
            const [rawValOp = '', ...valParts] = dataParams;
            const rawValToken = rawValOp.trim();
            const op = valParts.length > 0 ? (rawValToken.toLowerCase() || 'equals') : 'equals';
            const val = valParts.length > 0 ? valParts.join('|').trim() : rawValToken;

            await this.runTextOrValueMatch(assertion, locator, 'value', op, val, 'ASSERT_VALUE');
            await this.takeStepScreenshot(step, stepIndex, locator);
          }
          break;

        // ASSERT_COUNT: compare element count.
        // Condition=optional dynamic locator params; Data=operator|count (e.g. equals|5, greater than|3).
        case 'ASSERT_COUNT':
        case 'SOFTASSERT_COUNT':
          {
            actionExecutionContext = `assertCount: [Page: ${displayValue(interpolatedPage)}]: [Object: ${displayValue(interpolatedObject)}]: [LocatorParams(Condition): ${displayValue(interpolatedCondition)}]: [OperatorAndCount(Data): ${displayValue(interpolatedData)}]`;
            const assertion = step.action.toUpperCase().startsWith('SOFT') ? expect.soft : expect;
            const locator = await this.resolveStepLocator(interpolatedPage, interpolatedObject, conditionParams);
            const [rawCountOp = '', ...numParts] = dataParams;
            const rawCountToken = rawCountOp.trim();
            const op = numParts.length > 0 ? (rawCountToken.toLowerCase() || 'equals') : 'equals';
            const numStr = numParts.length > 0 ? numParts.join('|').trim() : rawCountToken;

            if (!numStr) {
              throw new Error('ASSERT_COUNT requires Data=operator|count (e.g. equals|5, greater than|3)');
            }

            const n = Number(numStr);
            if (Number.isNaN(n)) throw new Error(`ASSERT_COUNT: expected a numeric value, got "${numStr}"`);
            const count = await locator.count();
            switch (op) {
              case 'equals':                assertion(count).toBe(n); break;
              case 'not equals':            assertion(count).not.toBe(n); break;
              case 'greater than':          assertion(count).toBeGreaterThan(n); break;
              case 'greater than or equal': assertion(count).toBeGreaterThanOrEqual(n); break;
              case 'less than':             assertion(count).toBeLessThan(n); break;
              case 'less than or equal':    assertion(count).toBeLessThanOrEqual(n); break;
              default:
                throw new Error(`ASSERT_COUNT: unknown operator "${op}". Supported: equals, not equals, >, >=, <, <=`);
            }
            await this.takeStepScreenshot(step, stepIndex, locator);
          }
          break;

        // ASSERT_ATTRIBUTE: Condition=optional dynamic locator params; Data=attributeName|expectedValue (pipe-separated, both required)
        case 'ASSERT_ATTRIBUTE':
        case 'SOFTASSERT_ATTRIBUTE':
          {
            actionExecutionContext = `assertAttribute: [Page: ${displayValue(interpolatedPage)}]: [Object: ${displayValue(interpolatedObject)}]: [LocatorParams(Condition): ${displayValue(interpolatedCondition)}]: [AttrAndValue(Data): ${displayValue(interpolatedData)}]`;
            const assertion = step.action.toUpperCase().startsWith('SOFT') ? expect.soft : expect;
            const [attrName = '', ...attrValueParts] = dataParams;
            const attribute = attrName.trim();
            const value = attrValueParts.join('|').trim();

            if (!attribute) {
              throw new Error('ASSERT_ATTRIBUTE requires Data=attributeName|expectedValue (pipe-separated)');
            }

            const locator = await this.resolveStepLocator(interpolatedPage, interpolatedObject, conditionParams);
            if (value === 'present') {
              await assertion(locator).toHaveAttribute(attribute);
            } else if ((value === 'absent') || (value === 'not present')) {
              await assertion(locator).not.toHaveAttribute(attribute);
            } else {
              const regex = new RegExp(value);
            await assertion(locator).toHaveAttribute(attribute, regex);
            }
            await this.takeStepScreenshot(step, stepIndex, locator);
          }
          break;

        // ASSERT_CSS: assert a computed CSS property value on an element (uses toHaveCSS — auto-retries until match or timeout).
        // Page=page class; Object=element; Condition=dynamic locator params (optional); Data=cssProperty|expectedValue (|timeout optional)
        case 'ASSERT_CSS':
        case 'SOFTASSERT_CSS':
          {
            actionExecutionContext = `assertCss: [Page: ${displayValue(interpolatedPage)}]: [Object: ${displayValue(interpolatedObject)}]: [LocatorParams(Condition): ${displayValue(interpolatedCondition)}]: [PropertyAndValue(Data): ${displayValue(interpolatedData)}]`;
            const assertion = step.action.toUpperCase().startsWith('SOFT') ? expect.soft : expect;
            const [cssPropertyRaw = '', cssValueRaw = '', timeoutRaw = ''] = dataParams;
            const cssProperty = cssPropertyRaw.trim();
            const cssValue = cssValueRaw.trim();
            const timeoutMs = this.parseTimeoutFromCondition(timeoutRaw.trim());

            if (!cssProperty) {
              throw new Error(
                'ASSERT_CSS requires Data=cssProperty|expectedValue (pipe-separated). Example: background-color|rgb(95, 223, 138)'
              );
            }
            if (!cssValue) {
              throw new Error(
                'ASSERT_CSS requires Data=cssProperty|expectedValue. Expected value is missing.'
              );
            }

            const locator = await this.resolveStepLocator(interpolatedPage, interpolatedObject, conditionParams);
            const assertOptions = timeoutMs !== undefined ? { timeout: timeoutMs } : {};
            await assertion(locator).toHaveCSS(cssProperty, cssValue, assertOptions);
            await this.takeStepScreenshot(step, stepIndex, locator);
          }
          break;

        // ASSERT_SCREENSHOT: Page=scope; Object=locator optional; Condition=optional screenshot options; Data=snapshot name
        case 'ASSERT_SCREENSHOT':
        case 'SOFTASSERT_SCREENSHOT':
        case 'CAPTURE_SCREENSHOT':
          {
            const assertion = step.action.toUpperCase().startsWith("SOFT") ? expect.soft : expect;
            const snapshotName = (interpolatedData || "").trim();
            if (!snapshotName) {
              throw new Error(`[Step: ${stepIndex}] ${actionNameUpper} requires Data=snapshot name.`);
            }
            const { maskSelectors, ...baseScreenshotOptions } =
              this.parseScreenshotOptions(conditionParams);

            // Build mask locators from CSS selectors if provided; colour is fixed
            const maskLocators =
              maskSelectors && maskSelectors.length > 0
                ? maskSelectors.map((sel) => this.page.locator(sel))
                : undefined;
            const resolvedScreenshotOptions = {
              ...baseScreenshotOptions,
              ...(maskLocators ? { mask: maskLocators, maskColor: "#FF00FF" } : {}),
            };

            actionExecutionContext = `${actionNameUpper}: [Page: ${displayValue(interpolatedPage)}]: 
              [Object: ${displayValue(interpolatedObject)}]: [Options(Condition): ${displayValue(interpolatedCondition)}]: 
              [Snapshot(Data): ${snapshotName}]`;
            
            // Get full path for the file
            const resolvedSnapshotFile = test
              .info()
              .snapshotPath(snapshotName, { kind: "screenshot" });
            const resolvedSnapshotFolder = path.dirname(resolvedSnapshotFile);
            const resolvedSnapshotFileWithFullPath = path.join(
              resolvedSnapshotFolder,
              ...snapshotName.split(/[\\/]+/),
            );

            // If action is ASSERT_SCREENSHOT or SOFTASSERT_SCREENSHOT, 
            // check that the snapshot file exists; if not, throw an error.
            if (!step.action.toUpperCase().startsWith("CAPTURE_SCREENSHOT")) {
              if (!fs.existsSync(resolvedSnapshotFileWithFullPath)) {
                throw new Error(
                  `[Step: ${stepIndex}] ${actionNameUpper} screenshot file not found at: '${resolvedSnapshotFileWithFullPath.replace(/\\/g, "/")}'.`,
                );
              }
            } else {
              // For CAPTURE_SCREENSHOT, delete existing file if it exists, so that Playwright will create a new one
              if (fs.existsSync(resolvedSnapshotFileWithFullPath)) {
                fs.unlinkSync(resolvedSnapshotFileWithFullPath);
                console.info(
                  `[Step: ${stepIndex}] CAPTURE_SCREENSHOT: deleted existing screenshot file at "${resolvedSnapshotFileWithFullPath}"`,
                );
              }
            }

            const hasTargetObject = !!interpolatedObject && interpolatedObject.trim() !== "";
            const arraySnapshot = snapshotName.split("/");

            if (hasTargetObject) {
              const locator = await this.resolveStepLocator(interpolatedPage, interpolatedObject);
              await assertion(locator).toHaveScreenshot(arraySnapshot, resolvedScreenshotOptions);
              await this.takeStepScreenshot(step, stepIndex, locator);
            } else {
              await assertion(this.page).toHaveScreenshot(arraySnapshot, resolvedScreenshotOptions);
              await this.takeStepScreenshot(step, stepIndex);
            }
          }
          break;

        // ASSERT_ARIASNAPSHOT/SOFTASSERT_ARIASNAPSHOT: Assert against an aria snapshot file resolved by Playwright config.
        // Page=target page; Object=target locator (optional — omit for full body); Condition=locator params; Data=output file path (relative to snapshotDir)
        // CAPTURE_ARIA: Capture the current aria snapshot of a locator (or full page) to a .aria.yaml file. 
        // Run once to record, then switch to ASSERT_ARIASNAPSHOT/SOFTASSERT_ARIASNAPSHOT for regression.
        case 'ASSERT_ARIASNAPSHOT':
        case 'SOFTASSERT_ARIASNAPSHOT': 
        case 'CAPTURE_ARIASNAPSHOT': {
          const snapshotName = (interpolatedData || '').trim();
          if (!snapshotName) {
            throw new Error(`[Step: ${stepIndex}] [Required Field] Data = output file name with file path (relative to snapshotDir)
              (e.g. setup-account/AccountDetailsSection-ML.aria.yaml), use subfolders per screen.`);
          }

          // Resolve the snapshot path
          const resolvedSnapshotFile = test.info().snapshotPath(snapshotName, { kind: 'aria' });
          const resolvedSnapshotFolder = path.dirname(resolvedSnapshotFile);
          const resolvedSnapshotFileWithFullPath = path.join(resolvedSnapshotFolder, ...snapshotName.split(/[\\/]+/));
          console.info(`[Step: ${stepIndex}] ARIASNAPSHOT: resolved output path to "${resolvedSnapshotFileWithFullPath}"`);
          
          if(!step.action.toUpperCase().startsWith('CAPTURE')) {
            if(!fs.existsSync(resolvedSnapshotFileWithFullPath)) {
              throw new Error(`[Step: ${stepIndex}] ASSERT_ARIASNAPSHOT baseline snapshot file not found at: '${resolvedSnapshotFileWithFullPath.replace(/\\/g, '/')}'.`);
            }
            const assertion = step.action.toUpperCase().startsWith('SOFT') ? expect.soft : expect;
            actionExecutionContext = `assertAriaSnapshot: [Page: ${displayValue(interpolatedPage)}]: 
              [Object: ${displayValue(interpolatedObject)}]: [Options(Condition): ${displayValue(interpolatedCondition)}]: 
              [Snapshot(Data): ${snapshotName}]`;
            const rawYaml = fs.readFileSync(resolvedSnapshotFileWithFullPath, 'utf-8');
            const interpolatedYaml = this.dataContext.interpolate(rawYaml);
            // Fix snapshots that were accidentally saved with JSON-style escaping.
            const normalizedYaml = interpolatedYaml.replace(/\\(["'])/g, "$1");
            console.info(`[Step: ${stepIndex}] ARIASNAPSHOT normalized content: \n${normalizedYaml}`);
            const locator = await this.resolveStepLocator(interpolatedPage, interpolatedObject, conditionParams);
            await locator.scrollIntoViewIfNeeded();
            await assertion(locator).toMatchAriaSnapshot(normalizedYaml);
            await this.takeStepScreenshot(step, stepIndex, locator);
          } 
          else {
            actionExecutionContext = `captureAria: [Page: ${displayValue(interpolatedPage)}]: [Object: ${displayValue(interpolatedObject)}]: [Output(Data): ${snapshotName}]`;
            const hasTarget = !!interpolatedObject && interpolatedObject.trim() !== '';
            const locator = hasTarget
              ? await this.resolveStepLocator(interpolatedPage, interpolatedObject, conditionParams)
              : this.page.locator('body');
            const yamlContent = await locator.ariaSnapshot(); // capture the ARIA snapshot of the target locator (or full page if no locator)
            console.info(`[Step: ${stepIndex}] CAPTURE_ARIA: captured aria snapshot for "${snapshotName}"`);
            console.info(`[Step: ${stepIndex}] ARIASNAPSHOT content: \n${yamlContent}`);
            // Write the contents into a file, creating directories as needed
            fs.mkdirSync(path.dirname(resolvedSnapshotFileWithFullPath), { recursive: true });
            // Write to file and overrride the contents if file exists (flag 'w' instead of 'wx')
            fs.writeFileSync(resolvedSnapshotFileWithFullPath, yamlContent, { encoding: 'utf-8', flag: 'w' });
            await this.takeStepScreenshot(step, stepIndex, hasTarget ? locator : undefined);
          }
        }
        break;

        case 'ASSERT_SNAPSHOT':
        case 'SOFTASSERT_SNAPSHOT':
          {
            const assertion = step.action.toUpperCase().startsWith('SOFT') ? expect.soft : expect;
            const snapshotName = (interpolatedData || '').trim();
            if (!snapshotName) {
              throw new Error('ASSERT_SNAPSHOT requires Data=snapshot name.');
            }

            const sourceToken = (interpolatedCondition || '').trim().toLowerCase();
            const source = (sourceToken === '' ? 'text' : sourceToken) as 'text' | 'html' | 'value';
            if (!['text', 'html', 'value'].includes(source)) {
              throw new Error('ASSERT_SNAPSHOT requires Condition=text, html, or value.');
            }
            actionExecutionContext = `assertSnapshot: [Page: ${displayValue(interpolatedPage)}]: [Object: ${displayValue(interpolatedObject)}]: [Options(Condition): ${displayValue(interpolatedCondition)}]: [Snapshot(Data): ${snapshotName}]`;
            const hasTargetObject = !!interpolatedObject && interpolatedObject.trim() !== '';

            let snapshotContent = '';
            if (hasTargetObject) {
              const locator = await this.resolveStepLocator(interpolatedPage, interpolatedObject);
              switch (source) {
                case 'html':
                  snapshotContent = await locator.innerHTML();
                  break;
                case 'value':
                  snapshotContent = await locator.inputValue();
                  break;
                case 'text':
                default:
                  snapshotContent = await locator.innerText();
                  break;
              }
            } else {
              switch (source) {
                case 'html':
                  snapshotContent = await this.page.locator('body').innerHTML();
                  break;
                case 'value':
                  throw new Error('ASSERT_SNAPSHOT with source=value requires Object=target locator.');
                case 'text':
                default:
                  snapshotContent = await this.page.locator('body').innerText();
                  break;
              }
            }
            await this.takeStepScreenshot(step, stepIndex);
            assertion(snapshotContent).toMatchSnapshot(snapshotName);
          }
          break;

        /**
         * FETCH_DATA - Reads text/attribute/count from a locator (or a parameterized locator
         * method on the page object) and stores the result as a runtime variable for later steps.
         *
         * @param Page - target page class (must be registered in pageFactories)
         * @param Object - locator property, raw selector, or a page-object method that returns a Locator
         * @param Condition - optional pipe-separated args forwarded to Object when it is a method
         *   (e.g. Condition=${dunsNumber}|Name resolves getCellByDunsNumber(dunsNumber, "Name"))
         * @param Data - storeKey, or mode|storeKey
         *   - storeKey      → reads locator.innerText() (default mode)
         *   - mode|storeKey → mode is one of: innertext, textcontent, count, or any attribute name
         * @example
         * ```csv
         * 1,Y,FETCH_DATA,AccountSummaryPage,//div[.//label[normalize-space(.)='Account Number']]/p,,accountId
         * Y,14,FETCH_DATA,SetupAccountPage,getCellByDunsNumber,${dunsNumber1} | Name,textContent | accountName
         * ```
         *
         * Example: Data=textContent|accountName stores the element's textContent under rt_accountName.
         * Stored runtime key is normalized to rt_<key> and readable via ${rt_<key>} in later steps.
         */
        case 'FETCH_DATA':
          {
            if (conditionParams.length > 0 && conditionParams[0] === '') {
              conditionParams.length = 0;
            }

            // Two pipe-separated Data segments => [mode, storeKey]; a single segment => storeKey only (mode defaults to innerText).
            const hasModeToken = dataParams.length >= 2;
            const modeTokenRaw = hasModeToken ? dataParams[0] : '';
            const modeToken = modeTokenRaw.toLowerCase();
            const storeKey = hasModeToken ? dataParams[1] : dataParams[0] || '';

            if (!storeKey.trim()) {
              throw new Error('FETCH_DATA requires Data=storeKey or Data=mode|storeKey. Example: Data=username or Data=count|rowCount.');
            }

            actionExecutionContext = `fetchData: [Page: ${displayValue(interpolatedPage)}]: 
            [Object: ${displayValue(interpolatedObject)}]: 
            [LocatorParams(Condition): ${displayValue(interpolatedCondition)}]: 
            [FetchMode(Data): ${displayValue(modeTokenRaw || "innerText(default)")}]: 
            [StoreKey(Data): ${displayValue(storeKey)}]`;
            const locator = await this.resolveStepLocator(interpolatedPage, interpolatedObject, conditionParams);
            await this.takeStepScreenshot(step, stepIndex, locator);

            const value = !modeToken || modeToken === 'innertext'
              ? await locator.innerText()
              : modeToken === 'textcontent'
                ? (await locator.textContent()) ?? ''
                : modeToken === 'count'
                  ? await locator.count()
                  : (await locator.getAttribute(modeTokenRaw)) ?? '';

            this.dataContext.storeValueWithRuntimePrefix(storeKey, value);
          }
          break;

        case 'READ_DATA':
          {
            const source = interpolatedObject.trim();
            const scenarioSelector = interpolatedData.trim();
            const pageValue = interpolatedPage.trim();
            actionExecutionContext = `readData: [Source(Object): ${displayValue(source)}]: [Scenario(Data): ${displayValue(scenarioSelector)}]: [Page(ignored): ${displayValue(pageValue)}]`;
            if (pageValue) {
              throw new Error(
                `READ_DATA does not use Page column. Received Page='${pageValue}'. ` +
                  `Expected format: READ_DATA,,dataSource,scenarioName`
              );
            }

            if (!source) {
              throw new Error(
                'READ_DATA requires Object=dataSource. Expected format: READ_DATA,,dataSource,scenarioName'
              );
            }

            if (!scenarioSelector) {
              throw new Error(
                'READ_DATA requires Data=scenarioName. Use RUN_FLOW with Object/Data for ALL or multi-scenario iteration.'
              );
            }

            const selectorLower = scenarioSelector.toLowerCase();
            if (selectorLower === 'all' || scenarioSelector.includes('|') || scenarioSelector.includes('...')) {
              if (stepIndex === 1) {
                throw new Error(
                  `READ_DATA with '${scenarioSelector}' at step 1 is reserved for scenario expansion in csv-tests-driver.spec.ts. ` +
                    `For runtime execution, use a single scenario name in Data.`
                );
              }

              throw new Error(
                `READ_DATA with '${scenarioSelector}' is only valid at step 1 for scenario expansion. ` +
                  `This step is at position ${stepIndex}. Use a single scenario name in Data for runtime fetch.`
              );
            }

            const data = this.dataContext.getTestData(source, { scenario: scenarioSelector });

            if (!data) {
              throw new Error(
                `READ_DATA could not find scenario '${scenarioSelector}' in data source '${source}'.`
              );
            }

            Object.entries(data).forEach(([key, value]) => {
              this.dataContext.storeValue(key, value);
            });
          }
          break;
        
        case 'SET_DATA':
          {
            // Condition: key or pipe-separated keys, Data: value or pipe-separated values
            const keys = interpolatedCondition.split('|').map(k => k.trim()).filter(Boolean);
            const values = interpolatedData.split('|').map(v => v.trim());
            if (keys.length === 0) {
              throw new Error('SET action requires Condition=key or Condition=key1|key2 and Data=value or value1|value2.');
            }
            if (keys.length > 1) {
              if (values.length !== keys.length) {
                throw new Error(`SET_DATA action: Number of keys (${keys.length}) does not match number of values (${values.length}).`);
              }
              for (let i = 0; i < keys.length; i++) {
                this.dataContext.storeValue(keys[i], values[i]);
              }
              actionExecutionContext = `setValues: [Keys(Condition): ${displayValue(interpolatedCondition)}]: [Values(Data): ${displayValue(interpolatedData)}]`;
            } else {
              this.dataContext.storeValue(keys[0], values[0]);
              actionExecutionContext = `setValue: [Key(Condition): ${displayValue(interpolatedCondition)}]: [Value(Data): ${displayValue(values[0])}]`;
            }
          }
          break;

        case 'WRITE_DATA': 
          {
            // Object: data sheet name, Condition: column name, Data: scenario name, Page: value to write
            // Example usage:
            // | run | step | action     | page      | object           | condition         | data                   |
            // | Y   | 1    | WRITE_DATA | new_value | login_scenarios  | expected_error    | standard_user_success   |
            // This will set expected_error for scenario 'standard_user_success' in login_scenarios.csv to 'new_value'.
            const dataSheet = interpolatedObject.trim();
            const columnName = interpolatedCondition.trim();
            const scenarioName = interpolatedData.trim();
            const valueToWrite = interpolatedPage.trim();
            actionExecutionContext = `writeData: [Sheet(Object): ${displayValue(dataSheet)}]: [Column(Condition): ${displayValue(columnName)}]: [Scenario(Data): ${displayValue(scenarioName)}]: [Value(Page): ${displayValue(valueToWrite)}]`;
            await this.dataContext.writeDataToCsv(valueToWrite, dataSheet, scenarioName, columnName, this.testDataRootDir);
          }
          break;

        // Reusable flow execution from another CSV file.
        // CALL_TEST resolves only from test-scripts/.
        // RUN_FLOW: flowRef(Page), dataSource(Object), selector(Data), inlineVarKeys(Condition)
        // Modes: simple | datatable(Object+Data) | inline vars(Condition+Data)
        case 'RUN_FLOW':
          {
            const flowRef = interpolatedPage.trim();
            const dataSource = interpolatedObject.trim();
            const dataSelector = interpolatedData.trim();
            const inlineVarKeys = interpolatedCondition.trim();
            // Determine mode: inline variables vs datatable scenarios
            const hasInlineVars = inlineVarKeys.length > 0;
            const hasDataSource = dataSource.length > 0;
            const hasDataSelector = dataSelector.length > 0;
            if (!flowRef) {
              throw new Error('RUN_FLOW requires Page=flowRef. Expected: RUN_FLOW,flowRef,, or RUN_FLOW,flowRef,dataSource,selector or RUN_FLOW,flowRef,,varKeys,varValues');
            }
            if (hasInlineVars && hasDataSource) {
              throw new Error('RUN_FLOW cannot use both inline variables (Condition) and datatable scenarios (Object). Use either of them.');
            }
            // Validate Object+Data together only in datatable mode (when not using inline vars)
            if (!hasInlineVars && hasDataSource !== hasDataSelector) {
              throw new Error(`RUN_FLOW requires DataSource (object) and Scenario (data) together for scenario iteration. Received Object='${dataSource}', Data='${dataSelector}'.`);
            }

            // Apply inline variables if Condition is provided
            if (inlineVarKeys) {
              const keys = inlineVarKeys.split('|').map(k => k.trim()).filter(Boolean);
              const values = dataSelector.split('|').map(v => v.trim());
              if (!keys.length) {
                throw new Error('RUN_FLOW inline variables: Condition column must contain key or pipe-separated keys.');
              }
              if (keys.length > 1 && values.length !== keys.length) {
                throw new Error(`RUN_FLOW inline variables: Number of Keys (${keys.length}) doesn't match Number of Values (${values.length})`);
              }
              keys.forEach((k, i) => this.dataContext.storeValue(k, keys.length === 1 ? values[0] : values[i]));
              actionExecutionContext = `runFlow: [FlowRef: ${displayValue(flowRef)}]: [InlineVars(Condition): ${displayValue(inlineVarKeys)}]: [Values(Data): ${displayValue(dataSelector)}]`;
              await this.executeFlow(flowRef, 'flows', stepIndex);
            } else if (hasDataSource) {
              actionExecutionContext = `runFlow: [FlowRef: ${displayValue(flowRef)}]: [DataSource: ${displayValue(dataSource)}]: [Selector: ${displayValue(dataSelector)}]`;
              await this.executeFlowForDataScenarios(flowRef, dataSource, dataSelector, 'flows', stepIndex);
            } else {
              actionExecutionContext = `runFlow: [FlowRef: ${displayValue(flowRef)}]`;
              await this.executeFlow(flowRef, 'flows', stepIndex);
            }
          }
          break;

        case 'CALL_TEST':
          {
            actionExecutionContext = `callTest: [TestRef(Page): ${displayValue(interpolatedPage)}]`;
            await this.takeStepScreenshot(step, stepIndex);
            await this.executeFlow(interpolatedPage.trim(), 'tests', stepIndex);
          }
          break;

        // API testing actions based on 3-source model:
        // 1) api_endpoints.csv (service + endpointKey)
        // 2) api_headers.csv (header scenario)
        // 3) payload JSON files under test-data/payloads/
        case 'API_GET':
          {
            actionExecutionContext = `apiRequest(GET): [Service(Page): ${displayValue(interpolatedPage)}]: [Endpoint(Object): ${displayValue(interpolatedObject)}]: [HeaderScenario(Condition): ${displayValue(interpolatedCondition)}]: [PayloadOrParams(Data): ${displayValue(interpolatedData)}]`;
            await this.executeApiRequest('GET', interpolatedPage.trim(), interpolatedObject.trim(), interpolatedCondition.trim(), interpolatedData.trim());
          }
          break;

        case 'API_POST':
          {
            actionExecutionContext = `apiRequest(POST): [Service(Page): ${displayValue(interpolatedPage)}]: [Endpoint(Object): ${displayValue(interpolatedObject)}]: [HeaderScenario(Condition): ${displayValue(interpolatedCondition)}]: [PayloadOrParams(Data): ${displayValue(interpolatedData)}]`;
            await this.executeApiRequest('POST', interpolatedPage.trim(), interpolatedObject.trim(), interpolatedCondition.trim(), interpolatedData.trim());
          }
          break;

        case 'API_PUT':
          {
            actionExecutionContext = `apiRequest(PUT): [Service(Page): ${displayValue(interpolatedPage)}]: [Endpoint(Object): ${displayValue(interpolatedObject)}]: [HeaderScenario(Condition): ${displayValue(interpolatedCondition)}]: [PayloadOrParams(Data): ${displayValue(interpolatedData)}]`;
            await this.executeApiRequest('PUT', interpolatedPage.trim(), interpolatedObject.trim(), interpolatedCondition.trim(), interpolatedData.trim());
          }
          break;

        case 'API_PATCH':
          {
            actionExecutionContext = `apiRequest(PATCH): [Service(Page): ${displayValue(interpolatedPage)}]: [Endpoint(Object): ${displayValue(interpolatedObject)}]: [HeaderScenario(Condition): ${displayValue(interpolatedCondition)}]: [PayloadOrParams(Data): ${displayValue(interpolatedData)}]`;
            await this.executeApiRequest('PATCH', interpolatedPage.trim(), interpolatedObject.trim(), interpolatedCondition.trim(), interpolatedData.trim());
          }
          break;

        case 'API_DELETE':
          {
            actionExecutionContext = `apiRequest(DELETE): [Service(Page): ${displayValue(interpolatedPage)}]: [Endpoint(Object): ${displayValue(interpolatedObject)}]: [HeaderScenario(Condition): ${displayValue(interpolatedCondition)}]: [PayloadOrParams(Data): ${displayValue(interpolatedData)}]`;
            await this.executeApiRequest('DELETE', interpolatedPage.trim(), interpolatedObject.trim(), interpolatedCondition.trim(), interpolatedData.trim());
          }
          break;

        // API_ASSERT_STATUS|API_SOFTASSERT_STATUS: Data=operator|expectedStatus (operator optional, defaults to equals).
        // Example: Data=200  OR  Data=equals|200  OR  Data=>=|200
        case 'API_ASSERT_STATUS':
        case 'API_SOFTASSERT_STATUS':
          {
            actionExecutionContext = `apiAssertStatus: [OperatorAndStatus(Data): ${displayValue(interpolatedData)}]`;
            const assertion = step.action.toUpperCase().includes('SOFT') ? expect.soft : expect;
            const [rawStatusOp = '', ...statusParts] = dataParams;
            const rawStatusToken = rawStatusOp.trim().toLowerCase();
            const op = statusParts.length > 0 ? (rawStatusToken || 'equals') : 'equals';
            const numStr = statusParts.length > 0 ? statusParts.join('|').trim() : rawStatusToken;

            const expected = Number(numStr);
            const actual = Number(this.dataContext.getValue('last_response_status'));
            const responseBody = this.dataContext.getValue('last_response_body');
            const responseRecord = responseBody && typeof responseBody === 'object' && !Array.isArray(responseBody)
              ? responseBody as Record<string, unknown>
              : undefined;
            const problemDetails = responseRecord
              ? Object.fromEntries(['title', 'detail', 'errors', 'message', 'traceId']
                .filter((key) => responseRecord[key] !== undefined)
                .map((key) => [key, responseRecord[key]]))
              : undefined;
            const responseText = typeof responseBody === 'string'
              ? responseBody
              : JSON.stringify(problemDetails && Object.keys(problemDetails).length > 0 ? problemDetails : responseBody, null, 2);
            const assertionMessage = responseText
              ? `API response body:\n${responseText.slice(0, 4000)}`
              : 'API response body is empty.';

            if (Number.isNaN(expected) || Number.isNaN(actual)) {
              throw new Error(
                `API_ASSERT_STATUS expects numeric status. Actual='${this.dataContext.getValue('last_response_status')}', Expected='${numStr}'`
              );
            }

            switch (op) {
              case 'equals':
              case '==':
                assertion(actual, assertionMessage).toBe(expected);
                break;
              case 'not equals':
              case '!=':
                assertion(actual, assertionMessage).not.toBe(expected);
                break;
              case '>':
                assertion(actual, assertionMessage).toBeGreaterThan(expected);
                break;
              case '>=':
                assertion(actual, assertionMessage).toBeGreaterThanOrEqual(expected);
                break;
              case '<':
                assertion(actual, assertionMessage).toBeLessThan(expected);
                break;
              case '<=':
                assertion(actual, assertionMessage).toBeLessThanOrEqual(expected);
                break;
              default:
                throw new Error(`API_ASSERT_STATUS unknown operator '${op}'. Supported: equals, not equals, ==, !=, >, >=, <, <=`);
            }
          }
          break;

        // API_STORE_JSON: Page=ignored; Object=jsonPath; Condition=unused; Data=storage key
        // Stored runtime key is normalized to rt_<key>.
        case 'API_STORE_JSON':
          {
            const jsonPath = interpolatedObject.trim();
            const storeKey = interpolatedData.trim();
            actionExecutionContext = `apiStoreJson: [JsonPath(Object): ${displayValue(jsonPath)}]: [StoreKey(Data): ${displayValue(storeKey)}]`;
            
            if (!jsonPath || !storeKey) {
              throw new Error('API_STORE_JSON requires Object=jsonPath and Data=storeKey. Example: Data=userId will store runtime value at rt_userId.');
            }

            const responseBody = this.dataContext.getValue('last_response_body');
            const extracted = this.getJsonPathValue(responseBody, jsonPath);
            this.dataContext.storeValueWithRuntimePrefix(storeKey, extracted);
          }
          break;

        // API_ASSERT_JSON|API_SOFTASSERT_JSON: Object=jsonPath; Condition=unused; Data=operator|expectedValue
        // Operator defaults to equals. For exists/not exists no expected value is needed.
        // Examples: Data=exists  |  Data=equals|someValue  |  Data=contains|partial
        case 'API_ASSERT_JSON':
        case 'API_SOFTASSERT_JSON':
          {
            actionExecutionContext = `apiAssertJson: [JsonPath(Object): ${displayValue(interpolatedObject)}]: [OperatorAndExpected(Data): ${displayValue(interpolatedData)}]`;
            const assertion = step.action.toUpperCase().includes('SOFT') ? expect.soft : expect;
            const jsonPath = interpolatedObject.trim();

            if (!jsonPath) {
              throw new Error('API_ASSERT_JSON requires Object=jsonPath.');
            }

            const [rawJsonOp = '', ...jsonParts] = dataParams;
            const rawJsonToken = rawJsonOp.trim().toLowerCase();
            const op = jsonParts.length > 0 ? (rawJsonToken || 'equals') : rawJsonToken;
            const expectedRaw = jsonParts.length > 0 ? jsonParts.join('|').trim() : '';

            if (!op) {
              throw new Error('API_ASSERT_JSON requires Data=operator|expectedValue (e.g. equals|someValue, contains|text, exists).');
            }

            const responseBody = this.dataContext.getValue('last_response_body');
            const actualValue = this.getJsonPathValue(responseBody, jsonPath);
            const actualText = actualValue === undefined || actualValue === null ? '' : String(actualValue);

            switch (op) {
              case 'equals':
                assertion(actualText).toBe(expectedRaw);
                break;
              case 'not equals':
                assertion(actualText).not.toBe(expectedRaw);
                break;
              case 'contains':
                assertion(actualText).toContain(expectedRaw);
                break;
              case 'not contains':
                assertion(actualText).not.toContain(expectedRaw);
                break;
              case 'exists':
                assertion(actualValue).not.toBeUndefined();
                break;
              case 'not exists':
                assertion(actualValue).toBeUndefined();
                break;
              default:
                throw new Error(`API_ASSERT_JSON unknown operator '${op}'. Supported: equals, not equals, contains, not contains, exists, not exists`);
            }
          }
          break;

        case 'API_SET_HEADER':
          {
            const headerName = interpolatedCondition.trim();
            const headerValue = interpolatedData.trim();
            actionExecutionContext = `apiSetHeader: [Name(Condition): ${displayValue(headerName)}]: [Value(Data): ${displayValue(headerValue)}]`;
            
            if (!headerName) {
              throw new Error('API_SET_HEADER requires Condition=headerName and Data=headerValue.');
            }

            this.apiHeaderOverrides[headerName] = headerValue;
          }
          break;

        case 'API_CLEAR_HEADERS':
          {
            actionExecutionContext = 'apiClearHeaders: [Action: reset-overrides]';
            this.apiHeaderOverrides = {};
          }
          break;

        // Page object method execution
        case 'CALL':
          {
            // CALL: Page=PageClass, Object=MethodName, Condition=param1|param2|..., Data=output_key (optional)
            // Params come from Condition column (pipe-separated)
            // If method returns a Locator → auto-click
            // If method returns a value and Data has storage key → store result under that key with rt_ prefix
            const outputKey = interpolatedData.trim();
            actionExecutionContext = `callPageMethod: [
                Page: ${displayValue(interpolatedPage)}]: 
                [Method(Object): ${displayValue(interpolatedObject)}]: 
                [Params(Condition): ${displayValue(interpolatedCondition)}]: 
                [OutputKey(Data): ${displayValue(outputKey)}]`;
            await this.takeStepScreenshot(step, stepIndex);
             
            if (!step.page) {
              throw new Error('CALL requires the Page column to be set.');
            }
            
            const result = await this.actionMapper.executeAction(interpolatedPage, interpolatedObject, ...conditionParams);
            
            // If result is a Locator, auto-click it
            if (result && typeof (result as any).click === 'function') {
              await (result as any).click();
            }
            // If method returned a value and Data column specifies a storage key, store it with rt_ prefix
            else if (result !== undefined && result !== null && outputKey) {
              const storedKey = this.dataContext.storeValueWithRuntimePrefix(outputKey, result);
              console.log(`CALL: stored method result under key '${storedKey}'`);
            }
          }
          break;
        
          // RETRY_UNTIL: Repeatedly checks a condition until it matches or times out.
          // RELOAD_UNTIL: Similar to RETRY_UNTIL, but triggers a reload/click between checks.
          // Condition=optional dynamic locator params for Object (passed to resolveStepLocator)
          // Data=matcher|[expectedValue]|timeout=X|interval=X|[retries=N]|[trigger=X (RELOAD_UNTIL only)]
          //   Match matchers (need expectedValue): contains, not contains, equals, not equals, starts with, ends with, matches regex
          //   State matchers (no expectedValue):   exists, not exists, is present, is not present, is absent
          //   trigger: page (default=page.reload), <frameMember> (iframe reload), <buttonMember> (locator.click)
          case 'RETRY_UNTIL':
          case 'RELOAD_UNTIL':
          {
            const isReloadUntil = actionNameUpper === 'RELOAD_UNTIL';

            if (conditionParams.length > 0 && conditionParams[0] === '') {
              conditionParams.length = 0;
            }

            // Split dataParams: control tokens (named key=value) vs matcher tokens (positional)
            const controlTokens = dataParams.filter(p => /^(timeout|interval|retries|trigger)\s*[:=]/i.test(p));
            const matcherTokens = dataParams.filter(p => !/^(timeout|interval|retries|trigger)\s*[:=]/i.test(p));

            const matcher = matcherTokens[0]?.trim().toLowerCase() || '';
            const stateOnlyMatchers = ['exists', 'not exists', 'is present', 'is not present', 'is absent'];
            const requiresExpectedValue = !stateOnlyMatchers.includes(matcher);
            const expectedValue = requiresExpectedValue ? matcherTokens.slice(1).join('|').trim() : '';

            if (!matcher) {
              throw new Error('RETRY_UNTIL/RELOAD_UNTIL requires Data=matcher|[expectedValue]|timeout=X|interval=X. Example: contains|Ready|timeout=30s|interval=2s');
            }
            if (requiresExpectedValue && !expectedValue) {
              throw new Error(`RETRY_UNTIL/RELOAD_UNTIL matcher '${matcher}' requires an expected value. Example: ${matcher}|Ready|timeout=30s|interval=2s`);
            }

            // Extract trigger for RELOAD_UNTIL (default: page)
            const triggerParam = controlTokens.find(p => /^trigger\s*[:=]/i.test(p));
            const trigger = triggerParam ? triggerParam.replace(/^trigger\s*[:=]\s*/i, '').trim() : 'page';
            const retryControlTokens = controlTokens.filter(p => !/^trigger\s*[:=]/i.test(p));

            const { timeoutMs, intervalMs, maxRetries } = this.parseRetryUntilOptions(retryControlTokens);
            actionExecutionContext = `${isReloadUntil ? 'reloadUntil' : 'retryUntil'}: [Page: ${displayValue(interpolatedPage)}]: [Object: ${displayValue(interpolatedObject)}]: [LocatorParams(Condition): ${displayValue(interpolatedCondition)}]: [Matcher(Data): ${displayValue(interpolatedData)}]`;
            await this.takeStepScreenshot(step, stepIndex);

            const targetIsStoredValue = !interpolatedPage || interpolatedPage.trim() === '';
            const deadline = Date.now() + timeoutMs;
            let attempt = 0;
            let lastActualValue = '';
            let lastExists = false;
            let lastReadError = '';

            while (true) {
              attempt += 1;

              try {
                if (targetIsStoredValue) {
                  const storedValue = this.dataContext.getValue(interpolatedObject);
                  lastExists = storedValue !== undefined && storedValue !== null;
                  lastActualValue = lastExists ? String(storedValue) : '';
                } else {
                  const locator = await this.resolveStepLocator(interpolatedPage, interpolatedObject, conditionParams);
                  const count = await locator.count();
                  lastExists = count > 0;
                  if (lastExists) {
                    const target = locator.first();
                    try {
                      lastActualValue = await target.inputValue();
                    } catch {
                      try {
                        lastActualValue = (await target.innerText()) || '';
                      } catch {
                        lastActualValue = (await target.textContent()) || '';
                      }
                    }
                  } else {
                    lastActualValue = '';
                  }
                }
                lastReadError = '';
              } catch (error) {
                lastExists = false;
                lastActualValue = '';
                lastReadError = error instanceof Error ? error.message : String(error);
              }

              if (this.evaluateRetryUntilMatcher(lastActualValue, lastExists, matcher, expectedValue)) {
                break;
              }

              const timedOut = Date.now() >= deadline;
              const exceededRetries = maxRetries !== undefined && attempt >= maxRetries;
              if (timedOut || exceededRetries) {
                const reason = timedOut ? `timeout after ${timeoutMs}ms` : `max retries reached (${maxRetries})`;
                const errorDetail = lastReadError ? ` Last read error: ${lastReadError}` : '';
                throw new Error(`RETRY_UNTIL/RELOAD_UNTIL condition not met: matcher='${matcher}', expected='${expectedValue}', actual='${lastActualValue}', exists=${lastExists}, attempts=${attempt}, ${reason}.${errorDetail}`);
              }

              if (isReloadUntil && !targetIsStoredValue) {
                if (trigger.toLowerCase() === 'page') {
                  await this.page.reload({ waitUntil: 'load' });
                } else {
                  // Resolve trigger as a property (Locator) first; fall back to calling it as a method
                  const pageObj = this.actionMapper.getPageObject(interpolatedPage);
                  const triggerMember = (pageObj as any)[trigger];
                  const triggerRef = typeof triggerMember === 'function'
                    ? await this.actionMapper.executeAction(interpolatedPage, trigger)
                    : triggerMember;
                  if (typeof (triggerRef as any).owner === 'function') {
                    // FrameLocator: reload the iframe content
                    const iframeLocator = (triggerRef as any).owner();
                    const elementHandle = await iframeLocator.elementHandle();
                    const frame = await elementHandle?.contentFrame();
                    if (!frame) throw new Error(`RELOAD_UNTIL: could not resolve Frame from trigger '${trigger}'.`);
                    await frame.evaluate(() => location.reload());
                    await frame.waitForLoadState('load');
                  } else if (typeof (triggerRef as any).click === 'function') {
                    // Locator: click the element (e.g. a refresh button)
                    await (triggerRef as any).click();
                  } else {
                    throw new Error(`RELOAD_UNTIL: trigger '${trigger}' did not resolve to a FrameLocator or Locator on page '${interpolatedPage}'.`);
                  }
                }
              }

              // interval acts as settle-time after reload (RELOAD_UNTIL) or poll gap (RETRY_UNTIL)
              await this.page.waitForTimeout(intervalMs);
            }
          }
          break;
      
        case 'DATE_BUILDER':
          {
            // DATE_BUILDER: Page=ignored, Object=source date token, Condition=offsets/options, Data=group key (optional)
            // Source tokens: currentdate, currentdatetime, explicit date, ${variable}
            // Offset tokens in Condition: +10d, -2m, +1y, tz=UTC
            // Business day flags in Condition: biznext (roll to Monday), bizprev (roll to Friday)
            // Data (group key) optional: defaults to 'current' for bare currentdate, 'custom' otherwise
            // Stored as: rt_<groupKey>_dd, rt_<groupKey>_mm, rt_<groupKey>_yy, etc.
            const rawSource = interpolatedObject.trim().toLowerCase();
            const hasOffset = conditionParams.some(t => /^[+-]?\d+(d|m|y)$/i.test(t.trim()));
            const isCurrentDate = !rawSource || rawSource === 'currentdate' || rawSource === 'currentdatetime';

            // Determine group key
            let groupKey = interpolatedData.trim();
            if (!groupKey) {
              groupKey = isCurrentDate && !hasOffset ? 'current' : 'custom';
            }

            actionExecutionContext = `dateBuilder: [Source(Object): ${displayValue(interpolatedObject)}]: [Offsets(Condition): ${displayValue(interpolatedCondition)}]: [GroupKey(Data): ${displayValue(groupKey)}]`;

            // Resolve base date
            let baseDate: Date;
            if (isCurrentDate) {
              baseDate = new Date();
            } else {
              // Try to parse explicit date or already-interpolated variable value
              const parsed = new Date(interpolatedObject);
              if (isNaN(parsed.getTime())) {
                throw new Error(`DATE_BUILDER: cannot parse source date '${interpolatedObject}'. Use currentdate, an ISO date (2026-06-09), or a ${'{'}variable${'}'}  that resolves to a date.`);
              }
              baseDate = parsed;
            }

            // Apply offsets
            const { offsetDays, offsetMonths, offsetYears, adjustToBusinessDay } = this.parseDateBuilderOptions(conditionParams);
            let finalDate = this.applyDateOffset(baseDate, offsetDays, offsetMonths, offsetYears);

            // Apply business day adjustment if requested
            if (adjustToBusinessDay !== 'none') {
              const before = finalDate.toISOString().slice(0, 10);
              finalDate = this.adjustToNearestBusinessDay(finalDate, adjustToBusinessDay);
              const after = finalDate.toISOString().slice(0, 10);
              if (before !== after) {
                console.log(`DATE_BUILDER: bizday=${adjustToBusinessDay} adjusted ${before} (weekend) → ${after}`);
              }
            }

            // Store date parts
            this.storeDateParts(groupKey, finalDate);

            console.log(`DATE_BUILDER: group='${groupKey}' resolved date=${finalDate.toISOString()}`);
          }
          break;

        // NotImplemented actions - reserved for future implementation
        case 'DOWNLOAD_AND_ASSERT':
          throw new Error('DOWNLOAD_AND_ASSERT is not yet implemented. Download capture/assert coming soon.');
        
        case 'SWITCH_FRAME':
          throw new Error('SWITCH_FRAME is not yet implemented. Frame context switching coming soon.');
        
        case 'HANDLE_DIALOG':
          throw new Error('HANDLE_DIALOG is not yet implemented. Browser dialog handling coming soon.');
        
        case 'MOCK_API':
          throw new Error('MOCK_API is not yet implemented. Route mocking support coming soon.');
        
        case 'SET_COOKIE':
          throw new Error('SET_COOKIE is not yet implemented. Cookie management coming soon.');
        
        // Conditional control-flow actions are intercepted and resolved by runTestCase()/executeFlow()
        // before a step ever reaches this switch. These cases exist only so /api/actions (which scans
        // for `case 'X':` labels) surfaces every IF variant in the UI's Action column dropdown.
        case 'IF':
        case 'ELSE_IF':
        case 'IF_STATE':
        case 'ELSEIF_STATE':
        case 'IF_TEXT':
        case 'ELSEIF_TEXT':
        case 'IF_VALUE':
        case 'ELSEIF_VALUE':
        case 'ELSE':
        case 'END_IF':
          throw new Error(`${step.action} must be executed via runTestCase()/executeFlow() loop-level conditional handling, not directly through executeStep().`);
        
        case 'PARALLEL_BLOCK':
          throw new Error('PARALLEL_BLOCK is not yet implemented. Runner supports sequential execution only.');
        
        case 'RUN_SCRIPT':
          throw new Error('RUN_SCRIPT is deprecated. Use CALL_TEST with Page=script reference or RUN_FLOW instead.');

        default:
          throw new Error(`Unknown action: ${step.action}`);
        }
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        const actionName = step.action.toUpperCase();
        const timeoutPattern = /timeout|exceeded|timed out/i;
        let enhancedMsg = errorMsg;
        
        if (timeoutPattern.test(errorMsg)) {
          const timeoutSource = this.resolveTimeoutSource(actionName, errorMsg, interpolatedData);
          enhancedMsg = `[${actionName} TIMEOUT at Step ${stepIndex}] - Source: [${timeoutSource}]\n${actionExecutionContext}\n${errorMsg}`;
        } else {
          enhancedMsg = `[${actionName} ERROR at Step ${stepIndex}]\n${actionExecutionContext}\n${errorMsg}`;
        }
        
        throw new Error(enhancedMsg);
      }
    });
  }

  /**
   * Run a single test case (all steps with same TestID)
   */
  async runTestCase(
    steps: TestStep[],
    testName: string,
    seedContext: Record<string, string> = {}
  ): Promise<void> {
    this.currentTestName = testName;
    this.executionPauseActive = false;
    console.log(`\nRunning test: ${testName} (${steps.length} steps)`);
    console.log(`[runtime] ${JSON.stringify({ event: 'test_start', test: testName })}`);

    // Reset context for new test
    this.dataContext.clear();
    this.applyRuntimeValues();

    for (const [key, value] of Object.entries(seedContext)) {
      this.dataContext.storeValue(key, value);
    }

    try {
      const conditionalStructure = this.buildConditionalStructure(steps);
      const conditionalStack: ConditionalExecutionFrame[] = [];
      for (let i = 0; i < steps.length; i++) {
        const step = steps[i];

        if (this.isConditionalAction(step.action)) {
          const executionControlDecision = await this.waitForUiExecutionControl(step, i + 1);
          if (executionControlDecision === 'abort') {
            throw new Error(`Execution aborted by user before step [${i + 1}] ${step.action}`);
          }
          const breakpointDecision = await this.waitForUiBreakpoint(step, i + 1);
          if (breakpointDecision === 'abort') {
            throw new Error(`Execution aborted at breakpoint before step [${i + 1}] ${step.action}`);
          }

          let stepCompleted = false;
          while (!stepCompleted) {
            try {
              const jumpTo = await this.executeConditionalStep(steps, i, i + 1, conditionalStructure, conditionalStack);
              if (jumpTo !== undefined) i = jumpTo - 1;
              stepCompleted = true;
            } catch (error) {
              const failureDecision = await this.waitForUiFailureControl(step, i + 1, error);
              if (failureDecision === 'retry') continue;
              if (failureDecision === 'resume') {
                stepCompleted = true;
                continue;
              }
              throw error;
            }
          }
          continue;
        }

        if (!this.shouldExecuteStep(step)) {
          const stepTarget = this.getStepTarget(step);
          console.log(`Skipping step [${i + 1}] ${step.action} - ${stepTarget} (Run=N)`);
          continue;
        }

        const executionControlDecision = await this.waitForUiExecutionControl(step, i + 1);
        if (executionControlDecision === 'abort') {
          throw new Error(`Execution aborted by user before step [${i + 1}] ${step.action}`);
        }

        const breakpointDecision = await this.waitForUiBreakpoint(step, i + 1);
        if (breakpointDecision === 'abort') {
          throw new Error(`Execution aborted at breakpoint before step [${i + 1}] ${step.action}`);
        }

        let stepCompleted = false;
        while (!stepCompleted) {
          try {
            await this.executeStep(step, i + 1);
            stepCompleted = true;
          } catch (error) {
            if (step.optional) {
              console.warn(`⚠️  Optional step skipped: ${error}`);
              stepCompleted = true;
              continue;
            }

            const failureDecision = await this.waitForUiFailureControl(step, i + 1, error);
            if (failureDecision === 'retry') {
              continue;
            }
            if (failureDecision === 'resume') {
              stepCompleted = true;
              continue;
            }
            throw error;
          }
        }
      }

      console.log(`[runtime] ${JSON.stringify({ event: 'test_pass', test: testName })}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.log(`[runtime] ${JSON.stringify({ event: 'test_fail', test: testName, error: message })}`);
      throw error;
    }
  }

  /**
   * Run all test cases from a CSV file
   */
  async runTestsFromCSV(filePath: string): Promise<void> {
    const testSteps = CSVParser.parseTestSteps(filePath);
    const groupedSteps = CSVParser.groupByTestID(testSteps);

    for (const [testID, steps] of groupedSteps.entries()) {
      const testName = steps[0].description || testID;
      await this.runTestCase(steps, testName);
    }
  }

  loadTestSteps(filePath: string): TestStep[] {
    this.currentTestFilePath = filePath;
    return CSVParser.parseTestSteps(filePath);
  }

  /**
   * Load test data
   */
  loadTestData(name: string, filePath: string): void {
    this.dataContext.loadTestData(name, filePath);
  }

  /**
   * Load all test data from directory
   */
  loadAllTestData(dirPath: string): void {
    this.dataContext.loadAllTestData(dirPath);
  }

  /**
   * Get all stored values
   */
  getAllStoredValues(): Record<string, any> {
    return this.dataContext.getAllValues();
  }

  /**
   * Get data context for manual access
   */
  getDataContext(): DataContext {
    return this.dataContext;
  }

  /**
   * Get action mapper for manual method calls
   */
  getActionMapper(): ActionMapper {
    return this.actionMapper;
  }
}




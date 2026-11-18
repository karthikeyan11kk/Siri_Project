/**
 * Core migration types - shared across all adapters and emitters
 */

export interface PageObject {
  name: string;
  selector: string;
  description?: string;
  /** Full-line section markers from the recorded spec (e.g. //--** …), emitted above this locator in the page class */
  leadingSectionComment?: string;
  isMethod?: boolean; // true if it's a method like productName(name: string)
  methodParams?: string[]; // parameters for method-based selectors
}

export interface PageClass {
  name: string;
  filePath: string;
  objects: Map<string, PageObject>; // key = normalized object name
  methods: Map<string, PageObject>; // key = method name, for parameterized locators
}

export interface TestAction {
  action: string; // GOTO, CLICK, FILL, ASSERT_URL_CONTAINS, etc.
  page?: string; // page class name
  object?: string; // object name from page class or 'page' for page root
  data?: string; // value to fill/assert, or path for GOTO
  condition?: string; // optional condition (STRICT: may contain dynamic params, state matcher, operator)
  description?: string;
  /** Section banner lines (e.g. //--**) that preceded this action in the recorded spec */
  sectionBanner?: string;
}

/**
 * STRICT Column Contract for CSV Actions (May 2026 - Enforced)
 * 
 * Migration generates TestActions that are transformed to STRICT format at CSV output time.
 * 
 * STRICT Rules:
 * - Dynamic params: CONDITION column ONLY (FILL, CLICK, SELECT, etc.)
 * - Timeout values: DATA column ONLY (CLICK_TO_SWITCH, SWITCH_CONTEXT, ASSERT)
 * - ASSERT state: CONDITION column ONLY (required, throws error if empty)
 * - API_ASSERT_JSON: unpacked across 3 columns (Object=jsonPath, Condition=operator, Data=expected)
 * - No fallback logic - strict enforcement means old CSV format will fail
 * 
 * Example transformations:
 * - FILL + params: Condition="param1|param2" Data="value"
 * - CLICK_TO_SWITCH + timeout: Condition="" Data="5000"
 * - ASSERT + state: Condition="is visible" Data="" (or "5000" for timeout)
 */

export interface TestScript {
  name: string; // e.g., tc_login_001_standard_user_success
  description?: string;
  actions: TestAction[];
}

export interface MigrationModel {
  projectName: string; // e.g., 'saucedemo' or 's360'
  scriptName: string; // e.g., 'tc_login_001_standard_user_success' or 'recorded_session_1'
  pages: Map<string, PageClass>; // key = page class name
  testScript: TestScript;
}

export interface DedupeResult {
  added: string[]; // new objects added
  reused: string[]; // existing objects reused
  skipped: string[]; // conflict, didn't add
  conflicts: Array<{ name: string; reason: string }>;
}

export interface MigrationOptions {
  projectName?: string; // required by migration CLI and orchestrator
  scriptName?: string; // inferred from source file if not provided
  pageOutputDir?: string; // output directory for generated/updated page classes
  csvOutputDir?: string; // output directory for generated CSV script
  overwrite?: boolean; // allow overwriting existing page objects
  dryRun?: boolean; // don't actually write files
  mergeStrategy?: 'reuse' | 'rename' | 'skip'; // how to handle existing objects
  verbose?: boolean; // print line-by-line parse detail and page object assignments
}

/**
 * Schema Types
 *
 * Shared type contracts for project configuration, runtime catalogs,
 * and cycle-based execution models.
 */

import { Page } from '@playwright/test';
import { DataContext } from '../runners/data-loader';

export type PageObjectFactory = (page: Page, dataContext: DataContext) => unknown;

export type PageObjectFactoryMap = Record<string, PageObjectFactory>;

export type RuntimeApplicationEnvironment = {
	uiBaseUrl?: string;
	apiBaseUrl?: string;
};

export type RuntimeApplication = {
	id: string;
	displayName?: string;
	environments: Record<string, RuntimeApplicationEnvironment>;
};

export type ProjectRuntimeCatalog = {
	version: number;
	defaultEnvironment?: string;
	defaultUiApplicationId?: string;
	applications: RuntimeApplication[];
};

// ─── Test Users ───────────────────────────────────────────────────────────────

export type TestUserCredentials = {
	username: string;
	password: string;
	/** Any additional named fields (e.g. email, token, mfa_secret) */
	[key: string]: string;
};

/**
 * A named user role (e.g. "admin", "readonly", "standard_user").
 * Each role has a fixed set of credentials.
 */
export type TestUserRole = {
	credentials: TestUserCredentials;
};

export type TestUsersConfig = {
	version: number;
	/** Role name to use when TEST_USER_ROLE env var is not set. */
	defaultRole?: string;
	/** Map of role name → role definition. */
	roles: Record<string, TestUserRole>;
};

export type ActiveProjectConfig = {
	projectName?: string;
	environmentName?: string;
	environmentsByProject?: Record<string, string>;
};

export type ResolvedProjectRuntime = {
	environmentName: string;
	baseURL?: string;
	values: Record<string, string>;
	summaryLines: string[];
};

export type FrameworkProjectConfig = {
	name: string;
	displayName?: string;
	baseURL?: string;
	testsRootDir: string;
	testDataRootDir: string;
	testFlowsRootDir: string;
	testCyclesRootDir?: string;
	pageFactories: PageObjectFactoryMap;
};

// ─── Test Cycle Types ────────────────────────────────────────────────────────

export type TestCycleEntry = {
	/** Optional external test management ID (e.g. XRAY-123, ZEPHYR-456). */
	testId?: string;
	/** Relative path under test-scripts/ without .csv extension, e.g. "login/tc_login_001_standard_user_success" */
	test: string;
	/** Number of times to retry this test on failure. Overrides stage-level retryOnFailure. */
	retryOnFailure?: number;
	/** Environment name override for this test only. Overrides stage-level env. */
	env?: string;
};

export type TestCycleStage = {
	stage: number;
	name: string;
	/** Whether this stage and all of its tests run. Defaults to true. */
	enabled?: boolean;
	/** "sequence" runs tests serially (stops stage on first failure); "parallel" runs tests in parallel. */
	execution: 'sequence' | 'parallel';
	/** Environment name to use for all tests in this stage. Overrides cycle-level env. */
	env?: string;
	/** Whether to skip subsequent stages if this stage has any test failures (only meaningful for sequence). */
	stopOnStageFail?: boolean;
	/** Default number of retries for all tests in this stage. */
	retryOnFailure?: number;
	tests: TestCycleEntry[];
};

export type TestCycleConfig = {
	name: string;
	/** Deprecated legacy field; use `name`. */
	cycle?: string;
	project: string;
	/** Default environment for all stages. Can be overridden at stage or test level. */
	env?: string;
	/** Full Zephyr cycle key per environment, including project prefix, e.g. { "QA": "MOD-R192", "PREPROD": "MOD-R210" }. */
	zephyrCycleKeysByEnvironment?: Record<string, string>;
	stages: TestCycleStage[];
};

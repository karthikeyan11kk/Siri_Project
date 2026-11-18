export type ZephyrExecutionStatus = 'Pass' | 'Fail' | 'Not Executed' | 'Blocked' | string;

export type ZephyrScaleConfig = {
  token: string;
  projectKey: string;
  testCycleKey: string;
  environmentName: string;
  executedById?: string;
  apiBaseUrl?: string;
};

export type ZephyrExecutionUpdate = {
  testCaseKey: string;
  status: string;
  durationMs: number;
  comment?: string;
  actualEndDate?: Date;
};

export type ZephyrUpdateResult = {
  action: 'created' | 'updated';
  executionKey?: string;
  response: unknown;
};

type ZephyrExecution = {
  key?: string;
  testExecutionStatus?: {
    id?: string | number;
    name?: string;
  };
};

const DEFAULT_API_BASE_URL = 'https://api.zephyrscale.smartbear.com/v2';
const NOT_STARTED_STATUS_ID = '2548873';

function toZephyrStatus(status: string): ZephyrExecutionStatus {
  const normalized = String(status || '').trim().toUpperCase();
  if (normalized === 'PASSED' || normalized === 'PASS' || normalized === 'DONE') return 'Pass';
  if (normalized === 'FAILED' || normalized === 'FAIL' || normalized === 'STOPPED' || normalized === 'TIMEDOUT') return 'Fail';
  if (normalized === 'SKIPPED' || normalized === 'INTERRUPTED') return 'Not Executed';
  return String(status || '').trim() || 'Not Executed';
}

function toIsoUtc(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function getHeaders(token: string): Record<string, string> {
  if (!token.trim()) {
    throw new Error('Zephyr Scale token is required. Set ZEPHYR_SCALE_TOKEN before enabling result upload.');
  }
  return {
    Authorization: `Bearer ${token.trim()}`,
    'Content-Type': 'application/json',
  };
}

async function requestZephyr<T>(
  config: ZephyrScaleConfig,
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const baseUrl = (config.apiBaseUrl || DEFAULT_API_BASE_URL).replace(/\/$/, '');
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: {
      ...getHeaders(config.token),
      ...(options.headers || {}),
    },
  });

  const text = await response.text();
  let body: unknown = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }

  if (!response.ok) {
    const details = typeof body === 'string' ? body : JSON.stringify(body);
    throw new Error(`Zephyr Scale ${options.method || 'GET'} ${path} failed (${response.status}): ${details}`);
  }
  return body as T;
}

async function findLatestExecution(config: ZephyrScaleConfig, testCaseKey: string): Promise<ZephyrExecution | null> {
  const query = new URLSearchParams({
    projectKey: config.projectKey,
    testCycle: config.testCycleKey,
    testCase: testCaseKey,
    onlyLastExecutions: 'true',
  });
  const executions = await requestZephyr<ZephyrExecution[]>(config, `/testexecutions?${query.toString()}`);
  return Array.isArray(executions) && executions.length > 0 ? executions[0] : null;
}

function buildPayload(config: ZephyrScaleConfig, update: ZephyrExecutionUpdate, includeKeys: boolean): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    statusName: toZephyrStatus(update.status),
    environmentName: config.environmentName,
    actualEndDate: toIsoUtc(update.actualEndDate || new Date()),
    executionTime: Math.max(0, Math.round(update.durationMs)),
    comment: update.comment || '',
  };
  if (config.executedById) payload.executedById = config.executedById;
  if (includeKeys) {
    payload.projectKey = config.projectKey;
    payload.testCycleKey = config.testCycleKey;
    payload.testCaseKey = update.testCaseKey;
  }
  return payload;
}

/**
 * Apply the legacy UFT policy: update the latest execution only when it is
 * Not Started; otherwise create a new execution in the selected Zephyr cycle.
 */
export async function updateZephyrTestExecution(
  config: ZephyrScaleConfig,
  update: ZephyrExecutionUpdate,
): Promise<ZephyrUpdateResult> {
  if (!config.projectKey.trim() || !config.testCycleKey.trim() || !config.environmentName.trim()) {
    throw new Error('Zephyr project key, test cycle key, and environment name are required.');
  }
  if (!update.testCaseKey.trim()) {
    throw new Error('Zephyr test case key is required.');
  }

  const existing = await findLatestExecution(config, update.testCaseKey.trim());
  const existingStatusId = String(existing?.testExecutionStatus?.id || '');
  const executionKey = String(existing?.key || '').trim();

  if (executionKey && existingStatusId === NOT_STARTED_STATUS_ID) {
    const response = await requestZephyr<unknown>(config, `/testexecutions/${encodeURIComponent(executionKey)}`, {
      method: 'PUT',
      body: JSON.stringify(buildPayload(config, update, false)),
    });
    console.log('[zephyr] update response:', JSON.stringify(response));
    return { action: 'updated', executionKey, response };
  }

  const response = await requestZephyr<ZephyrExecution>(config, '/testexecutions', {
    method: 'POST',
    body: JSON.stringify(buildPayload(config, update, true)),
  });
  console.log('[zephyr] create response:', JSON.stringify(response));
  return { action: 'created', executionKey: response?.key, response };
}

export async function createZephyrTestExecution(
  config: ZephyrScaleConfig,
  update: ZephyrExecutionUpdate,
): Promise<ZephyrUpdateResult> {
  if (!config.projectKey.trim() || !config.testCycleKey.trim() || !config.environmentName.trim()) {
    throw new Error('Zephyr project key, test cycle key, and environment name are required.');
  }
  if (!update.testCaseKey.trim()) {
    throw new Error('Zephyr test case key is required.');
  }

  const response = await requestZephyr<ZephyrExecution>(config, '/testexecutions', {
    method: 'POST',
    body: JSON.stringify(buildPayload(config, update, true)),
  });
  console.log('[zephyr] create response:', JSON.stringify(response));
  return { action: 'created', executionKey: response?.key, response };
}
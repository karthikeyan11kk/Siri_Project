'use strict';

/** Thrown when a playwright-settings.json file is missing a required field or has an invalid value. */
class PlaywrightSettingsValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PlaywrightSettingsValidationError';
  }
}

const PLAYWRIGHT_SETTINGS_SCHEMA = {
  requiredFields: [
    'testDir', 'testMatch', 'browsers', 'fullyParallel', 'forbidOnly', 'retries', 'workers', 'reporter',
    'timeoutMs', 'expectTimeoutMs', 'actionTimeoutMs', 'navigationTimeoutMs', 'viewportWidth', 'viewportHeight',
    'baseURL', 'ignoreHTTPSErrors', 'trace', 'slowMo', 'screenshot', 'stepScreenshotMode', 'stepScreenshotHighlight',
    'stepScreenshotFullPage', 'video', 'snapshotDir', 'outputDir', 'outputFolder', 'launchArgs',
  ],
  enumFields: {
    trace: ['on', 'off', 'on-first-retry', 'retain-on-failure'],
    screenshot: ['off', 'on', 'only-on-failure'],
    video: ['off', 'on', 'retain-on-failure', 'on-first-retry'],
    stepScreenshotMode: ['off', 'all-steps'],
  },
  arrayEnumFields: {
    browsers: ['chromium', 'firefox', 'webkit'],
    reporter: ['html', 'dot', 'json', 'junit', 'list', 'github', 'allure', 'custom'],
  },
};

/**
 * Validates a raw (pre-normalization) playwright-settings.json object against the shared schema.
 * Throws PlaywrightSettingsValidationError listing every problem found, or returns silently if valid.
 */
function validatePlaywrightSettings(source, filePath, schema = PLAYWRIGHT_SETTINGS_SCHEMA) {
  const value = source && typeof source === 'object' ? source : {};
  const errors = [];

  for (const key of schema.requiredFields) {
    if (value[key] === undefined) {
      errors.push(`missing required field '${key}'`);
    }
  }

  for (const [key, allowed] of Object.entries(schema.enumFields)) {
    if (value[key] !== undefined && !allowed.includes(value[key])) {
      errors.push(`invalid value '${value[key]}' for '${key}' (expected one of: ${allowed.join(', ')})`);
    }
  }

  for (const [key, allowed] of Object.entries(schema.arrayEnumFields)) {
    if (value[key] === undefined) continue;
    if (!Array.isArray(value[key]) || value[key].length === 0) {
      errors.push(`field '${key}' must be a non-empty array`);
      continue;
    }
    const invalid = value[key].filter((item) => !allowed.includes(item));
    if (invalid.length) {
      errors.push(`invalid value(s) [${invalid.join(', ')}] for '${key}' (expected one of: ${allowed.join(', ')})`);
    }
  }

  if (errors.length) {
    throw new PlaywrightSettingsValidationError(
      `Invalid Playwright settings in ${filePath}:\n  - ${errors.join('\n  - ')}`
    );
  }
}

module.exports = {
  validatePlaywrightSettings,
  PlaywrightSettingsValidationError,
  PLAYWRIGHT_SETTINGS_SCHEMA,
};

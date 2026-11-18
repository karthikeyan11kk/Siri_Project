'use strict';

const fs = require('fs');

/** Parses .env-style content into an ordered array of {key, value} pairs (comments/blanks skipped). */
function parseEnvContent(content) {
  const entries = [];
  const lines = String(content || '').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const separator = trimmed.indexOf('=');
    if (separator < 1) continue;
    const key = trimmed.slice(0, separator).trim();
    let value = trimmed.slice(separator + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (key) entries.push({ key, value });
  }
  return entries;
}

/** Loads a .env file into process.env, without overriding already-set values. */
function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return;
  let content = '';
  try { content = fs.readFileSync(filePath, 'utf-8'); } catch { return; }
  for (const { key, value } of parseEnvContent(content)) {
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

/** Reads specific keys from a .env file (does not touch process.env). Returns {} for missing keys. */
function readEnvValues(filePath, keys) {
  const entries = fs.existsSync(filePath) ? parseEnvContent(fs.readFileSync(filePath, 'utf-8')) : [];
  const byKey = new Map(entries.map((e) => [e.key, e.value]));
  const result = {};
  for (const key of keys) result[key] = byKey.get(key) ?? '';
  return result;
}

/**
 * Merges key/value updates into an existing .env file, preserving comments, order, and
 * untouched keys. Keys not already present are appended at the end. Also updates process.env.
 */
function writeEnvValues(filePath, updates) {
  const existingContent = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf-8') : '';
  const lines = existingContent.split(/\r?\n/);
  const remainingKeys = new Set(Object.keys(updates));

  const nextLines = lines.map((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return line;
    const separator = trimmed.indexOf('=');
    if (separator < 1) return line;
    const key = trimmed.slice(0, separator).trim();
    if (!remainingKeys.has(key)) return line;
    remainingKeys.delete(key);
    return `${key}=${updates[key]}`;
  });

  for (const key of remainingKeys) {
    nextLines.push(`${key}=${updates[key]}`);
  }

  const nextContent = nextLines.join('\n').replace(/\n{3,}/g, '\n\n').replace(/\s+$/, '') + '\n';
  fs.writeFileSync(filePath, nextContent, 'utf-8');

  for (const [key, value] of Object.entries(updates)) {
    process.env[key] = value;
  }
}

module.exports = { parseEnvContent, loadEnvFile, readEnvValues, writeEnvValues };

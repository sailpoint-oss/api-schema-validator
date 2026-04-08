#!/usr/bin/env node
/**
 * Cross-platform Node.js equivalent of workflow-validate.sh
 *
 * Usage:
 *   node workflow-validate.js "<comma-separated-file-paths>"
 *
 * Required environment variables:
 *   CLIENT_ID, CLIENT_SECRET, TENANT
 *
 * Optional:
 *   API_CLIENT_PATH  – absolute path to the api-client-common repo
 *                      (defaults to ../../../api-client-common relative to this file)
 */

'use strict';

const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------
const VALIDATOR_DIR = __dirname;

const API_CLIENT_PATH =
  process.env.API_CLIENT_PATH ||
  path.resolve(VALIDATOR_DIR, '..', '..', '..', 'api-client-common');

const BASE_DIR = path.join(API_CLIENT_PATH, 'api-specs', 'src', 'main', 'yaml');
const VALIDATOR_SCRIPT = path.join(VALIDATOR_DIR, 'validator.js');

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------
const rawArgs = process.argv.slice(2);
if (rawArgs.length === 0) {
  console.error('Usage: node workflow-validate.js "<comma-separated-file-paths>"');
  process.exit(1);
}

// Accept comma-separated files (matching the shell script interface)
const changedFiles = rawArgs[0]
  .split(',')
  .map(f => f.trim())
  .filter(Boolean);

if (changedFiles.length === 0) {
  console.error('No files provided.');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Step 1: Resolve full specs with speccy (same versions as workflow-validate.sh)
// ---------------------------------------------------------------------------
const VERSIONS = ['v3', 'beta', 'v2024', 'v2025', 'v2026'];

for (const version of VERSIONS) {
  const specFile = path.join(BASE_DIR, `sailpoint-api.${version}.yaml`);
  const outFile = path.join(VALIDATOR_DIR, `${version}.yaml`);

  if (!fs.existsSync(specFile)) continue;

  try {
    execSync(`speccy resolve --quiet "${specFile}" -o "${outFile}"`, {
      stdio: ['ignore', 'ignore', 'pipe'],
    });
  } catch (e) {
    // Non-fatal — the version may have a partial spec or speccy warning
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Extract the version segment (v3, beta, v2024, …) from a file path. */
function getVersion(filePath) {
  const parts = filePath.replace(/\\/g, '/').split('/');
  const yamlIdx = parts.indexOf('yaml');
  return yamlIdx !== -1 && yamlIdx + 1 < parts.length ? parts[yamlIdx + 1] : null;
}

/** Recursively walk a directory and return all YAML files whose content contains searchStr. */
function findYamlFilesContaining(dir, searchStr) {
  const matches = [];
  function walk(current) {
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.isFile() && /\.ya?ml$/i.test(entry.name)) {
        try {
          if (fs.readFileSync(fullPath, 'utf8').includes(searchStr)) {
            matches.push(fullPath);
          }
        } catch {
          // ignore unreadable files
        }
      }
    }
  }
  walk(dir);
  return matches;
}

/**
 * Given a changed paths/ file, find the API path key that references it in
 * the main sailpoint-api.<version>.yaml file.
 *
 * Replicates: grep -B 1 $FILE_NAME "sailpoint-api.${VERSION}.yaml" | head -n 1 | tr -d ' ' | tr -d ':'
 */
function findApiPathForFile(version, fileName) {
  const mainSpec = path.join(BASE_DIR, `sailpoint-api.${version}.yaml`);
  if (!fs.existsSync(mainSpec)) return null;

  const lines = fs.readFileSync(mainSpec, 'utf8').split('\n');
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].includes(fileName)) {
      return lines[i - 1].trim().replace(/:$/, '');
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Step 2: Validate changed files
// ---------------------------------------------------------------------------

/** Track already-validated API paths to avoid duplicate runs (mirrors tested_paths.txt). */
const testedPaths = new Set();

/**
 * Run validator.js for one API path and return its stdout output.
 * Returns an empty string if the validator exits cleanly with no issues.
 */
function runValidator(version, apiPath) {
  if (testedPaths.has(apiPath)) return '';
  testedPaths.add(apiPath);

  try {
    return execSync(
      `node "${VALIDATOR_SCRIPT}" -i "${version}" -f "${VALIDATOR_DIR}/" -p "${apiPath}" --github-action`,
      {
        cwd: VALIDATOR_DIR,
        env: process.env,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        maxBuffer: 10 * 1024 * 1024,
      }
    );
  } catch (e) {
    // validator.js exits non-zero when it finds errors; capture the output anyway
    return (e.stdout || '') + (e.stderr || '');
  }
}

/**
 * Core validation logic — mirrors the validate_paths() shell function.
 * Returns concatenated validator output for all paths covered by the given files.
 */
function validatePaths(filePaths) {
  let output = '';

  for (const filePath of filePaths) {
    const normalized = filePath.replace(/\\/g, '/');

    if (normalized.includes('/paths/')) {
      const version = getVersion(normalized);
      const fileName = path.basename(normalized);
      if (!version) continue;

      const apiPath = findApiPathForFile(version, fileName);
      if (!apiPath) continue;

      output += runValidator(version, apiPath);

    } else if (normalized.includes('/schemas/')) {
      const version = getVersion(normalized);
      const fileName = path.basename(normalized);
      if (!version) continue;

      const versionDir = path.join(BASE_DIR, version);
      if (!fs.existsSync(versionDir)) continue;

      // Find all YAML files that reference this schema file (mirrors grep -lr)
      const referencingFiles = findYamlFilesContaining(versionDir, `/${fileName}`);
      if (referencingFiles.length > 0) {
        const relativePaths = referencingFiles.map(f => path.relative(API_CLIENT_PATH, f));
        output += validatePaths(relativePaths);
      }
    }
  }

  return output;
}

// ---------------------------------------------------------------------------
// Main loop — mirrors the outer for loop in the shell script
// ---------------------------------------------------------------------------
let anyErrors = false;

for (const changedFile of changedFiles) {
  const validation = validatePaths([changedFile]);

  // The validator outputs markdown table rows containing "|" when there are errors
  if (validation.includes('|')) {
    anyErrors = true;
    console.log(
      `**${changedFile}** is used in one or more paths that have an invalid schema.` +
      `  Please fix the schema validation issues below.` +
      `  For more information on this PR check, please see the` +
      ` [API schema validator README](https://github.com/sailpoint/cloud-api-client-common#api-schema-validator).` +
      `  For a list of common error messages and how to fix them, please` +
      ` [see this section in the README](https://github.com/sailpoint/cloud-api-client-common#common-api-validator-errors).`
    );
    console.log('| Path | Errors |');
    console.log('|-|-|');
    console.log(validation.trimEnd());
    console.log('---');
  }
}

process.exit(anyErrors ? 1 : 0);

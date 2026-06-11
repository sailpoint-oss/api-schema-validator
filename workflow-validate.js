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
const APIS_DIR = path.join(BASE_DIR, 'apis');
const VALIDATOR_SCRIPT = path.join(VALIDATOR_DIR, 'validator.js');

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------
const rawArgs = process.argv.slice(2);
if (rawArgs.length === 0) {
  console.error('Usage: node workflow-validate.js "<comma-separated-file-paths>"');
  process.exit(1);
}

const changedFiles = rawArgs[0]
  .split(',')
  .map(f => f.trim())
  .filter(Boolean);

if (changedFiles.length === 0) {
  console.error('No files provided.');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Step 1: Stage old-style version specs for the validator.
// New-style (apis/{resource}/openapi.yaml) are read directly from BASE_DIR/apis.
// ---------------------------------------------------------------------------
const VERSIONS = ['v3', 'beta', 'v2024', 'v2025', 'v2026'];

for (const version of VERSIONS) {
  const specFile = path.join(BASE_DIR, `sailpoint-api.${version}.yaml`);
  const outFile = path.join(VALIDATOR_DIR, `${version}.yaml`);

  if (!fs.existsSync(specFile)) continue;

  try {
    fs.copyFileSync(specFile, outFile);
  } catch {
    // Non-fatal
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Determine the spec type and identifier from a changed file path.
 *
 * Returns one of:
 *   { type: 'version',  name: 'v3',               specFolder: VALIDATOR_DIR }
 *   { type: 'resource', name: 'machine-accounts',  specFolder: APIS_DIR }
 * or null if the path is not recognisable.
 *
 * Path patterns:
 *   Old:  ...yaml/{version}/paths/file.yaml
 *   New:  ...yaml/apis/{resource}/paths/file.yaml
 */
function getSpecInfo(filePath) {
  const normalized = filePath.replace(/\\/g, '/');
  const parts = normalized.split('/');
  const yamlIdx = parts.indexOf('yaml');
  if (yamlIdx === -1 || yamlIdx + 1 >= parts.length) return null;

  const segment = parts[yamlIdx + 1];

  if (segment === 'apis') {
    // New resource-level spec
    const resourceName = parts[yamlIdx + 2];
    if (!resourceName) return null;
    return { type: 'resource', name: resourceName, specFolder: APIS_DIR };
  } else {
    // Old version-level spec
    return { type: 'version', name: segment, specFolder: VALIDATOR_DIR };
  }
}

/**
 * Find the OpenAPI path key (e.g. "/accounts") that references a given file
 * by looking in the spec's top-level paths section.
 *
 * For old-style specs: reads sailpoint-api.{version}.yaml
 * For new-style specs: reads apis/{resource}/openapi.yaml
 */
function findApiPathForFile(specInfo, fileName) {
  let mainSpec;
  if (specInfo.type === 'version') {
    mainSpec = path.join(BASE_DIR, `sailpoint-api.${specInfo.name}.yaml`);
  } else {
    mainSpec = path.join(APIS_DIR, specInfo.name, 'openapi.yaml');
  }

  if (!fs.existsSync(mainSpec)) return null;

  const lines = fs.readFileSync(mainSpec, 'utf8').split('\n');
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].includes(fileName)) {
      return lines[i - 1].trim().replace(/:$/, '');
    }
  }
  return null;
}

/** Recursively find all YAML files whose content contains searchStr. */
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

// ---------------------------------------------------------------------------
// Validation runner
// ---------------------------------------------------------------------------

/** Track already-validated (specKey + apiPath) pairs to avoid duplicate runs. */
const testedPaths = new Set();

/**
 * Run validator.js for one API path and return its stdout output.
 */
function runValidator(specInfo, apiPath) {
  const dedupeKey = `${specInfo.name}:${apiPath}`;
  if (testedPaths.has(dedupeKey)) return '';
  testedPaths.add(dedupeKey);

  try {
    return execSync(
      `node "${VALIDATOR_SCRIPT}" -i "${specInfo.name}" -f "${specInfo.specFolder}/" -p "${apiPath}" --github-action`,
      {
        cwd: VALIDATOR_DIR,
        env: process.env,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        maxBuffer: 10 * 1024 * 1024,
      }
    );
  } catch (e) {
    return (e.stdout || '') + (e.stderr || '');
  }
}

/**
 * Process a list of changed file paths and return concatenated validator output.
 *
 * Handles both old-style (yaml/{version}/paths/*.yaml) and
 * new-style (yaml/apis/{resource}/paths/*.yaml or schemas/*.yaml) files.
 */
function validatePaths(filePaths) {
  let output = '';

  for (const filePath of filePaths) {
    const normalized = filePath.replace(/\\/g, '/');

    if (normalized.includes('/paths/')) {
      const specInfo = getSpecInfo(normalized);
      if (!specInfo) continue;

      const fileName = path.basename(normalized);
      const apiPath = findApiPathForFile(specInfo, fileName);
      if (!apiPath) continue;

      output += runValidator(specInfo, apiPath);

    } else if (normalized.includes('/schemas/')) {
      const specInfo = getSpecInfo(normalized);
      if (!specInfo) continue;

      const fileName = path.basename(normalized);

      // Find all YAML files in the relevant directory tree that reference this schema
      let searchDir;
      if (specInfo.type === 'resource') {
        searchDir = path.join(APIS_DIR, specInfo.name);
      } else {
        searchDir = path.join(BASE_DIR, specInfo.name);
      }

      if (!fs.existsSync(searchDir)) continue;

      const referencingFiles = findYamlFilesContaining(searchDir, `/${fileName}`);
      if (referencingFiles.length > 0) {
        const relativePaths = referencingFiles.map(f => path.relative(API_CLIENT_PATH, f));
        output += validatePaths(relativePaths);
      }
    }
  }

  return output;
}

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------
let anyErrors = false;

for (const changedFile of changedFiles) {
  const validation = validatePaths([changedFile]);

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

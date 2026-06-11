'use strict';

const path = require('path');
const SwaggerParser = require('@apidevtools/swagger-parser');
const Ajv = require('ajv');
const addFormats = require('ajv-formats');
const dotenv = require('dotenv');
const yargs = require('yargs');
const filterTests = require('./filterTests');
const sorterTests = require('./sorterTests');
const fs = require('fs');
const {
  validateSchemaForSingleGetResource,
  findAdditionalProperties,
  buildHttpClient,
  normalizeNullable,
  STATUS
} = require('./utils');
const { generateHtmlReport } = require('./coverageReport');

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function getArgs() {
  const argv = yargs
    .option('input', {
      alias: 'i',
      description: 'The API version to run against.',
      type: 'string'
    })
    .option('path', {
      alias: 'p',
      description: "Test an individual path (ex. /accounts). Don't include the version in the path.",
      type: 'string'
    })
    .option('spec-folder', {
      alias: 'f',
      description: 'Path to the folder containing the resolved spec files',
      type: 'string'
    })
    .option('env', {
      alias: 'e',
      description: 'Path to the environment file',
      type: 'string'
    })
    .option('client-id', {
      description: 'The client ID of the personal access token to use for authentication',
      type: 'string'
    })
    .option('client-secret', {
      description: 'The client secret of the personal access token to use for authentication',
      type: 'string'
    })
    .option('tenant', {
      alias: 't',
      description: 'The tenant to run the tests against',
      type: 'string'
    })
    .option('github-action', {
      description: 'Format the output for use in the github action',
      type: 'boolean',
      default: false
    })
    .option('skip-filters', {
      description: "Don't run the filter query param validator",
      type: 'boolean',
      default: false
    })
    .option('skip-sorters', {
      description: "Don't run the sorter query param validator",
      type: 'boolean',
      default: false
    })
    .option('skip-schema', {
      description: "Don't run the schema validator",
      type: 'boolean',
      default: false
    })
    .option('generate-coverage-report', {
      description: 'Generate a coverage report to view API coverage',
      type: 'boolean',
      default: false
    })
    .option('use-report-mock-data', {
      description: 'Generate a coverage report using mock data',
      type: 'boolean',
      default: false
    })
    .demandOption(['input', 'spec-folder'])
    .help()
    .alias('help', 'h').argv;

  if (argv.env) {
    dotenv.config({ path: argv.env });
  } else {
    dotenv.config();
  }

  if (argv['client-id']) process.env.CLIENT_ID = argv['client-id'];
  if (argv['client-secret']) process.env.CLIENT_SECRET = argv['client-secret'];
  if (argv['tenant']) process.env.TENANT = argv['tenant'];

  if (!process.env.CLIENT_ID) {
    console.log('Missing client ID. A client ID must be provided as an env variable, in the .env file, or as a CLI option.');
    process.exit(1);
  }
  if (!process.env.CLIENT_SECRET) {
    console.log('Missing client secret. A client secret must be provided as an env variable, in the .env file, or as a CLI option.');
    process.exit(1);
  }
  if (!process.env.TENANT) {
    console.log('Missing tenant. A tenant must be provided as an env variable, in the .env file, or as a CLI option.');
    process.exit(1);
  }

  return argv;
}

// ---------------------------------------------------------------------------
// Schema validation — collection endpoints
// ---------------------------------------------------------------------------

async function validateSchema(httpClient, ajv, path, spec) {
  const responseObj = spec.paths[path].get.responses['200'] || spec.paths[path].get.responses['202'];
  const schema = responseObj.content['application/json'].schema;

  const res = await httpClient.get(path).catch((error) => {
    handleResError(error);
    return null;
  });

  if (!res) {
    return {
      method: 'GET',
      endpoint: path,
      tag: spec.paths[path].get.tags[0],
      status: [STATUS.API_ERROR],
      errors: {}
    };
  }

  const uniqueErrors = {
    method: res.request.method,
    endpoint: path,
    tag: spec.paths[path].get.tags[0],
    status: [],
    errors: {}
  };

  // Skip if the schema itself is malformed (known enum issue in some specs)
  if (!ajv.validateSchema(schema)) {
    return undefined;
  }

  let validate;
  try {
    validate = ajv.compile(normalizeNullable(schema));
  } catch (error) {
    uniqueErrors.errors['Invalid schema'] = { message: error.message, data: null };
    if (!uniqueErrors.status.includes(STATUS.INVALID_SCHEMA)) {
      uniqueErrors.status.push(STATUS.INVALID_SCHEMA);
    }
    return uniqueErrors;
  }

  const passesAJV = validate(res.data);

  const additionalProperties = 'items' in schema
    ? findAdditionalProperties('', res.data[0], schema.items.properties)
    : findAdditionalProperties('', res.data[0], schema.properties);

  if (!passesAJV) {
    for (const error of validate.errors) {
      if (!(error.schemaPath in uniqueErrors.errors)) {
        const message = `Expected that ${error.instancePath} ${error.message}.  Actual value is ${error.data}.`;
        if (!uniqueErrors.status.includes(STATUS.API_SCHEMA_MISMATCH)) {
          uniqueErrors.status.push(STATUS.API_SCHEMA_MISMATCH);
        }
        uniqueErrors.errors[error.schemaPath] = {
          message,
          data: res.data[error.instancePath.split('/')[1]]
        };
      }
    }
  }

  if (additionalProperties.length > 0) {
    for (const additionalProp of additionalProperties) {
      const message = `"${additionalProp}" is an additional property returned by the server, but it is not documented in the specification.`;
      if (!uniqueErrors.status.includes(STATUS.ADDITIONAL_PROPERTIES)) {
        uniqueErrors.status.push(STATUS.ADDITIONAL_PROPERTIES);
      }
      uniqueErrors.errors[additionalProp] = { message, data: res.data[0] };
    }
  }

  return uniqueErrors;
}

// ---------------------------------------------------------------------------
// Per-path dispatcher
// ---------------------------------------------------------------------------

async function validatePath(version, httpClients, ajv, path, specs, skipSchema, skipFilters, skipSorters) {
  const schemaErrors = [];
  const filterErrors = [];
  const sorterErrors = [];

  const specPath = specs[version].paths[path];

  if ('get' in specPath && !path.includes('{')) {
    const responseObj = specPath.get.responses['200'] || specPath.get.responses['202'];
    const contentType = responseObj?.content || {};
    if ('application/json' in contentType) {
      if (!skipSchema) {
        schemaErrors.push(await validateSchema(httpClients[version], ajv, path, specs[version]));
      }
      if (!skipFilters) {
        filterErrors.push(await filterTests.validateFilters(httpClients[version], 'get', path, specs[version]));
      }
      if (!skipSorters) {
        sorterErrors.push(await sorterTests.validateSorters(httpClients[version], 'get', path, specs[version]));
      }
    } else {
      console.log(`Path ${path} uses ${JSON.stringify(Object.keys(contentType))} instead of application/json. Skipping.`);
    }
  }

  if ('get' in specPath && path.includes('{')) {
    const responseObj = specPath.get.responses['200'];
    if (responseObj?.content && 'application/json' in responseObj.content) {
      if (!skipSchema) {
        schemaErrors.push(await validateSchemaForSingleGetResource(version, httpClients, ajv, path, specs));
      }
    }
  }

  const allErrors = schemaErrors.concat(filterErrors).concat(sorterErrors);
  return mergeErrorsByEndpoint(allErrors);
}

// ---------------------------------------------------------------------------
// Error merging
// ---------------------------------------------------------------------------

function mergeErrorsByEndpoint(errorModels) {
  const filterSorterKeys = new Set(['undocumentedFilters', 'unsupportedFilters', 'undocumentedSorters', 'unsupportedSorters']);

  const errorsByEndpoint = {};

  for (const errorModel of errorModels) {
    if (errorModel == null) continue;

    const key = `${errorModel.method}${errorModel.endpoint}`;

    if (key in errorsByEndpoint) {
      if (errorModel.status.length > 0) {
        errorsByEndpoint[key].status.push(...errorModel.status);
      }

      if (errorModel.errors != null && !Object.keys(errorModel.errors).some(k => filterSorterKeys.has(k))) {
        Object.assign(errorsByEndpoint[key].schemaErrors, errorModel.errors);
      }

      if (errorModel.errors.undocumentedFilters?.length > 0) {
        errorsByEndpoint[key].undocumentedFilters.push(...errorModel.errors.undocumentedFilters);
      }
      if (errorModel.errors.unsupportedFilters?.length > 0) {
        errorsByEndpoint[key].unsupportedFilters.push(...errorModel.errors.unsupportedFilters);
      }
      if (errorModel.errors.undocumentedSorters?.length > 0) {
        errorsByEndpoint[key].undocumentedSorters.push(...errorModel.errors.undocumentedSorters);
      }
      if (errorModel.errors.unsupportedSorters?.length > 0) {
        errorsByEndpoint[key].unsupportedSorters.push(...errorModel.errors.unsupportedSorters);
      }
    } else {
      const isFilterSorterError = Object.keys(errorModel.errors).some(k => filterSorterKeys.has(k));
      errorsByEndpoint[key] = {
        method: errorModel.method,
        endpoint: errorModel.endpoint,
        tag: errorModel.tag,
        status: errorModel.status,
        schemaErrors: isFilterSorterError ? {} : errorModel.errors,
        undocumentedFilters: errorModel.errors.undocumentedFilters || [],
        unsupportedFilters: errorModel.errors.unsupportedFilters || [],
        undocumentedSorters: errorModel.errors.undocumentedSorters || [],
        unsupportedSorters: errorModel.errors.unsupportedSorters || []
      };
    }
  }

  return errorsByEndpoint;
}

// ---------------------------------------------------------------------------
// OAuth2
// ---------------------------------------------------------------------------

async function getAccessToken() {
  const axios = require('axios').default;
  const url = `${process.env.BASE_URL}/oauth/token?grant_type=client_credentials&client_id=${process.env.CLIENT_ID}&client_secret=${process.env.CLIENT_SECRET}`;
  const res = await axios.post(url).catch((error) => {
    console.error('Unable to fetch access token. Aborting.');
    console.error(error);
    process.exit(1);
  });
  return res.data.access_token;
}

// ---------------------------------------------------------------------------
// Output helpers
// ---------------------------------------------------------------------------

function handleResError(error) {
  if (error.response) {
    const method = error.response.request?.method;
    const endpoint = error.response.request?.path;
    console.log(`${method} ${endpoint}`);
    console.log(error.response.data);
    console.log(error.response.status);
  } else if (error.request) {
    console.log(error.request);
  } else {
    console.log('Error', error.message);
  }
}

function formatData(data) {
  const stringified = JSON.stringify(data, null, 2);
  const newlines = stringified.replace(/\n/g, '<br>');
  return newlines.replace(/ /g, '&nbsp;');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const apiVersions = ['beta', 'v3', 'v2024', 'v2025', 'v2026'];
  const specs = {};
  const httpClients = {};
  const argv = getArgs();
  const version = argv.input;

  // ------------------------------------------------------------------
  // Spec loading — two styles:
  //   Old (version-level): {specFolder}/v3.yaml
  //   New (resource-level): {specFolder}/{resource}/openapi.yaml
  // ------------------------------------------------------------------

  /**
   * Try to load a single spec. Tries flat file first, then openapi.yaml subdir.
   * Returns the dereferenced spec object, or null if neither location exists.
   */
  async function tryLoadSpec(specFolder, name) {
    const flatPath = path.join(specFolder, `${name}.yaml`);
    if (fs.existsSync(flatPath)) {
      return await SwaggerParser.dereference(flatPath);
    }
    const dirPath = path.join(specFolder, name, 'openapi.yaml');
    console.log(`Attempting to load spec from ${flatPath} or ${dirPath}...`);
    if (fs.existsSync(dirPath)) {
      return await SwaggerParser.dereference(dirPath);
    }
    return null;
  }

  // Load the primary requested spec
  try {
    const loaded = await tryLoadSpec(argv.specFolder, version);
    if (loaded) specs[version] = loaded;
  } catch (e) {
    // Handled below
  }

  if (!specs[version]) {
    console.error(`Spec file for "${version}" not found in ${argv.specFolder}. Aborting.`);
    process.exit(1);
  }

  // Determine whether this is a resource-style spec (server URL has no version suffix)
  const isResourceStyle = !/\/(v\d+|beta)$/.test(specs[version].servers[0].url);

  if (isResourceStyle) {
    // Load all sibling resource specs in parallel for cross-spec path resolution
    try {
      const entries = fs.readdirSync(argv.specFolder, { withFileTypes: true });
      const siblings = entries.filter(e => e.isDirectory() && e.name !== version);
      await Promise.all(siblings.map(async (dir) => {
        const siblingPath = path.join(argv.specFolder, dir.name, 'openapi.yaml');
        if (!fs.existsSync(siblingPath)) return;
        try {
          specs[dir.name] = await SwaggerParser.dereference(siblingPath);
        } catch {
          // Skip unparseable siblings
        }
      }));
    } catch {
      // specFolder may not have subdirectories — that's fine
    }
  } else {
    // Old-style: load the other known version specs for cross-spec resolution
    await Promise.all(apiVersions.filter(v => v !== version).map(async (v) => {
      const specFile = path.join(argv.specFolder, `${v}.yaml`);
      if (!fs.existsSync(specFile)) return;
      try {
        specs[v] = await SwaggerParser.dereference(specFile);
      } catch {
        // Skip missing / unparseable versions
      }
    }));
  }

  const accessToken = await getAccessToken();

  for (const v of Object.keys(specs)) {
    httpClients[v] = buildHttpClient(specs[v], process.env.BASE_URL, accessToken);
  }

  const ajv = new Ajv({
    allErrors: true,
    strictRequired: true,
    strictTypes: true,
    validateFormats: true,
    verbose: true
  });
  addFormats(ajv);
  ajv.addKeyword('x-go-name');
  ajv.addKeyword('x-go-package');
  ajv.addKeyword('x-go-enum-desc');
  ajv.addKeyword('x-miro');
  ajv.addKeyword('example');
  ajv.addKeyword('externalDocs');
  ajv.addFormat('uuid', () => true);
  ajv.addFormat('UUID', () => true);
  ajv.addFormat('date-time', (dateTime) => {
    const noSeconds    = /\d{4}-[01]\d-[0-3]\dT[0-2]\d:[0-5]\d([+-][0-2]\d:[0-5]\d|Z)/;
    const noMillis     = /\d{4}-[01]\d-[0-3]\dT[0-2]\d:[0-5]\d:[0-5]\d([+-][0-2]\d:[0-5]\d|Z)/;
    const fullPrecision = /\d{4}-[01]\d-[0-3]\dT[0-2]\d:[0-5]\d:[0-5]\d\.\d+([+-][0-2]\d:[0-5]\d|Z)/;
    return !!(dateTime.match(noSeconds) || dateTime.match(noMillis) || dateTime.match(fullPrecision));
  });

  const validations = [];

  if (argv.path) {
    if (argv.path in specs[version].paths) {
      validations.push(validatePath(version, httpClients, ajv, argv.path, specs, argv.skipSchema, argv.skipFilters, argv.skipSorters));
    } else {
      console.error(`Path ${argv.path} does not exist in the spec. Aborting...`);
      process.exit(1);
    }
  } else {
    for (const path in specs[version].paths) {
      validations.push(validatePath(version, httpClients, ajv, path, specs, argv.skipSchema, argv.skipFilters, argv.skipSorters));
    }
  }

  const results = await Promise.all(validations);

  let totalErrors = 0;
  let output = '';

  if (argv['github-action']) {
    results.forEach(entry => {
      Object.keys(entry).forEach((endpointKey) => {
        const ep = entry[endpointKey];
        const hasErrors = Object.keys(ep.schemaErrors).length !== 0 ||
          ep.undocumentedFilters.length !== 0 ||
          ep.unsupportedFilters.length !== 0 ||
          ep.undocumentedSorters.length !== 0 ||
          ep.unsupportedSorters.length !== 0;

        if (!hasErrors) return;

        output += `|${ep.method} ${ep.endpoint}|`;

        Object.keys(ep.schemaErrors).forEach((field) => {
          if (ep.schemaErrors[field].data != null) {
            output += `<details closed><summary>${ep.schemaErrors[field].message}</summary><pre>${formatData(ep.schemaErrors[field].data)}</pre></details>`;
          } else {
            output += `<details closed><summary>${ep.schemaErrors[field].message}</summary>`;
          }
          totalErrors += 1;
        });

        for (const item of ep.undocumentedFilters) { output += `<p>${item.message}</p>`; totalErrors += 1; }
        for (const item of ep.unsupportedFilters)  { output += `<p>${item.message}</p>`; totalErrors += 1; }
        for (const item of ep.undocumentedSorters) { output += `<p>${item.message}</p>`; totalErrors += 1; }
        for (const item of ep.unsupportedSorters)  { output += `<p>${item.message}</p>`; totalErrors += 1; }

        output += '|\\n';
      });
    });
  } else {
    results.forEach(entry => {
      Object.keys(entry).forEach((endpointKey) => {
        const ep = entry[endpointKey];
        const hasErrors = Object.keys(ep.schemaErrors).length !== 0 ||
          ep.undocumentedFilters.length !== 0 ||
          ep.unsupportedFilters.length !== 0 ||
          ep.undocumentedSorters.length !== 0 ||
          ep.unsupportedSorters.length !== 0;

        if (!hasErrors) return;

        output += `Errors found in ${ep.method} ${ep.endpoint}\n\n`;

        Object.keys(ep.schemaErrors).forEach((field) => {
          output += `- ${ep.schemaErrors[field].message}\n`;
          totalErrors += 1;
        });

        for (const item of ep.undocumentedFilters) { output += `- ${item.message}\n`; totalErrors += 1; }
        for (const item of ep.unsupportedFilters)  { output += `- ${item.message}\n`; totalErrors += 1; }
        for (const item of ep.undocumentedSorters) { output += `- ${item.message}\n`; totalErrors += 1; }
        for (const item of ep.unsupportedSorters)  { output += `- ${item.message}\n`; totalErrors += 1; }

        output += '\n\n';
      });
    });

    if (totalErrors > 0) {
      output += `Total errors: ${totalErrors}`;
    }
  }

  if (argv['generate-coverage-report']) {
    const filteredResults = results.filter(obj => Object.keys(obj).length > 0);
    const totalEndpoints = Object.keys(specs[version].paths).length;

    if (argv['use-report-mock-data']) {
      const mockData = JSON.parse(fs.readFileSync('mockCoverageReport.json', 'utf8'));
      fs.writeFileSync(`${version}CoverageReport.html`, generateHtmlReport(mockData, totalEndpoints, version));
    } else {
      fs.writeFileSync(`${version}CoverageReport.html`, generateHtmlReport(filteredResults, totalEndpoints, version));
    }
  }

  if (totalErrors > 0) {
    console.log(output);
    process.exit(1);
  }
}

main();

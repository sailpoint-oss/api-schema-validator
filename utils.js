'use strict';

const axios = require('axios').default;
const axiosRetry = require('axios-retry').default;

const STATUS = Object.freeze({
  INVALID_SCHEMA: 'INVALID_SCHEMA',
  API_SCHEMA_MISMATCH: 'API_SCHEMA_MISMATCH',
  ADDITIONAL_PROPERTIES: 'ADDITIONAL_PROPERTIES',
  UNDOCUMENTED_FILTERS: 'UNDOCUMENTED_FILTERS',
  UNSUPPORTED_FILTERS: 'UNSUPPORTED_FILTERS',
  UNDOCUMENTED_SORTERS: 'UNDOCUMENTED_SORTERS',
  UNSUPPORTED_SORTERS: 'UNSUPPORTED_SORTERS',
  NO_DATA: 'NO_DATA',
  PATH_PARAM_UNRESOLVED: 'PATH_PARAM_UNRESOLVED',
  SCHEMA_NOT_FOUND: 'SCHEMA_NOT_FOUND',
  API_ERROR: 'API_ERROR'
});

// ---------------------------------------------------------------------------
// HTTP client factory — supports both URL routing patterns:
//   Old: BASE_URL/{version}/resource  (server URL ends with /v3, /beta, /v2024, etc.)
//   New: BASE_URL/resource/v{x}/resource  (server URL is just the domain, version is inline in path)
// ---------------------------------------------------------------------------
function buildHttpClient(spec, baseUrl, token) {
  const serverUrl = spec.servers[0].url;
  const isVersionPrefixed = /\/(v\d+|beta)$/.test(serverUrl);
  const computedBaseURL = isVersionPrefixed
    ? baseUrl + '/' + serverUrl.split('/').pop()
    : baseUrl;

  const client = axios.create({
    baseURL: computedBaseURL,
    timeout: 20000,
    headers: {
      'Authorization': `Bearer ${token}`,
      'X-SailPoint-Experimental': true,
      'SLPT-ROUTE-SPEC': 'dev-test_feature_v1-routes'
    }
  });

  axiosRetry(client, {
    retries: 1000,
    retryDelay: (retryCount) => retryCount * 2000,
    retryCondition: (error) => {
      return error.response?.status === 429 || error.response?.status === 502;
    },
    shouldResetTimeout: true
  });

  return client;
}

// ---------------------------------------------------------------------------
// Shared schema helpers
// ---------------------------------------------------------------------------

/**
 * OpenAPI 3.0 uses `{ nullable: true }` as a standalone allOf entry to express
 * "this field can also be null" — e.g. `allOf: [{ $ref: Foo }, { nullable: true }]`.
 * AJV 8.17+ rejects schemas where `nullable` appears without a sibling `type`.
 *
 * This normalizer strips those standalone { nullable } entries from allOf arrays
 * (and recurses into all sub-schemas) before the schema is passed to ajv.compile().
 * An entry is considered "standalone nullable" if it has the `nullable` key but
 * none of the type-constraining keywords (type, $ref, properties, items, allOf,
 * anyOf, oneOf, enum, format, pattern, minimum, maximum, etc.).
 * Metadata-only keys (description, example, title) are ignored.
 * Schemas of the form `{ type: 'string', nullable: true }` are already handled
 * natively by AJV and are left untouched.
 */

const VALIDATING_KEYWORDS = new Set([
  'type', '$ref', 'properties', 'items', 'allOf', 'anyOf', 'oneOf', 'not',
  'enum', 'format', 'pattern', 'minimum', 'maximum', 'exclusiveMinimum',
  'exclusiveMaximum', 'minLength', 'maxLength', 'minItems', 'maxItems',
  'minProperties', 'maxProperties', 'required', 'additionalProperties',
  'const', 'if', 'then', 'else', 'contains', 'unevaluatedProperties'
]);

function isStandaloneNullable(entry) {
  if (typeof entry !== 'object' || entry === null || !('nullable' in entry)) return false;
  return !Object.keys(entry).some(k => VALIDATING_KEYWORDS.has(k));
}

function normalizeNullable(schema) {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return schema;
  let s = { ...schema };

  if (typeof s.properties === 'object' && s.properties !== null) {
    const props = {};
    for (const [k, v] of Object.entries(s.properties)) props[k] = normalizeNullable(v);
    s.properties = props;
  }
  if (s.items) s.items = normalizeNullable(s.items);
  if (Array.isArray(s.anyOf)) s.anyOf = s.anyOf.map(normalizeNullable);
  if (Array.isArray(s.oneOf)) s.oneOf = s.oneOf.map(normalizeNullable);

  if (Array.isArray(s.allOf)) {
    const filtered = s.allOf
      .filter(entry => !isStandaloneNullable(entry))
      .map(normalizeNullable);
    if (filtered.length === 0) delete s.allOf;
    else s.allOf = filtered;
  }

  return s;
}

/**
 * Recursively walk response data against spec schema properties and collect
 * dot-notation paths for fields that are present in the data but absent from
 * the schema (i.e. additional/undocumented properties).
 */
function findAdditionalProperties(path, data, schema) {
  let additionalProps = [];
  for (const prop in data) {
    if (schema != undefined) {
      const fullPath = path === '' ? prop : path + '.' + prop;
      if (!(prop in schema)) {
        additionalProps.push(fullPath);
      } else if (
        Array.isArray(data[prop]) &&
        typeof data[prop][0] === 'object' &&
        schema[prop].type === 'array' &&
        schema[prop].items?.type === 'object'
      ) {
        const result = findAdditionalProperties(fullPath, data[prop][0], schema[prop].items.properties);
        if (result.length > 0) additionalProps = additionalProps.concat(result);
      } else if (data[prop] != null && !Array.isArray(data[prop]) && typeof data[prop] === 'object') {
        const result = findAdditionalProperties(fullPath, data[prop], schema[prop].properties);
        if (result.length > 0) additionalProps = additionalProps.concat(result);
      }
    }
  }
  return additionalProps;
}

// ---------------------------------------------------------------------------
// Path resolution helpers
// ---------------------------------------------------------------------------

/**
 * Search all spec versions for any path+method whose operationId matches.
 * Returns an array of { version, method, path } objects.
 */
function findPathWithOperationId(specs, operationId) {
  const result = [];
  for (const version in specs) {
    for (const path in specs[version].paths) {
      const methods = specs[version].paths[path];
      for (const method in methods) {
        const operation = methods[method];
        if (operation.operationId === operationId) {
          result.push({ version, method, path });
        }
      }
    }
  }
  return result;
}

/**
 * Given an array of { version, path } entries from findPathWithOperationId,
 * return the entry for the requested version. Falls back in priority order:
 * v2026 → v2025 → v2024 → v3 → beta.
 */
function findSpecByVersion(paths, version) {
  const priority = ['v2026', 'v2025', 'v2024', 'v3', 'beta'];

  const exactMatch = paths.find(p => p.version === version);
  if (exactMatch) return exactMatch;

  for (const fallback of priority) {
    const fallbackMatch = paths.find(p => p.version === fallback);
    if (fallbackMatch) return fallbackMatch;
  }

  return null;
}

function findValueByKey(response, keyToFind) {
  if (typeof response !== 'object' || response === null) return null;

  for (const key in response) {
    if (key === keyToFind) return response[key];
  }

  return response.id ? response.id : response.name;
}

async function findValidPathFromResponse(response, httpClients, version, path, paramName) {
  const regex = /{([^}]+)}/g;

  // Quick check: if the first record directly resolves without more params, use it
  const identifier0 = findValueByKey(response[0], paramName.slice(1, -1));
  const testPath0 = path.replace(paramName, identifier0);
  if (testPath0.match(regex)) return testPath0; // still has unresolved params — return as-is for outer loop

  let resolvedPath = '';

  if (Array.isArray(response)) {
    for (const record of response) {
      const identifier = findValueByKey(record, paramName.slice(1, -1));
      const testPath = path.replace(paramName, identifier);

      try {
        const rootResponse = await httpClients[version].get(testPath);
        if (rootResponse.data) {
          resolvedPath = path.replace(paramName, identifier);
          break;
        }
      } catch {
        // try next record
      }
    }
  } else if (typeof response === 'object' && response !== null) {
    const identifier = findValueByKey(response, paramName.slice(1, -1));
    const testPath = path.replace(paramName, identifier);
    try {
      const rootResponse = await httpClients[version].get(testPath);
      if (rootResponse.data) {
        resolvedPath = path.replace(paramName, identifier);
      }
    } catch {
      // no-op
    }
  }

  return resolvedPath;
}

/**
 * Substitute real IDs/values into all {param} tokens in a parameterized path
 * so that a single-resource GET can be executed.
 */
async function resolvePath(version, httpClients, path, specs) {
  let resolvedPath = path;
  const regex = /{([^}]+)}/g;

  while (regex.test(resolvedPath)) {
    const match = resolvedPath.match(regex);
    if (!match) break;

    let rootPath = resolvedPath.split(match[0])[0].slice(0, -1);
    const paramName = match[0].slice(1, -1);
    const parameterSpec = specs[version].paths[path]?.get?.parameters?.find(
      (param) => param.name === paramName
    );

    if (parameterSpec?.['x-sailpoint-resource-operation-id'] !== undefined) {
      const paths = findPathWithOperationId(specs, parameterSpec['x-sailpoint-resource-operation-id']);
      const resource = findSpecByVersion(paths, version);

      if (resource === null) return undefined;

      if (!resource.path.match(regex)) {
        rootPath = resource.path;
        version = resource.version;
      } else {
        if (path === resource.path) return undefined; // circular reference guard
        rootPath = await resolvePath(resource.version, httpClients, resource.path, specs);
      }
    }

    if (parameterSpec?.schema?.enum) {
      let validResponse = null;

      for (const enumValue of parameterSpec.schema.enum) {
        const testPath = resolvedPath.replace(match[0], enumValue);

        try {
          const rootResponse = await httpClients[version].get(testPath);

          if (rootResponse.data && rootResponse.data.length > 0) {
            validResponse = rootResponse;
            resolvedPath = resolvedPath.replace(match[0], enumValue);
            break;
          }
        } catch {
          // Handle /search/ paths that require a POST-style resolution
          if (testPath.includes('/search/')) {
            const searchMatch = testPath.match(regex);
            const searchParamName = searchMatch ? searchMatch[0].slice(1, -1) : null;
            const searchParamSpec = searchParamName
              ? specs[version].paths[path]?.get?.parameters?.find(p => p.name === searchParamName)
              : null;

            if (searchParamSpec?.['x-sailpoint-resource-operation-id'] !== undefined) {
              const opPaths = findPathWithOperationId(
                specs,
                searchParamSpec['x-sailpoint-resource-operation-id'][0]
              );
              const searchResource = findSpecByVersion(opPaths, version);

              if (searchResource && !searchResource.path.match(regex)) {
                resolvedPath = testPath;
                rootPath = searchResource.path;

                const rootResponse = await httpClients[searchResource.version]
                  .get(rootPath)
                  .catch(() => null);

                if (!rootResponse || rootResponse.data.length === 0) return undefined;

                const items = rootResponse.data.items || rootResponse.data;
                const finalPath = await findValidPathFromResponse(
                  items,
                  httpClients,
                  version,
                  resolvedPath,
                  searchMatch[0]
                );

                resolvedPath = finalPath;
                validResponse = true;
                break;
              }
            }
          }
        }
      }

      if (!validResponse) return undefined;
    } else {
      const rootResponse = await httpClients[version].get(rootPath).catch(() => null);

      if (!rootResponse || rootResponse.data.length === 0) return undefined;

      const items = rootResponse.data.items || rootResponse.data;
      const finalPath = await findValidPathFromResponse(items, httpClients, version, resolvedPath, match[0]);
      resolvedPath = finalPath;
    }
  }

  return resolvedPath;
}

// ---------------------------------------------------------------------------
// Single-resource GET schema validator
// ---------------------------------------------------------------------------

async function validateSchemaForSingleGetResource(version, httpClients, ajv, path, specs) {
  let schema = specs[version].paths[path].get.responses['200']?.content?.['application/json']?.schema;

  if (schema === undefined) {
    return {
      method: 'GET',
      endpoint: path,
      tag: specs[version].paths[path].get.tags[0],
      status: [STATUS.SCHEMA_NOT_FOUND],
      errors: {
        'Schema not found': { message: 'Schema not found under 200 response', data: null }
      }
    };
  }

  if (schema.anyOf !== undefined) {
    schema = schema.anyOf[0];
  } else if (schema.oneOf !== undefined) {
    schema = schema.oneOf[0];
  }

  const resolvedPath = await resolvePath(version, httpClients, path, specs);

  if (!resolvedPath) {
    return {
      method: 'GET',
      endpoint: path,
      tag: specs[version].paths[path].get.tags[0],
      status: [STATUS.PATH_PARAM_UNRESOLVED],
      errors: {}
    };
  }

  const result = await httpClients[version].get(resolvedPath).catch(() => null);

  if (!result) {
    return {
      method: 'GET',
      endpoint: path,
      tag: specs[version].paths[path].get.tags[0],
      status: [STATUS.API_ERROR],
      errors: {}
    };
  }

  if (result.data.length === 0) {
    return {
      method: 'GET',
      endpoint: path,
      tag: specs[version].paths[path].get.tags[0],
      status: [STATUS.NO_DATA],
      errors: {}
    };
  }

  let uniqueErrors = {
    method: result.request.method,
    endpoint: path,
    status: [],
    tag: specs[version].paths[path].get.tags[0],
    errors: {}
  };

  if (!ajv.validateSchema(schema)) {
    ajv.errors.forEach((error) => {
      if (!uniqueErrors.status.includes(STATUS.INVALID_SCHEMA)) {
        uniqueErrors.status.push(STATUS.INVALID_SCHEMA);
      }
      uniqueErrors.errors[error.instancePath] = {
        message: `Invalid Schema: ${error.instancePath} - ${error.message}`,
        data: error.data
      };
    });
    return uniqueErrors;
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

  const passesAJV = validate(result.data);

  const dataArray = Array.isArray(result.data) ? result.data : [result.data];

  const additionalProperties = 'items' in schema
    ? findAdditionalProperties('', dataArray[0], schema.items.properties)
    : findAdditionalProperties('', dataArray[0], schema.properties);

  if (!passesAJV) {
    for (const error of validate.errors) {
      if (!(error.schemaPath in uniqueErrors.errors)) {
        const message = `Expected that ${error.instancePath || 'response body'} ${error.message}. Actual value is ${error.data}.`;
        if (!uniqueErrors.status.includes(STATUS.API_SCHEMA_MISMATCH)) {
          uniqueErrors.status.push(STATUS.API_SCHEMA_MISMATCH);
        }
        uniqueErrors.errors[error.schemaPath] = {
          message,
          data: dataArray[error.instancePath.split('/')[1]]
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
      uniqueErrors.errors[additionalProp] = { message, data: dataArray[0] };
    }
  }

  return uniqueErrors;
}

// ---------------------------------------------------------------------------
// POST validator stub (not called from main flow)
// ---------------------------------------------------------------------------

async function validateSchemaForPost(version, httpClient, ajv, path, specs) {
  const spec = specs[version];
  const schema = spec.paths[path].post.responses['201']
    ? spec.paths[path].post.responses['201'].content['application/json'].schema
    : spec.paths[path].post.responses['202'].content['application/json'].schema;

  const postBody = createExample(spec.paths[path].post.requestBody.content['application/json'].schema);

  const res = await httpClient.post(path, postBody).catch((error) => ({
    errors: { 'Request failed': { message: error.response?.data?.detailCode, data: null } }
  }));

  if (res.errors !== undefined) return res;

  const uniqueErrors = { method: res.request?.method, endpoint: res.request?.path, errors: {} };

  if (res.data?.id) {
    await cleanup(httpClient, path, res.data.id).catch(() => {});
  }

  let validate;
  try {
    validate = ajv.compile(normalizeNullable(schema));
  } catch (error) {
    uniqueErrors.errors['Invalid schema'] = { message: error.message, data: null };
    return uniqueErrors;
  }

  const passesAJV = validate(res.data);
  const dataArray = Array.isArray(res.data) ? res.data : [res.data];

  const additionalProperties = 'items' in schema
    ? findAdditionalProperties('', dataArray[0], schema.items.properties)
    : findAdditionalProperties('', dataArray[0], schema.properties);

  if (!passesAJV) {
    for (const error of validate.errors) {
      if (!(error.schemaPath in uniqueErrors.errors)) {
        const message = `Expected that ${error.instancePath} ${error.message}.  Actual value is ${error.data}.`;
        uniqueErrors.errors[error.schemaPath] = {
          message,
          data: dataArray[error.instancePath.split('/')[1]]
        };
      }
    }
  }

  if (additionalProperties.length > 0) {
    for (const additionalProp of additionalProperties) {
      uniqueErrors.errors[additionalProp] = {
        message: `"${additionalProp}" is an additional property returned by the server, but it is not documented in the specification.`,
        data: dataArray[0]
      };
    }
  }

  return uniqueErrors;
}

function createExample(schema) {
  if (!('readOnly' in schema) || ('readOnly' in schema && !schema.readOnly)) {
    if (schema.type === 'object') {
      if ('example' in schema) return schema.example;
      const example = {};
      if ('properties' in schema) {
        for (const [key, value] of Object.entries(schema.properties)) {
          example[key] = createExample(value);
        }
      }
      return example;
    } else if (schema.type === 'array') {
      if ('example' in schema && !('example' in schema.items)) return schema.example;
      return [createExample(schema.items)];
    } else if (schema.type === 'string') {
      return 'example' in schema ? schema.example : 'example';
    } else if (schema.type === 'integer') {
      return 'example' in schema ? schema.example : 1;
    } else if (schema.type === 'boolean') {
      return 'example' in schema ? schema.example : true;
    }
  }
}

async function cleanup(httpClient, path, id) {
  await httpClient.delete(path + '/' + id).catch(() => {});
}

module.exports = {
  STATUS,
  buildHttpClient,
  findAdditionalProperties,
  findPathWithOperationId,
  findSpecByVersion,
  normalizeNullable,
  resolvePath,
  validateSchemaForSingleGetResource,
  validateSchemaForPost
};

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

async function validateSchemaForPost(version, httpClient, ajv, path, specs) {
  const schema = spec.paths[path].post.responses["201"]
    ? spec.paths[path].post.responses["201"].content["application/json"].schema
    : spec.paths[path].post.responses["202"].content["application/json"].schema;

  const postBody = createExample(
    spec.paths[path].post.requestBody.content["application/json"].schema
  );

  console.debug(postBody);

  res = await httpClient.post(path, postBody).catch((error) => {
    uniqueErrors = {
      method: error.request.method,
      endpoint: error.request.path,
      errors: {},
    };

    uniqueErrors.errors["Request failed"] = {
      message: error.response.data.detailCode,
      data: null,
    };
    console.debug(error.response.data);

    return uniqueErrors;
  });

  if (res.errors == undefined) {
    uniqueErrors = {
      method: res.request?.method,
      endpoint: res.request?.path,
      errors: {},
    };

    console.debug(res.data);
    // // TODO: Fix the workflows creator/owner enum issue and then remove this code.
    // if (!ajv.validateSchema(schema)) {
    //     console.log(`The schema for path ${path} is invalid.\n${JSON.stringify(schema)}`)
    //     return undefined;
    // }

    if (res.data?.id) {
      await cleanup(httpClient, path, res.data.id)
        .then(() => {
          console.log("Cleanup successful");
        })
        .catch((error) => {
          console.log(error.response.data);
        });
    }

    let validate = undefined;
    try {
      validate = ajv.compile(schema);
    } catch (error) {
      uniqueErrors.errors["Invalid schema"] = {
        message: error.message,
        data: null,
      };
      return uniqueErrors;
    }

    const passesAJV = validate(res.data);

    // Check for additional properties not defined in the schema

    res.data = Array.isArray(res.data) ? res.data : [res.data];

    const additionalProperties =
      "items" in schema
        ? findAdditionalProperties("", res.data[0], schema.items.properties)
        : findAdditionalProperties("", res.data[0], schema.properties);
    const hasAdditionalProperties =
      Object.keys(additionalProperties).length === 0 ? false : true;

    // If AJV finds issues, report each issue
    if (!passesAJV) {
      // Since there can be up to 250 items in the response data, we don't want to have
      // the same error message appear multiple times.
      // This will allow us to have one error for each unique schema violation.
      for (const error of validate.errors) {
        if (!(error.schemaPath in uniqueErrors.errors)) {
          message = `Expected that ${error.instancePath} ${error.message}.  Actual value is ${error.data}.`;
          uniqueErrors.errors[error.schemaPath] = {
            message,
            data: res.data[error.instancePath.split("/")[1]],
          };
        }
      }
    }

    // If there are additional properties, report each property
    if (hasAdditionalProperties) {
      for (const additionalProp of additionalProperties) {
        message = `"${additionalProp}" is an additional property returned by the server, but it is not documented in the specification.`;
        uniqueErrors.errors[additionalProp] = {
          message,
          data: res.data[0],
        };
      }
    }

    return uniqueErrors;
  } else {
    return res;
  }
}

function findPathWithOperationId(specs, operationId) {
  const result = [];
  // const paths = spec.paths;

  // Iterate through paths and methods to find the matching operationId
  for(const version in specs) {
    for (const path in specs[version].paths) {
      const methods = specs[version].paths[path];
      for (const method in methods) {
        const operation = methods[method];
        if (operation.operationId === operationId) {
          result.push({version, method, path});
        }
      }
    }
  }

  return result;
}

function findSpecByVersion(paths, version) {
  const priority = ["v2024", "v3", "beta"];

  // Try to find exact match
  const exactMatch = paths.find(p => p.version === version);
  if (exactMatch) return exactMatch;

  // Fallback to the first available spec in priority order
  for (const fallback of priority) {
      const fallbackMatch = paths.find(p => p.version === fallback);
      if (fallbackMatch) return fallbackMatch;
  }

  return null; // If no match is found
}

async function validateSchemaForSingleGetResource(
  version,
  httpClients,
  ajv,
  path,
  specs
) {

  console.log(`Validating schema for path: ${path}`);
  let schema =
    specs[version].paths[path].get.responses["200"].content["application/json"]
      .schema;

  if(schema !== undefined) {
    if (schema.anyOf !== undefined) {
      schema = schema.anyOf[0];
    } else if (schema.oneOf !== undefined) {
      schema = schema.oneOf[0];
    }
  } else {
    return {
      method: "GET",
      endpoint: path,
      tag: specs[version].paths[path].get.tags[0],
      status: [STATUS.SCHEMA_NOT_FOUND],
      errors: {
        "Schema not found": {
          message: "Schema not found under 200 response",
          data: null,
        },
      },
    }; 
  }

  const resolvedPath = await resolvePath(version, httpClients, path, specs);

  if (!resolvedPath) {
    return {
      method: "GET",
      endpoint: path,
      tag: specs[version].paths[path].get.tags[0],
      status: [STATUS.PATH_PARAM_UNRESOLVED],
      errors: {},
    };
  }

  // console.debug(`Fully resolved path: ${resolvedPath}`);

  const result = await httpClients[version].get(resolvedPath).catch((error) => {
    console.debug("Error Message: " + JSON.stringify(error.response?.data));
  });

  if (result) {
    if (result.data.length === 0) {
      // console.log(`No data found for path ${path}`);
      return {
        method: "GET",
        endpoint: path,
        tag: specs[version].paths[path].get.tags[0],
        status: [STATUS.NO_DATA],
        errors: {},
      };
    }

    let uniqueErrors = {
      method: result.request.method,
      endpoint: path,
      status: [],
      tag: specs[version].paths[path].get.tags[0],
      errors: {},
    };

    if (!ajv.validateSchema(schema)) {
      console.log(
        `The schema for path ${path} is invalid.\n${JSON.stringify(ajv.errors)}`
      );

      ajv.errors.forEach((error) => {
        if (!uniqueErrors.status.includes(STATUS.INVALID_SCHEMA)) {
          uniqueErrors.status.push(STATUS.INVALID_SCHEMA);
      }
        uniqueErrors.errors[error.instancePath] = {
          message: `Invalid Schema: ${error.instancePath} - ${error.message}`,
          data: error.data,
        };
      });

      return uniqueErrors;
    }

    let validate;
    try {
      validate = ajv.compile(schema);
    } catch (error) {
      uniqueErrors.errors["Invalid schema"] = {
        message: error.message,
        data: null,
      };
      return uniqueErrors;
    }

    const passesAJV = validate(result.data);

    result.data = Array.isArray(result.data) ? result.data : [result.data];

    const additionalProperties =
      "items" in schema
        ? findAdditionalProperties("", result.data[0], schema.items.properties)
        : findAdditionalProperties("", result.data[0], schema.properties);

    const hasAdditionalProperties =
      Object.keys(additionalProperties).length === 0 ? false : true;

    if (!passesAJV) {
      for (const error of validate.errors) {
        if (!(error.schemaPath in uniqueErrors.errors)) {
          const message = `Expected that ${
            error.instancePath || "response body"
          } ${error.message}. Actual value is ${error.data}.`;
            if (!uniqueErrors.status.includes(STATUS.API_SCHEMA_MISMATCH)) {
              uniqueErrors.status.push(STATUS.API_SCHEMA_MISMATCH);
            }
            uniqueErrors.errors[error.schemaPath] = {
            message,
            data: result.data[error.instancePath.split("/")[1]],
          };
        }
      }
    }

    if (hasAdditionalProperties) {
      for (const additionalProp of additionalProperties) {
        const message = `"${additionalProp}" is an additional property returned by the server, but it is not documented in the specification.`;
        if (!uniqueErrors.status.includes(STATUS.ADDITIONAL_PROPERTIES)) {
          uniqueErrors.status.push(STATUS.ADDITIONAL_PROPERTIES);
        }
        uniqueErrors.errors[additionalProp] = {
          message,
          data: result.data[0],
        };
      }
    }

    return uniqueErrors;
  } else {
    return uniqueErrors = {
      method: "GET",
      endpoint: path,
      tag: specs[version].paths[path].get.tags[0],
      status: [STATUS.API_ERROR],
      errors: {}
  };
  }
}

async function resolvePath(version, httpClients, path, specs) {
  // Get the schema of the response of the GET request
  let resolvedPath = path;
  const regex = /{([^}]+)}/g; // Matches content inside curly brackets

  while (regex.test(resolvedPath)) {
    const match = resolvedPath.match(regex);
    if (!match) break;

    let rootPath = resolvedPath.split(match[0])[0].slice(0, -1); // Remove the trailing /
    const paramName = match[0].slice(1, -1); // Extract the variable name without {}
    const parameterSpec = specs[version].paths[path]?.get?.parameters?.find(
      (param) => param.name === paramName
    );

    if (parameterSpec?.["x-sailpoint-resource-operation-id"] !== undefined) {
      const paths = findPathWithOperationId(
        specs,
        parameterSpec["x-sailpoint-resource-operation-id"]
      );

      //console.log(`Paths for operationId ${parameterSpec["x-sailpoint-resource-operation-id"]}: ${JSON.stringify(paths)}`);

      const resource = findSpecByVersion(paths, version)

      if(resource === null) {
        console.log(`Resource for path ${path} ${version}: ${JSON.stringify(resource)}`);
      }

      if (!resource.path.match(regex)) {
        rootPath = resource.path;
        version = resource.version;
      } else {
        
        if(path === resource.path) {
          console.log(`Circular reference detected for path ${path}`);
          return undefined;
        }

        rootPath = await resolvePath(resource.version, httpClients, resource.path, specs);
      }
    }

    if (parameterSpec?.schema?.enum) {
      let validResponse = null;

      for (const enumValue of parameterSpec.schema.enum) {
        const testPath = resolvedPath.replace(match[0], enumValue);
        // console.debug(
        //   `Testing ENUM variable ${match[0]} with value ${enumValue}. Path: ${testPath}`
        // );

        try {
          const rootResponse = await httpClients["v2024"].get(testPath);

          if (rootResponse.data && rootResponse.data.length > 0) {
            validResponse = rootResponse;
            resolvedPath = resolvedPath.replace(match[0], enumValue);
            // console.debug(
            //   `Resolved ENUM variable ${match[0]} with value ${enumValue}. Current path: ${resolvedPath}`
            // );
            break;
          } else {
            console.debug(`No data found for ENUM value ${enumValue}.`);
          }
        } catch (error) {
          console.log(
            `Error testing ENUM value ${enumValue}: ${
              error.response?.data || error.message
            }`
          );

          //Hard code for now. Need to find a better way to handle this.
          if (testPath.includes("/search/")) {

            const match = testPath.match(regex);
            const paramName = match[0].slice(1, -1); // Extract the variable name without {}
            const parameterSpec = specs[version].paths[
              path
            ]?.get?.parameters?.find((param) => param.name === paramName);

            if (
              parameterSpec?.["x-sailpoint-resource-operation-id"] !== undefined
            ) {
              const paths = findPathWithOperationId(
                specs,
                parameterSpec["x-sailpoint-resource-operation-id"][0]
              );

              const resource = findSpecByVersion(paths, version)

              if (!resource.path.match(regex)) {
                resolvedPath = testPath;
                rootPath = resource.path;

                const rootResponse = await httpClients[resource.version]
                  .get(rootPath)
                  .catch((error) => {
                    console.debug(error.response.data);
                  });

                if (!rootResponse || rootResponse.data.length === 0) {
                  console.debug(`No data found in ${rootPath}`);
                  return undefined;
                }

                let finalPath = null;

                if (rootResponse.data.items) {
                  finalPath = await findValidPathFromResponse(
                    rootResponse.data.items,
                    httpClients,
                    resolvedPath,
                    match[0]
                  );
                } else {
                  finalPath = await findValidPathFromResponse(
                    rootResponse.data,
                    httpClients,
                    resolvedPath,
                    match[0]
                  );
                }

                resolvedPath = finalPath;
                validResponse = true;

                break;
              }
            }
          }
        }
      }

      if (!validResponse) {
        console.debug(
          `Exhausted ENUM values for ${match[0]} without valid data.`
        );
        return undefined;
      }
    } else {
      const rootResponse = await httpClients[version]
        .get(rootPath)
        .catch((error) => {
          console.debug(error.response.data);
        });

      if (!rootResponse || rootResponse.data.length === 0) {
        console.debug(`No data found in ${rootPath}`);
        return undefined;
      }

      let finalPath = null;

      if (rootResponse.data.items) {
        finalPath = await findValidPathFromResponse(
          rootResponse.data.items,
          httpClients,
          resolvedPath,
          match[0]
        );
      } else {
        finalPath = await findValidPathFromResponse(
          rootResponse.data,
          httpClients,
          resolvedPath,
          match[0]
        );
      }

      resolvedPath = finalPath;
    }
  }

  return resolvedPath;
}

async function findValidPathFromResponse(
  response,
  httpClients,
  path,
  paramName
) {
  let identifier = findValueByKey(response[0], paramName.slice(1, -1));
  const testPath = path.replace(paramName, identifier);
  const regex = /{([^}]+)}/g;
  const match = testPath.match(regex);
  if (match) return testPath;

  let resolvedPath = "";
  if (Array.isArray(response)) {
    for (record of response) {
      let identifier = findValueByKey(record, paramName.slice(1, -1));
      const testPath = path.replace(paramName, identifier);
      // console.debug(
      //   `Testing variable ${paramName} with value ${identifier}. Path: ${testPath}`
      // );

      try {
        const rootResponse = await httpClients["v2024"].get(testPath);

        if (rootResponse.data) {
          validResponse = rootResponse;
          resolvedPath = path.replace(paramName, identifier);
          // console.debug(
          //   `Resolved variable ${paramName} with value ${identifier}. Current path: ${resolvedPath}`
          // );
          break;
        } else {
          // console.log(`No data found for value ${identifier}.`);
        }
      } catch (error) {
        // console.log(
        //   `Error testing value ${identifier}: ${
        //     JSON.stringify(error.response?.data) ||
        //     JSON.stringify(error.message)
        //   }`
        // );
      }
    }

  } else if (typeof response === "object" && response !== null) {
    let identifier = findValueByKey(response, paramName.slice(1, -1));
    const testPath = path.replace(paramName, identifier);
    try {
      const rootResponse = await httpClients["v2024"].get(testPath);

      if (rootResponse.data) {
        validResponse = rootResponse;
        resolvedPath = path.replace(paramName, identifier);
        // console.debug(
        //   `Resolved variable ${paramName} with value ${identifier}. Current path: ${resolvedPath}`
        // );
      } else {
        console.debug(`No data found for value ${identifier}.`);
      }
    } catch (error) {
      console.log(
        `Error testing value ${identifier}: ${
          JSON.stringify(error.response?.data) || JSON.stringify(error.message)
        }`
      );
    }
  } else {
    console.debug("Invalid response object");
  }
  return resolvedPath;
}

function findValueByKey(response, keyToFind) {
  if (typeof response !== "object" || response === null) return null;

  for (const key in response) {
    if (key === keyToFind) return response[key];
  }

  const identifier = response.id ? response.id : response.name;

  return identifier;
}

function findAdditionalProperties(path, data, schema) {
  let additionalProps = [];
  for (const prop in data) {
    if (schema != undefined) {
      const fullPath = path === "" ? prop : path + "." + prop;
      if (!(prop in schema)) {
        additionalProps.push(fullPath);
      } else if (
        Array.isArray(data[prop]) &&
        typeof data[prop][0] === "object" &&
        schema[prop].type === "array" &&
        schema[prop].items.type === "object"
      ) {
        const result = findAdditionalProperties(
          fullPath,
          data[prop][0],
          schema[prop].items.properties
        );
        if (result.length > 0) {
          additionalProps = additionalProps.concat(result);
        }
      } else if (
        data[prop] != null &&
        !Array.isArray(data[prop]) &&
        typeof data[prop] === "object"
      ) {
        const result = findAdditionalProperties(
          fullPath,
          data[prop],
          schema[prop].properties
        );
        if (result.length > 0) {
          additionalProps = additionalProps.concat(result);
        }
      }
    }
  }

  return additionalProps;
}

function createExample(schema) {
  if (!("readOnly" in schema) || ("readOnly" in schema && !schema.readOnly)) {
    if (schema.type === "object") {
      const example = {};
      if ("example" in schema) {
        return schema.example;
      }
      if ("properties" in schema) {
        for ([key, value] of Object.entries(schema.properties)) {
          example[key] = createExample(value);
        }
      }
      return example;
    } else if (schema.type === "array") {
      if ("example" in schema && !("example" in schema.items)) {
        return schema.example;
      } else {
        return [createExample(schema.items)];
      }
    } else if (schema.type === "string") {
      if ("example" in schema) {
        return schema.example;
      } else {
        return "example";
      }
    } else if (schema.type === "integer") {
      if ("example" in schema) {
        return schema.example;
      } else {
        return 1;
      }
    } else if (schema.type === "boolean") {
      if ("example" in schema) {
        return schema.example;
      } else {
        return true;
      }
    }
  }
}

async function cleanup(httpClient, path, id) {
  result = await httpClient.delete(path + "/" + id).catch((error) => {
    console.log(error.response.data);
  });

  if (result) {
    console.log(`Deleted ${id} from ${path}`);
  }
}

module.exports = { validateSchemaForPost, validateSchemaForSingleGetResource, STATUS };

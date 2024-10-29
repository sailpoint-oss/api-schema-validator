// import SwaggerClient from 'swagger-client';

const log = require('loglevel')
const fs = require('fs');
const SwaggerClient = require('swagger-client');
const axios = require('axios').default;
const axiosRetry = require('axios-retry')
const Ajv = require('ajv');
const addFormats = require('ajv-formats');
const dotenv = require("dotenv");
const yargs = require('yargs');
const YAML = require('yamljs');
const filterTests = require('./validators/filters')
const sorterTests = require('./validators/sorters')
const userLevelTests = require('./validators/userLevels')

function getArgs() {
    const argv = yargs
        .option('input', {
            alias: 'i',
            description: 'Path to input file in yaml format.',
            type: 'string'
        })
        .option('path', {
            alias: 'p',
            description: 'Test an individual path (ex. /accounts).  Don\'t include the version in the path.',
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
            type: 'string'
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
        .option('skip-user-levels', {
            description: "Don't run the user level validator",
            type: 'boolean',
            default: false
        })
        .demandOption(['input'])
        .help()
        .alias('help', 'h').argv;

    // Load environment variables from the .env file
    if (argv.env) {
        dotenv.config({ path: argv.env });
    } else {
        dotenv.config();
    }

    // Overwrite these env variables if they are passed as CLI options
    if (argv['client-id']) {
        process.env.ADMIN_CLIENT_ID = argv['client-id'];
    }
    if (argv['client-secret']) {
        process.env.ADMIN_CLIENT_SECRET = argv['client-secret'];
    }
    if (argv['tenant']) {
        process.env.TENANT = argv['tenant'];
    }

    // Stop the program if certain variables aren't present
    if (!process.env.ADMIN_CLIENT_ID) {
        log.error('Missing client ID.  A client ID must be provided as an env variable, in the .env file, or as a CLI option.');
        process.exit(1);
    }
    if (!process.env.ADMIN_CLIENT_SECRET) {
        log.error('Missing client secret.  A client secret must be provided as an env variable, in the .env file, or as a CLI option.');
        process.exit(1);
    }
    if (!process.env.TENANT) {
        log.error('Missing tenant.  A tenant must be provided as an env variable, in the .env file, or as a CLI option.');
        process.exit(1);
    }

    return argv;
}

function handleResError(error) {
    if (error.response) {
        const method = error.response.request.method;
        const endpoint = error.response.request.path;
        log.debug(`${method} ${endpoint}`);
        if (error.response) {
            // The request was made and the server responded with a status code
            // that falls out of the range of 2xx
            log.debug(error.response.data);
            log.debug(error.response.status);
            log.debug(error.response.headers);
        } else if (error.request) {
            // The request was made but no response was received
            log.debug(error.request);
        } else {
            // Something happened in setting up the request that triggered an Error
            log.debug('Error', error.message);
        }
    } else if (error) {
        log.debug(error)
    } else {
        log.debug(`A serious error occurred for ${path}`);
    }
}

function findAdditionalProperties(path, data, schema) {
    let additionalProps = []
    for (const prop in data) {
        if (schema != undefined) {
            const fullPath = path === "" ? prop : path + "." + prop
            if (!(prop in schema)) {
                additionalProps.push(fullPath)
            } else if (Array.isArray(data[prop]) && typeof (data[prop][0]) === "object" && schema[prop].type === "array" && schema[prop].items.type === "object") {
                const result = findAdditionalProperties(fullPath, data[prop][0], schema[prop].items.properties)
                if (result.length > 0) {
                    additionalProps = additionalProps.concat(result)
                }
            } else if (data[prop] != null && !Array.isArray(data[prop]) && typeof (data[prop]) === "object") {
                const result = findAdditionalProperties(fullPath, data[prop], schema[prop].properties)
                if (result.length > 0) {
                    additionalProps = additionalProps.concat(result)
                }
            }
        }
    }

    return additionalProps
}

async function validateSchema(apiClient, ajv, path, spec) {
    const schema = spec.paths[path].get.responses['200'].content['application/json'].schema;
    const res = await apiClient.get(path).catch(error => { handleResError(error) });

    if (res) {
        uniqueErrors = {
            method: res.request.method,
            endpoint: res.request.path,
            errors: {}
        };

        // TODO: Fix the workflows creator/owner enum issue and then remove this code.
        if (!ajv.validateSchema(schema)) {
            log.debug(`The schema for path ${path} is invalid.\n${JSON.stringify(schema)}`)
            return undefined;
        }

        let validate = undefined;
        try {
            validate = ajv.compile(schema);
        } catch (error) {
            uniqueErrors.errors['Invalid schema'] = {
                'message': error.message,
                'data': null
            }
            return uniqueErrors;
        }

        const passesAJV = validate(res.data);

        // Check for additional properties not defined in the schema
        const additionalProperties = "items" in schema ? findAdditionalProperties("", res.data[0], schema.items.properties) : findAdditionalProperties("", res.data[0], schema.properties)
        const hasAdditionalProperties = Object.keys(additionalProperties).length === 0 ? false : true

        // If AJV finds issues, report each issue
        if (!passesAJV) {
            // Since there can be up to 250 items in the response data, we don't want to have 
            // the same error message appear multiple times.
            // This will allow us to have one error for each unique schema violation.
            for (const error of validate.errors) {
                if (!(error.schemaPath in uniqueErrors.errors)) {
                    message = `Expected that ${error.instancePath} ${error.message}.  Actual value is ${error.data}.`
                    uniqueErrors.errors[error.schemaPath] = {
                        message,
                        data: res.data[error.instancePath.split('/')[1]]
                    }
                }
            }
        }

        // If there are additional properties, report each property
        if (hasAdditionalProperties) {
            for (const additionalProp of additionalProperties) {
                message = `"${additionalProp}" is an additional property returned by the server, but it is not documented in the specification.`
                uniqueErrors.errors[additionalProp] = {
                    message,
                    data: res.data[0]
                }
            }
        }


        return uniqueErrors;
    } else {
        return undefined;
    }
}

async function getResourceIds(apiClient, path) {
    let resourceIds = {} 
    // Split paths into collections that can be searched. Example: '/sources/{id}/accounts/{id}' becomes ["/sources", "/accounts", ""]
    const re = new RegExp(/\/\{.*?\}/, "i")
    // The last element is either empty string or non collection. Trim it off.
    const collections = path.split(re).slice(0, -1)

    for (const collection of collections) {
        const res = await apiClient.get(collection).catch(error => { handleResError(error) });
        if (res.status === 200 && res.data.length > 0) {
            resourceIds[collection] = res.data[0].id
        }
    }

    return resourceIds
}

async function validatePath(apiClient, ajv, path, baseUrl, spec, skipSchema, skipFilters, skipSorters, skipUserLevels, resourceIds) {
    const allErrors = []
    const version = spec.servers[0].url.split('.com')[1]
    for (const method in spec.paths[path]) {
        const errors = {}
        // TODO: Need a way to test "delete" methods
        if (!skipUserLevels && method !== "delete") {
            if ('x-sailpoint-userLevels' in spec.paths[path][method]) {
                const userLevels = spec.paths[path][method]['x-sailpoint-userLevels']
                if ("requestBody" in spec.paths[path][method]) {
                    const contentType = spec.paths[path][method].requestBody.content;
                    // Only support json payloads at this time
                    if ("application/json" in contentType || "application/json-patch+json" in contentType) {
                        errors['userLevelErrors'] = await userLevelTests.validateUserLevels(method, version, path, baseUrl, userLevels, spec, resourceIds)
                    }
                } else {
                    errors['userLevelErrors'] = await userLevelTests.validateUserLevels(method, version, path, baseUrl, userLevels, spec, resourceIds)
                }
            }
        }
        // Validate response schema, filters, and sorters for list endpoints
        if (method === "get" && !path.includes('{')) {
            const contentType = spec.paths[path].get.responses['200'].content;
            if ("application/json" in contentType) {
                if (!skipSchema) {
                    errors['schemaErrors'] = await validateSchema(apiClient, ajv, path, spec);
                }
                if (!skipFilters) {
                    errors['filterErrors'] = await filterTests.validateFilters(apiClient, "get", version, path, spec);
                }
                if (!skipSorters) {
                    errors['sorterErrors'] = await sorterTests.validateSorters(apiClient, "get", version, path, spec);
                }
            } else {
                log.debug(`Path ${path} uses ${JSON.stringify(contentType)} instead of application/json.  Skipping.`);
            }
        }
        allErrors.push(errors)
    }

    return allErrors
}

async function getAccessToken(clientId, clientSecret) {
    const url = `https://${process.env.TENANT}.api.identitynow.com/oauth/token?grant_type=client_credentials&client_id=${clientId}&client_secret=${clientSecret}`;
    res = await axios.post(url).catch(error => {
        log.error("Unable to fetch access token.  Aborting.");
        log.error(error);
    });

    return res.data.access_token;
}

// Replace newlines with <br> and spaces with &nbsp;.  For use in markdown table.
function formatData(data) {
    const stringified = JSON.stringify(data, null, 2);
    const newlines = stringified.replace(/\n/g, '<br>');
    const spaces = newlines.replace(/\ /g, '&nbsp;');
    return spaces;
}

function makeAPIClient(baseUrl, accessToken) {
    const apiClient = axios.create({
        baseURL: baseUrl,
        timeout: 20000, // Some endpoints can take up to 10 seconds to complete
        headers: { 'Authorization': `Bearer ${accessToken}` }
    });
    axiosRetry(apiClient, {
        retries: 1000,
        retryDelay: (retryCount, error) => {
            return retryCount * 2000; // time interval between retries
        },
        retryCondition: (error) => {
            return error.response.status === 429 || error.response.status === 502;
        },
        shouldResetTimeout: true
    });

    return apiClient
}

async function main() {
    const argv = getArgs();
    const oas = YAML.load(argv.input);
    result = await SwaggerClient.resolve({ spec: oas, allowMetaPatches: false });
    spec = result.spec;
    baseUrl = spec.servers[0].url.replace('{tenant}', 'devrel')

    const adminAccessToken = await getAccessToken(process.env.ADMIN_CLIENT_ID, process.env.ADMIN_CLIENT_SECRET);
    const apiClient = makeAPIClient(baseUrl, adminAccessToken)
    if (!argv.skipUserLevels) {
        // This function will produce access tokens for each user level so they can be reused for effeciency
        await userLevelTests.initializeTokens()
    }

    const ajv = new Ajv({
        allErrors: true,
        strictRequired: true,
        strictTypes: true,
        validateFormats: true,
        verbose: true
    });
    addFormats(ajv);
    ajv.addKeyword("x-go-name");
    ajv.addKeyword("x-go-package");
    ajv.addKeyword("x-go-enum-desc");
    ajv.addKeyword("example");
    ajv.addKeyword("externalDocs");
    ajv.addFormat("uuid", function (uuid) { return true; });
    ajv.addFormat("UUID", function (UUID) { return true; });
    ajv.addFormat("date-time", function (dateTime) { 
        const noSeconds = /\d{4}-[01]\d-[0-3]\dT[0-2]\d:[0-5]\d([+-][0-2]\d:[0-5]\d|Z)/ // Match ISO8061 to the minute. This is valid: 2024-03-07T05:00Z
        const noMilliseconds = /\d{4}-[01]\d-[0-3]\dT[0-2]\d:[0-5]\d:[0-5]\d([+-][0-2]\d:[0-5]\d|Z)/ // Match ISO8061 to the second. This is valid: 2024-03-07T05:00:00Z
        const completePrecision = /\d{4}-[01]\d-[0-3]\dT[0-2]\d:[0-5]\d:[0-5]\d\.\d+([+-][0-2]\d:[0-5]\d|Z)/ // Match ISO8061 to the millisecond. This is valid: 2024-03-07T05:00:00.000Z
        // If any of these formats return a non-null, then the date-time is valid
        return (dateTime.match(noSeconds) || dateTime.match(noMilliseconds) || dateTime.match(completePrecision))
    })

    const validations = [];
    if (argv.path) { // Test single path
        if (argv.path in spec.paths) {
            let resourceIds = argv.path.includes('{') ? await getResourceIds(apiClient, argv.path) : {}

            validations.push(validatePath(apiClient, ajv, argv.path, baseUrl, spec, argv.skipSchema, argv.skipFilters, argv.skipSorters, argv.skipUserLevels, resourceIds));
        } else {
            log.error(`Path ${argv.path} does not exist in the spec.  Aborting...`);
        }
    } else { // Test all paths
        for (const path in spec.paths) {
            let resourceIds = path.includes('{') ? await getResourceIds(apiClient, path) : {}
            validations.push(validatePath(apiClient, ajv, path, baseUrl, spec, argv.skipSchema, argv.skipFilters, argv.skipSorters, argv.skipUserLevels, resourceIds));
        }
    }

    const pathResults = await Promise.all(validations);
    let totalErrors = 0;
    let output = "";

    // Build the comment that will be added to the GitHub PR if there are any errors.
    if ("github-action" in argv) {
        for (const pathResult of pathResults) {
            for (const result of pathResult) {
                if (result && result.schemaErrors && Object.keys(result.schemaErrors.errors).length > 0) { // API errors return an undefined result
                    output += `|${result.schemaErrors.method} ${result.schemaErrors.endpoint}|`;
                    for (const error in result.schemaErrors.errors) {
                        if (result.schemaErrors.errors[error].data != undefined) {
                            const data = formatData(result.schemaErrors.errors[error].data);
                            output += `<details closed><summary>${result.schemaErrors.errors[error].message}</summary><pre>${data}</pre></details>`;
                        } else {
                            output += `<details closed><summary>${result.schemaErrors.errors[error].message}</summary>`;
                        }
                        totalErrors += 1;
                    }
                    output += "|\\n";
                }
                if (result && result.filterErrors && (Object.keys(result.filterErrors.errors.undocumentedFilters).length > 0 || Object.keys(result.filterErrors.errors.unsupportedFilters).length > 0)) {
                    output += `|${result.filterErrors.method} ${result.filterErrors.endpoint}|`;
                    for (const undocumentedFilter of result.filterErrors.errors.undocumentedFilters) {
                        output += `<p>${undocumentedFilter.message}</p>`
                        totalErrors += 1;
                    }
                    for (const unsupportedFilter of result.filterErrors.errors.unsupportedFilters) {
                        output += `<p>${unsupportedFilter.message}</p>`
                        totalErrors += 1;
                    }
                    output += "|\\n";
                }
                if (result && result.sorterErrors && (Object.keys(result.sorterErrors.errors.undocumentedSorters).length > 0 || Object.keys(result.sorterErrors.errors.unsupportedSorters).length > 0)) {
                    output += `|${result.sorterErrors.method} ${result.sorterErrors.endpoint}|`;
                    for (const undocumentedSorter of result.sorterErrors.errors.undocumentedSorters) {
                        output += `<p>${undocumentedSorter.message}</p>`
                        totalErrors += 1;
                    }
                    for (const unsupportedSorter of result.sorterErrors.errors.unsupportedSorters) {
                        output += `<p>${unsupportedSorter.message}</p>`
                        totalErrors += 1;
                    }
                    output += "|\\n";
                }
                if (result && result.userLevelErrors && (Object.keys(result.userLevelErrors.errors.undocumentedUserLevels).length > 0 || Object.keys(result.userLevelErrors.errors.unsupportedUserLevels).length > 0).length > 0) {
                    output += `|${result.userLevelErrors.method} ${result.userLevelErrors.endpoint}|`;
                    for (const undocumentedUserLevel of result.userLevelErrors.errors.undocumentedUserLevels) {
                        output += `<p>${undocumentedUserLevel.message}</p>`
                        totalErrors += 1;
                    }
                    for (const unsupportedUserLevel of result.userLevelErrors.errors.unsupportedUserLevels) {
                        output += `<p>${unsupportedUserLevel.message}</p>`
                        totalErrors += 1;
                    }
                    output += "|\\n";
                }
            }
        }
    } else {
        for (const pathResult of pathResults) {
            for (const result of pathResult) {
                if (result && result.schemaErrors && Object.keys(result.schemaErrors.errors).length > 0) { // API errors return an undefined result
                    output += `Errors found in ${result.schemaErrors.method} ${result.schemaErrors.endpoint}\n\n`;
                    for (const error in result.schemaErrors.errors) {
                        output += `- ${result.schemaErrors.errors[error].message}\n`;
                        totalErrors += 1;
                    }
                    output += "\n";
                }
                if (result && result.filterErrors && (Object.keys(result.filterErrors.errors.undocumentedFilters).length > 0 || Object.keys(result.filterErrors.errors.unsupportedFilters).length > 0)) {
                    output += `Errors found in ${result.filterErrors.method} ${result.filterErrors.endpoint}\n\n`;
                    for (const undocumentedFilter of result.filterErrors.errors.undocumentedFilters) {
                        output += `- ${undocumentedFilter.message.replaceAll('`', '"')}\n`;
                        totalErrors += 1;
                    }
                    for (const unsupportedFilter of result.filterErrors.errors.unsupportedFilters) {
                        output += `- ${unsupportedFilter.message.replaceAll('`', '"')}\n`;
                        totalErrors += 1;
                    }
                    output += "\n";
                }
                if (result && result.sorterErrors && (Object.keys(result.sorterErrors.errors.undocumentedSorters).length > 0 || Object.keys(result.sorterErrors.errors.unsupportedSorters).length > 0)) {
                    output += `Errors found in ${result.sorterErrors.method} ${result.sorterErrors.endpoint}\n\n`;
                    for (const undocumentedSorter of result.sorterErrors.errors.undocumentedSorters) {
                        output += `- ${undocumentedSorter.message.replaceAll('`', '"')}\n`;
                        totalErrors += 1;
                    }
                    for (const unsupportedSorter of result.sorterErrors.errors.unsupportedSorters) {
                        output += `- ${unsupportedSorter.message.replaceAll('`', '"')}\n`;
                        totalErrors += 1;
                    }
                    output += "\n";
                }
                if (result && result.userLevelErrors && (Object.keys(result.userLevelErrors.errors.undocumentedUserLevels).length > 0 || Object.keys(result.userLevelErrors.errors.unsupportedUserLevels).length > 0)) {
                    output += `Errors found in ${result.userLevelErrors.method} ${result.userLevelErrors.endpoint}\n\n`;
                    for (const undocumentedUserLevels of result.userLevelErrors.errors.undocumentedUserLevels) {
                        output += `- ${undocumentedUserLevels.message.replaceAll('`', '"')}\n`;
                        totalErrors += 1;
                    }
                    for (const unsupportedUserLevels of result.userLevelErrors.errors.unsupportedUserLevels) {
                        output += `- ${unsupportedUserLevels.message.replaceAll('`', '"')}\n`;
                        totalErrors += 1;
                    }
                    output += "\n";
                }
            }
        };

        if (totalErrors > 0) {
            output += `Total errors: ${totalErrors}`;
        }
    }

    if (totalErrors > 0) {
        console.log(output);
        process.exitCode = 1
    }
}

main()
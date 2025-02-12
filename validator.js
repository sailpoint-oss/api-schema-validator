// import SwaggerClient from 'swagger-client';

const SwaggerClient = require('swagger-client');
const axios = require('axios').default;
const axiosRetry = require('axios-retry')
const Ajv = require('ajv');
const addFormats = require('ajv-formats');
const dotenv = require("dotenv");
const yargs = require('yargs');
const YAML = require('yamljs');
const filterTests = require('./filterTests')
const sorterTests = require('./sorterTests')
const { validateSchemaForPost, validateSchemaForSingleGetResource }  = require('./utils')

function getArgs() {
    const argv = yargs
        .option('input', {
            alias: 'i',
            description: 'The API version to run against.',
            type: 'string'
        })
        .option('path', {
            alias: 'p',
            description: 'Test an individual path (ex. /accounts).  Don\'t include the version in the path.',
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
        .demandOption(['input', 'spec-folder'])
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
        process.env.CLIENT_ID = argv['client-id'];
    }
    if (argv['client-secret']) {
        process.env.CLIENT_SECRET = argv['client-secret'];
    }
    if (argv['tenant']) {
        process.env.TENANT = argv['tenant'];
    }

    // Stop the program if certain variables aren't present
    if (!process.env.CLIENT_ID) {
        console.log('Missing client ID.  A client ID must be provided as an env variable, in the .env file, or as a CLI option.');
        process.exit(1);
    }
    if (!process.env.CLIENT_SECRET) {
        console.log('Missing client secret.  A client secret must be provided as an env variable, in the .env file, or as a CLI option.');
        process.exit(1);
    }
    if (!process.env.TENANT) {
        console.log('Missing tenant.  A tenant must be provided as an env variable, in the .env file, or as a CLI option.');
        process.exit(1);
    }

    return argv;
}

function handleResError(error) {
    if (error.response) {
        const method = error.response.request.method;
        const endpoint = error.response.request.path;
        console.log(`${method} ${endpoint}`);
        if (error.response) {
            // The request was made and the server responded with a status code
            // that falls out of the range of 2xx
            console.log(error.response.data);
            console.log(error.response.status);
            console.log(error.response.headers);
        } else if (error.request) {
            // The request was made but no response was received
            console.log(error.request);
        } else {
            // Something happened in setting up the request that triggered an Error
            console.log('Error', error.message);
        }
    } else if (error) {
        console.log(error)
    } else {
        console.log(`A serious error occurred for ${path}`);
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

async function validateSchema(httpClient, ajv, path, spec) {
    const schema = spec.paths[path].get.responses['200'] ? spec.paths[path].get.responses['200'].content['application/json'].schema : spec.paths[path].get.responses['202'].content['application/json'].schema;
    res = await httpClient.get(path).catch(error => { handleResError(error) });

    if (res) {
        uniqueErrors = {
            method: res.request.method,
            endpoint: res.request.path,
            errors: {}
        };

        // TODO: Fix the workflows creator/owner enum issue and then remove this code.
        if (!ajv.validateSchema(schema)) {
            console.log(`The schema for path ${path} is invalid.\n${JSON.stringify(schema)}`)
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

async function validatePath(version, httpClients, ajv, path, specs, skipSchema, skipFilters, skipSorters) {
    let schemaErrors = []
    let filterErrors = []
    let sorterErrors = []
    
    if ("get" in specs[version].paths[path] && !path.includes('{')) {
        const contentType = specs[version].paths[path].get.responses['200'] ? specs[version].paths[path].get.responses['200'].content : specs[version].paths[path].get.responses['202'].content;
        if ("application/json" in contentType) {
            if (!skipSchema) {
                schemaErrors.push(await validateSchema(httpClients[version], ajv, path, specs[version]));
            }
            if (!skipFilters) {
                filterErrors.push(await filterTests.validateFilters(httpClients[version], "get", specs[version].servers[0].url.split('.com')[1], path, specs[version]));
            }
            if (!skipSorters) {
                sorterErrors.push(await sorterTests.validateSorters(httpClients[version], "get", specs[version].servers[0].url.split('.com')[1], path, specs[version]));
            }
        } else {
            console.log(`Path ${path} uses ${JSON.stringify(contentType)} instead of application/json.  Skipping.`);
        }
    }

    if ("get" in specs[version].paths[path] && path.includes('{')) {
        const contentType = specs[version].paths[path].get.responses['200'].content;
        if ("application/json" in contentType) {
            if (!skipSchema) {
                schemaErrors.push(await validateSchemaForSingleGetResource(version, httpClients, ajv, path, specs));
            }
        }
    }

    // console.log(schemaErrors)
    // console.log("post" in spec.paths[path]);

    // if ("post" in spec.paths[path]) {

    //     schemaErrors.push(await validateSchemaForPost(httpClient, ajv, path, spec));
    // } 


    let allErrors = schemaErrors.concat(filterErrors).concat(sorterErrors);
    let errorsByEndpoint = await mergeErrorsByEndpoint(allErrors);

    //console.log(errorsByEndpoint);

    return errorsByEndpoint;

}

async function mergeErrorsByEndpoint(errorModels) {
    const disallowedKeys = ["undocumentedFilters", "unsupportedFilters", "undocumentedSorters", "unsupportedSorters"]
    const disallowedKeySet = new Set(disallowedKeys)

    let errorsByEndpoint = {};
    for (const errorModel of errorModels) {
        if (errorModel != undefined) {
            let key = `${errorModel.method}${errorModel.endpoint}`;
            if (key in errorsByEndpoint) {

                // Merge schema errors
                if(errorModel.errors != undefined && !Object.keys(errorModel.errors).some(keyCheck => disallowedKeySet.has(keyCheck))) {
                    errorsByEndpoint[key].schemaErrors.push(...errorModel.errors);
                }

                // Merge filter errors
                if(errorModel.errors.undocumentedFilters?.length > 0) {
                    errorsByEndpoint[key].undocumentedFilters.push(...errorModel.errors.undocumentedFilters);
                }
                
                if (errorModel.errors.unsupportedFilters?.length > 0) {
                    errorsByEndpoint[key].unsupportedFilters.push(...errorModel.errors.unsupportedFilters);
                }

                // Merge sorter errors
                if(errorModel.errors.undocumentedSorters?.length > 0) {
                    errorsByEndpoint[key].undocumentedSorters.push(...errorModel.errors.undocumentedSorters);
                }
                
                if (errorModel.errors.unsupportedSorters?.length > 0) {
                    errorsByEndpoint[key].unsupportedSorters.push(...errorModel.errors.unsupportedSorters);
                }

            } else {
                let key = `${errorModel.method}${errorModel.endpoint}`;

                errorsByEndpoint[key] = {
                    method: errorModel.method,
                    endpoint: errorModel.endpoint,
                    schemaErrors: !Object.keys(errorModel.errors).some(keyCheck => disallowedKeySet.has(keyCheck)) ? errorModel.errors : [],
                    undocumentedFilters: errorModel.errors.undocumentedFilters || [],
                    unsupportedFilters: errorModel.errors.unsupportedFilters || [],
                    undocumentedSorters: errorModel.errors.undocumentedSorters || [],
                    unsupportedSorters: errorModel.errors.unsupportedSorters || []
                };
            }
        }
    }
    return errorsByEndpoint;
  }

async function getAccessToken() {
    const url = `${process.env.BASE_URL}/oauth/token?grant_type=client_credentials&client_id=${process.env.CLIENT_ID}&client_secret=${process.env.CLIENT_SECRET}`;
    res = await axios.post(url).catch(error => {
        console.error("Unable to fetch access token.  Aborting.");
        console.error(error);
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

async function main() {
    const apiVersions = ['beta', 'v3', 'v2024'];
    let specs = {};
    let httpClients = {};
    const argv = getArgs();
    const version = argv.input;

    // const oas = YAML.load(argv.input);
    // result = await SwaggerClient.resolve({ spec: oas, allowMetaPatches: false });
    // currentSpec = result.spec;

    for (const version of apiVersions) {
        const versionSpec = YAML.load(`${argv.specFolder}/${version}.yaml`);
        resolveResult = await SwaggerClient.resolve({ spec: versionSpec, allowMetaPatches: false });
        specs[version] = versionSpec;
    };


    const access_token = await getAccessToken();

    for (const version of apiVersions) {
        httpClients[version] = axios.create({
            baseURL: process.env.BASE_URL + "/" + specs[version].servers[0].url.split('/').pop(),
            timeout: 20000, // Some endpoints can take up to 10 seconds to complete
            headers: { 'Authorization': `Bearer ${access_token}`, 'X-SailPoint-Experimental': true }
        });
        axiosRetry(httpClients[version], {
            retries: 1000,
            retryDelay: (retryCount, error) => {
                //console.log(`retry attempt ${retryCount} for ${error.response.request.path}.`);
                return retryCount * 2000; // time interval between retries
            },
            retryCondition: (error) => {
                return error.response.status === 429 || error.response.status === 502;
            },
            shouldResetTimeout: true
        });

    }

    // const httpClient = axios.create({
    //     baseURL: process.env.BASE_URL + "/" + specs[version].servers[0].url.split('/').pop(),
    //     timeout: 20000, // Some endpoints can take up to 10 seconds to complete
    //     headers: { 'Authorization': `Bearer ${access_token}` }
    // });
    // axiosRetry(httpClient, {
    //     retries: 1000,
    //     retryDelay: (retryCount, error) => {
    //         //console.log(`retry attempt ${retryCount} for ${error.response.request.path}.`);
    //         return retryCount * 2000; // time interval between retries
    //     },
    //     retryCondition: (error) => {
    //         return error.response.status === 429 || error.response.status === 502;
    //     },
    //     shouldResetTimeout: true
    // });

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
    ajv.addKeyword("x-miro");
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
        if (argv.path in specs[version].paths) {
            validations.push(validatePath(version, httpClients, ajv, argv.path, specs, argv.skipSchema, argv.skipFilters, argv.skipSorters));
        } else {
            console.error(`Path ${argv.path} does not exist in the spec.  Aborting...`);
        }
    } else { // Test all paths
        for (const path in specs[version].paths) {
            validations.push(validatePath(version, httpClients, ajv, path, specs, argv.skipSchema, argv.skipFilters, argv.skipSorters));
        }
    }

    const results = await Promise.all(validations);
    let totalErrors = 0;
    let output = "";

    // Build the comment that will be added to the GitHub PR if there are any errors.
    if ("github-action" in argv) {
        results.forEach(entry => {
            Object.keys(entry).forEach((endpointKey) => {
                if(Object.keys(entry[endpointKey].schemaErrors).length !== 0 || entry[endpointKey].undocumentedFilters.length !== 0 || entry[endpointKey].unsupportedFilters.length !== 0 || entry[endpointKey].undocumentedSorters.length !== 0 || entry[endpointKey].unsupportedSorters.length !== 0) {
                output += `|${entry[endpointKey].method} ${entry[endpointKey].endpoint}|`;
                Object.keys(entry[endpointKey].schemaErrors).forEach((field) => {
                    if (entry[endpointKey].schemaErrors[field].data != undefined) {
                        const data = formatData(entry[endpointKey].schemaErrors[field].data);
                        output += `<details closed><summary>${entry[endpointKey].schemaErrors[field].message}</summary><pre>${data}</pre></details>`;
                    } else {
                        output += `<details closed><summary>${entry[endpointKey].schemaErrors[field].message}</summary>`;
                    }
                        totalErrors += 1;
                    })

    
                    for (const undocumentedFilter of entry[endpointKey].undocumentedFilters) {
                        output += `<p>${undocumentedFilter.message}</p>`
                        totalErrors += 1;
                    }
    
                    for (const unsupportedFilter of entry[endpointKey].unsupportedFilters) {
                        output += `<p>${unsupportedFilter.message}</p>`
                        totalErrors += 1;
                    }
    
                    for (const undocumentedSorter of entry[endpointKey].undocumentedSorters) {
                        output += `<p>${undocumentedSorter.message}</p>`
                        totalErrors += 1;
                    }
    
                    for (const unsupportedSorter of entry[endpointKey].unsupportedSorters) {
                        output += `<p>${unsupportedSorter.message}</p>`
                        totalErrors += 1;
                    }
                    output += "|\\n";
                }
                })
        });
    } else {
        results.forEach(entry => {
            Object.keys(entry).forEach((endpointKey) => {
            if(Object.keys(entry[endpointKey].schemaErrors).length !== 0 || entry[endpointKey].undocumentedFilters.length !== 0 || entry[endpointKey].unsupportedFilters.length !== 0 || entry[endpointKey].undocumentedSorters.length !== 0 || entry[endpointKey].unsupportedSorters.length !== 0) {
            output += `Errors found in ${entry[endpointKey].method} ${entry[endpointKey].endpoint}\n\n`;
                Object.keys(entry[endpointKey].schemaErrors).forEach((field) => {
                    output += `- ${entry[endpointKey].schemaErrors[field].message}`;
                    totalErrors += 1;
                    output += "\n";
                })

                for (const undocumentedFilter of entry[endpointKey].undocumentedFilters) {
                    output += `- ${undocumentedFilter.message}\n`;
                    totalErrors += 1;
                }

                for (const unsupportedFilter of entry[endpointKey].unsupportedFilters) {
                    output += `- ${unsupportedFilter.message}\n`;
                    totalErrors += 1;
                }

                for (const undocumentedSorter of entry[endpointKey].undocumentedSorters) {
                    output += `- ${undocumentedSorter.message}\n`;
                    totalErrors += 1;
                }
                for (const unsupportedSorter of entry[endpointKey].unsupportedSorters) {
                    output += `- ${unsupportedSorter.message}\n`;
                    totalErrors += 1;
                }
                output += "\n\n";
            }
            })
        });

        if (totalErrors > 0) {
            output += `Total errors: ${totalErrors}`;
        }
    }

    if (totalErrors > 0) {
        console.log(output);
        process.exit(1);
    }
}


main()
// import SwaggerClient from 'swagger-client';

const SwaggerClient = require('swagger-client');
const axios = require('axios').default;
const axiosRetry = require('axios-retry')
const Ajv = require('ajv');
const addFormats = require('ajv-formats');
const dotenv = require("dotenv");
const yargs = require('yargs');
const YAML = require('yamljs');


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
        .option('skip-schema', {
            description: "Don't run the schema validator",
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

// Find all top level attributes within the response schema that are not arrays or objects
// Assign the correct subset of operators that are applicable to each type of property.
// TODO: Support arrays and objects
function getFilterableProperties(schema) {
    let filterableProperties = {}
    // Since filters only work for list endpoints, the schema will always be an array of items.
    // Dive into the array to get the schema.
    for (const [property, propertySchema] of Object.entries(schema['items']['properties'])) {
        if (propertySchema.type === 'string') {
            filterableProperties[property] = {
                type: propertySchema.type,
                operators: ['co', 'eq', 'ge', 'gt', 'in','le', 'lt', 'ne', 'pr', 'sw'],
                supported: [],
                unsupported: []
            }
        } else if (propertySchema.type === 'boolean') {
            filterableProperties[property] = {
                type: propertySchema.type,
                operators: ['eq', 'ne', 'pr'],
                supported: [],
                unsupported: []
            }
        } else if (propertySchema.type === 'number') {
            filterableProperties[property] = {
                type: propertySchema.type,
                operators: ['eq', 'ne', 'pr', 'gt', 'ge', 'lt', 'le'],
                supported: [],
                unsupported: []
            }
        }
    }

    return filterableProperties;
}

function parseFilters(description) {
    const filters = {};
    const lines = description.split("\n");
    const attributeLines = lines.filter(line => line.includes("**:"));
    attributeLines.forEach(line => {
        const attOpSplit = line.replaceAll("*", "").split(":");
        const attribute = attOpSplit[0].trim();
        const opSplit = attOpSplit[1].trim().split(",");
        const operators = opSplit.map(op => op.trim());
        filters[attribute] = operators;
    }) 
    return filters;
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

// Contains
async function testCo(httpClient, example, property, path, propertiesToTest) {
    if (typeof example === "string") {
        const partial = example.substring(example.length / 3, example.length / 2)
        const res = await httpClient.get(path, { params: { filters: `${property} co "${partial}"`}})
        const badMatches = res.data.filter(item => !item[property].includes(partial))
        if (badMatches.length > 0) {
            propertiesToTest[property].unsupported.push('co')
        } else {
            propertiesToTest[property].supported.push('co')
        }
    } else {
        propertiesToTest[property].unsupported.push('co')
    } 
}

// Equals
async function testEq(httpClient, example, property, path, propertiesToTest) {
    let res = undefined
    if (typeof example === "string") {
        res = await httpClient.get(path, { params: { filters: `${property} eq "${example}"`}})
    } else {
        res = await httpClient.get(path, { params: { filters: `${property} eq ${example}`}})
    }

    const badMatches = res.data.filter(item => item[property] !== example)
    if (badMatches.length > 0) {
        propertiesToTest[property].unsupported.push('eq')
    } else {
        propertiesToTest[property].supported.push('eq')
    }
}

// Greater than or equal
async function testGe(httpClient, example, property, path, propertiesToTest) {
    let res = undefined
    if (typeof example === "string") {
        res = await httpClient.get(path, { params: { filters: `${property} ge "${example}"`}})
    } else {
        res = await httpClient.get(path, { params: { filters: `${property} ge ${example}`}})
    }

    const badMatches = res.data.filter(item => item[property] < example)
    if (badMatches.length > 0) {
        propertiesToTest[property].unsupported.push('ge')
    } else {
        propertiesToTest[property].supported.push('ge')
    }
}

// Greater than
async function testGt(httpClient, example, property, path, propertiesToTest) {
    let res = undefined
    if (typeof example === "string") {
        res = await httpClient.get(path, { params: { filters: `${property} gt "${example}"`}})
    } else {
        res = await httpClient.get(path, { params: { filters: `${property} gt ${example}`}})
    }

    const badMatches = res.data.filter(item => item[property] <= example)
    if (badMatches.length > 0) {
        propertiesToTest[property].unsupported.push('gt')
    } else {
        propertiesToTest[property].supported.push('gt')
    }
}

// Item in array
async function testIn(httpClient, example, property, path, propertiesToTest) {
    let res = undefined
    if (typeof example === "string") {
        res = await httpClient.get(path, { params: { filters: `${property} in ("${example}")`}})
    } else {
        res = await httpClient.get(path, { params: { filters: `${property} in (${example})`}})
    }

    const badMatches = res.data.filter(item => item[property] !== example)
    if (badMatches.length > 0) {
        propertiesToTest[property].unsupported.push('in')
    } else {
        propertiesToTest[property].supported.push('in')
    }
}

// Less than or equal to
async function testLe(httpClient, example, property, path, propertiesToTest) {
    let res = undefined
    if (typeof example === "string") {
        res = await httpClient.get(path, { params: { filters: `${property} le "${example}"`}})
    } else {
        res = await httpClient.get(path, { params: { filters: `${property} le ${example}`}})
    }

    const badMatches = res.data.filter(item => item[property] > example)
    if (badMatches.length > 0) {
        propertiesToTest[property].unsupported.push('le')
    } else {
        propertiesToTest[property].supported.push('le')
    }
}

// Less than
async function testLt(httpClient, example, property, path, propertiesToTest) {
    let res = undefined
    if (typeof example === "string") {
        res = await httpClient.get(path, { params: { filters: `${property} lt "${example}"`}})
    } else {
        res = await httpClient.get(path, { params: { filters: `${property} lt ${example}`}})
    }

    const badMatches = res.data.filter(item => item[property] >= example)
    if (badMatches.length > 0) {
        propertiesToTest[property].unsupported.push('lt')
    } else {
        propertiesToTest[property].supported.push('lt')
    }
}

// Not equals
async function testNe(httpClient, example, property, path, propertiesToTest) {
    let res = undefined
    if (typeof example === "string") {
        res = await httpClient.get(path, { params: { filters: `${property} ne "${example}"`}})
    } else {
        res = await httpClient.get(path, { params: { filters: `${property} ne ${example}`}})
    }

    const badMatches = res.data.filter(item => item[property] === example)
    if (badMatches.length > 0) {
        propertiesToTest[property].unsupported.push('ne')
    } else {
        propertiesToTest[property].supported.push('ne')
    }
}

// Is present
async function testPr(httpClient, example, property, path, propertiesToTest) {
    let res = undefined
    res = await httpClient.get(path, { params: { filters: `pr ${property}`}})

    const badMatches = res.data.filter(item => item[property] == null)
    if (badMatches.length > 0) {
        propertiesToTest[property].unsupported.push('pr')
    } else {
        propertiesToTest[property].supported.push('pr')
    }
}

// Starts with
async function testSw(httpClient, example, property, path, propertiesToTest) {
    if (typeof example === "string") {
        const partial = example.substring(0, example.length / 2)
        const res = await httpClient.get(path, { params: { filters: `${property} sw "${partial}"`}})
        const badMatches = res.data.filter(item => item[property].substring(0, example.length / 2) !== partial)
        if (badMatches.length > 0) {
            propertiesToTest[property].unsupported.push('sw')
        } else {
            propertiesToTest[property].supported.push('sw')
        }
    } else {
        propertiesToTest[property].unsupported.push('sw')
    } 
}

async function testFilters(httpClient, path, propertiesToTest, documentedFilters) {
    // Invoke the path without any filters so we have test data to work with when crafting the queries
    const controlRes = await httpClient.get(path).catch(error => {handleResError(error)});

    if (controlRes.data.length > 0) {
        for (const [property, value] of Object.entries(propertiesToTest)) {
            const example = controlRes.data.filter(item => property in item && item[property] != null)[0][property]
            for (const operation of value.operators) {
                switch(operation) {
                    case 'co':
                        try {
                            await testCo(httpClient, example, property, path, propertiesToTest);
                        } catch (error) {
                            propertiesToTest[property].unsupported.push('co')
                        }
                        break;
                    case 'eq':
                        try {
                            await testEq(httpClient, example, property, path, propertiesToTest)
                        } catch (error) {
                            propertiesToTest[property].unsupported.push('eq')
                        }
                        break;
                    case 'ge':
                        try {
                            await testGe(httpClient, example, property, path, propertiesToTest)
                        } catch (error) {
                            propertiesToTest[property].unsupported.push('ge')
                        }
                        break;
                    case 'gt':
                        try {
                            await testGt(httpClient, example, property, path, propertiesToTest)
                        } catch (error) {
                            propertiesToTest[property].unsupported.push('gt')
                        }
                        break;
                    case 'in':
                        try {
                            await testIn(httpClient, example, property, path, propertiesToTest)
                        } catch (error) {
                            propertiesToTest[property].unsupported.push('in')
                        }
                        break;
                    case 'le':
                        try {
                            await testLe(httpClient, example, property, path, propertiesToTest)
                        } catch (error) {
                            propertiesToTest[property].unsupported.push('le')
                        }
                        break;
                    case 'lt':
                        try {
                            await testLt(httpClient, example, property, path, propertiesToTest)
                        } catch (error) {
                            propertiesToTest[property].unsupported.push('lt')
                        }
                        break;
                    case 'ne':
                        try {
                            await testNe(httpClient, example, property, path, propertiesToTest)
                        } catch (error) {
                            propertiesToTest[property].unsupported.push('ne')
                        }
                        break;
                    case 'pr':
                        // Testing "isnull" requires that we don't filter out null examples
                        example = controlRes.data.filter(item => property in item)[0][property]
                        try {
                            await testPr(httpClient, example, property, path, propertiesToTest)
                        } catch (error) {
                            propertiesToTest[property].unsupported.push('pr')
                        }
                        break;
                    case 'sw':
                        try {
                            await testSw(httpClient, example, property, path, propertiesToTest)
                        } catch (error) {
                            propertiesToTest[property].unsupported.push('sw')
                        }
                        break;
                }
            }
        } 
    } else {
        console.debug(`No data for ${path}`)
        // No data found.  Add all documented filters as "supported" until we have data to test otherwise.
        for (property in documentedFilters) {
            for (filter of documentedFilters[property]) {
                propertiesToTest[property].supported.push(filter)
            }
        }
    }
    

    return propertiesToTest
}

async function validateFilters(httpClient, method, version, path, spec) {
    let uniqueErrors = {
        method: method,
        endpoint: version + path,
        errors: {
            undocumentedFilters: [],
            unsupportedFilters: []
        }
    };
    let documentedFilters = null;

    if (spec.paths[path].get.parameters != undefined) {
        const filteredParams = spec.paths[path].get.parameters.filter(param => param.name === "filters")
        const schema = spec.paths[path].get.responses['200'].content['application/json'].schema;
        if (filteredParams.length == 1) {
            try {
                documentedFilters = parseFilters(filteredParams[0].description);
                const propertiesToTest = getFilterableProperties(schema)
                const testedProperties = await testFilters(httpClient, path, propertiesToTest, documentedFilters)
                for (property in testedProperties) {
                    if (property in documentedFilters) {
                        for (supportedFilter of testedProperties[property]["supported"]) {
                            // A supported filter is not documented
                            if (!(documentedFilters[property].includes(supportedFilter))) {
                                uniqueErrors.errors['undocumentedFilters'].push({
                                    'message': `The property \`${property}\` supports the \`${supportedFilter}\` filter parameter but it is not documented.`,
                                    'data': null
                                })
                            }
                        }
                        for (documentedFilter of documentedFilters[property]) {
                            // A documented filter is not supported
                            if (!(testedProperties[property]["supported"].includes(documentedFilter))) {
                                uniqueErrors.errors['unsupportedFilters'].push({
                                    'message': `The property \`${property}\` does not support the \`${documentedFilter}\` filter parameter but the documentation says it does.`,
                                    'data': null
                                })
                            }
                        }
                    } else {

                    }
                }
            } catch (error) {
                uniqueErrors.errors['Invalid Filters'] = {
                    'message': `Unable to parse the filters due to improper format: ${error.message}`,
                    'data': null
                }
                return uniqueErrors;
            }
        }
    }

    return uniqueErrors;
}

async function validateSchema(httpClient, ajv, path, spec) {
    const schema = spec.paths[path].get.responses['200'].content['application/json'].schema;
    res = await httpClient.get(path).catch(error => {handleResError(error)});

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

        const isValid = validate(res.data);

        if (!isValid) {
            // Since there can be up to 250 items in the response data, we don't want to have 
            // the same error message appear multiple times.
            // This will allow us to have one error for each unique schema violation.
            validate.errors.forEach(error => {
                if (!(error.schemaPath in uniqueErrors.errors)) {
                    message = `Expected that ${error.instancePath} ${error.message}.  Actual value is ${error.data}.`
                    uniqueErrors.errors[error.schemaPath] = {
                        message,
                        data: res.data[error.instancePath.split('/')[1]]
                    }
                }
            });
        }

        return uniqueErrors;
    } else {
        return undefined;
    }
}

async function validatePath(httpClient, ajv, path, spec, skipSchema, skipFilters) {
    if ("get" in spec.paths[path] && !path.includes('{')) {
        const contentType = spec.paths[path].get.responses['200'].content;
        if ("application/json" in contentType) {
            let schemaErrors = undefined
            let filterErrors = undefined
            if (!skipSchema) {
                schemaErrors = await validateSchema(httpClient, ajv, path, spec);
            }
            if (!skipFilters) {
                filterErrors = await validateFilters(httpClient, "get", spec.servers[0].url.split('.com')[1], path, spec);
            }
            return { schemaErrors, filterErrors };
        } else {
            console.log(`Path ${path} uses ${JSON.stringify(contentType)} instead of application/json.  Skipping.`);
        }
    } else {
        // console.log(`Path ${path} must have a GET operation and no path parameters. Skipping...`);
        return undefined;
    }
}

async function getAccessToken() {
    const url = `https://${process.env.TENANT}.api.identitynow.com/oauth/token?grant_type=client_credentials&client_id=${process.env.CLIENT_ID}&client_secret=${process.env.CLIENT_SECRET}`;
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
    const argv = getArgs();
    const oas = YAML.load(argv.input);
    result = await SwaggerClient.resolve({ spec: oas, allowMetaPatches: false });
    spec = result.spec;

    const access_token = await getAccessToken();
    const httpClient = axios.create({
        baseURL: spec.servers[0].url.replace('{tenant}', 'devrel'),
        timeout: 20000, // Some endpoints can take up to 10 seconds to complete
        headers: { 'Authorization': `Bearer ${access_token}` }
    });
    axiosRetry(httpClient, { 
        retries: 20,
        retryDelay: (retryCount, error) => {
            console.log(`retry attempt ${retryCount} for ${error.response.request.path}.`);
            return retryCount * 1000; // time interval between retries
        },
        retryCondition: (error) => {
            return error.response.status === 429 || error.response.status === 502;
        },
        shouldResetTimeout: true
    });

    const ajv = new Ajv({
        allErrors: true,
        strictRequired: true,
        strictTypes: true,
        validateFormats: true,
        verbose: true
    });
    addFormats(ajv);
    ajv.addKeyword("example");
    ajv.addKeyword("externalDocs");
    ajv.addFormat("UUID", function (UUID) { return true; });

    const validations = [];
    if (argv.path) { // Test single path
        if (argv.path in spec.paths) {
            validations.push(validatePath(httpClient, ajv, argv.path, spec, argv.skipSchema, argv.skipFilters));
        } else {
            console.error(`Path ${argv.path} does not exist in the spec.  Aborting...`);
        }
    } else { // Test all paths
        for (const path in spec.paths) {
            validations.push(validatePath(httpClient, ajv, path, spec, argv.skipSchema, argv.skipFilters));
        }
    }

    const results = await Promise.all(validations);
    let totalErrors = 0;
    let output = "";

    // Build the comment that will be added to the GitHub PR if there are any errors.
    if ("github-action" in argv) {
        results.forEach(result => {
            if (result && result.schemaErrors && Object.keys(result.schemaErrors.errors).length > 0) { // API errors return an undefined result
                output += `|${result.schemaErrors.method} ${result.schemaErrors.endpoint}|`;
                for (error in result.schemaErrors.errors) {
                    const data = formatData(result.schemaErrors.errors[error].data);
                    output += `<details closed><summary>${result.schemaErrors.errors[error].message}</summary><pre>${data}</pre></details>`;
                    totalErrors += 1;
                }
                output += "|\n";
            }
            if (result && result.filterErrors && (Object.keys(result.filterErrors.errors.undocumentedFilters).length > 0 || Object.keys(result.filterErrors.errors.unsupportedFilters).length > 0)) {
                output += `|${result.filterErrors.method} ${result.filterErrors.endpoint}|`;
                for (undocumentedFilter of result.filterErrors.errors.undocumentedFilters) {
                    output += `<p>${undocumentedFilter.message}</p>`
                    totalErrors += 1;
                }
                for (unsupportedFilter of result.filterErrors.errors.unsupportedFilters) {
                    output += `<p>${unsupportedFilter.message}</p>`
                    totalErrors += 1;
                }
                output += "|\n";
            }
        });
    } else {
        results.forEach(result => {
            if (result && result.schemaErrors && Object.keys(result.schemaErrors.errors).length > 0) { // API errors return an undefined result
                output += `Errors found in ${result.schemaErrors.method} ${result.schemaErrors.endpoint}\n\n`;
                for (error in result.schemaErrors.errors) {
                    output += `- ${result.schemaErrors.errors[error].message}\n`;
                    totalErrors += 1;
                }
                output += "\n";
            }
            if (result && result.filterErrors && (Object.keys(result.filterErrors.errors.undocumentedFilters).length > 0 || Object.keys(result.filterErrors.errors.unsupportedFilters).length > 0)) {
                output += `Errors found in ${result.filterErrors.method} ${result.filterErrors.endpoint}\n\n`;
                for (undocumentedFilter of result.filterErrors.errors.undocumentedFilters) {
                    output += `- ${undocumentedFilter.message.replaceAll('`','"')}\n`;
                    totalErrors += 1;
                }
                for (unsupportedFilter of result.filterErrors.errors.unsupportedFilters) {
                    output += `- ${unsupportedFilter.message.replaceAll('`','"')}\n`;
                    totalErrors += 1;
                }
                output += "\n";
            }
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
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

async function validateSchema(httpClient, ajv, path, spec) {
    const schema = spec.paths[path].get.responses['200'].content['application/json'].schema;
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

async function validatePath(httpClient, ajv, path, spec, skipSchema, skipFilters, skipSorters) {
    if ("get" in spec.paths[path] && !path.includes('{')) {
        const contentType = spec.paths[path].get.responses['200'].content;
        if ("application/json" in contentType) {
            let schemaErrors = undefined
            let filterErrors = undefined
            let sorterErrors = undefined
            if (!skipSchema) {
                schemaErrors = await validateSchema(httpClient, ajv, path, spec);
            }
            if (!skipFilters) {
                filterErrors = await filterTests.validateFilters(httpClient, "get", spec.servers[0].url.split('.com')[1], path, spec);
            }
            if (!skipSorters) {
                sorterErrors = await sorterTests.validateSorters(httpClient, "get", spec.servers[0].url.split('.com')[1], path, spec);
            }
            return { schemaErrors, filterErrors, sorterErrors };
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
            validations.push(validatePath(httpClient, ajv, argv.path, spec, argv.skipSchema, argv.skipFilters, argv.skipSorters));
        } else {
            console.error(`Path ${argv.path} does not exist in the spec.  Aborting...`);
        }
    } else { // Test all paths
        for (const path in spec.paths) {
            validations.push(validatePath(httpClient, ajv, path, spec, argv.skipSchema, argv.skipFilters, argv.skipSorters));
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
                output += "|\\n";
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
                output += "|\\n";
            }
            if (result && result.sorterErrors && (Object.keys(result.sorterErrors.errors.undocumentedSorters).length > 0 || Object.keys(result.sorterErrors.errors.unsupportedSorters).length > 0)) {
                output += `|${result.sorterErrors.method} ${result.sorterErrors.endpoint}|`;
                for (undocumentedSorter of result.sorterErrors.errors.undocumentedSorters) {
                    output += `<p>${undocumentedSorter.message}</p>`
                    totalErrors += 1;
                }
                for (unsupportedSorter of result.sorterErrors.errors.unsupportedSorters) {
                    output += `<p>${unsupportedSorter.message}</p>`
                    totalErrors += 1;
                }
                output += "|\\n";
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
                    output += `- ${undocumentedFilter.message.replaceAll('`', '"')}\n`;
                    totalErrors += 1;
                }
                for (unsupportedFilter of result.filterErrors.errors.unsupportedFilters) {
                    output += `- ${unsupportedFilter.message.replaceAll('`', '"')}\n`;
                    totalErrors += 1;
                }
                output += "\n";
            }
            if (result && result.sorterErrors && (Object.keys(result.sorterErrors.errors.undocumentedSorters).length > 0 || Object.keys(result.sorterErrors.errors.unsupportedSorters).length > 0)) {
                output += `Errors found in ${result.sorterErrors.method} ${result.sorterErrors.endpoint}\n\n`;
                for (undocumentedSorter of result.sorterErrors.errors.undocumentedSorters) {
                    output += `- ${undocumentedSorter.message.replaceAll('`', '"')}\n`;
                    totalErrors += 1;
                }
                for (unsupportedSorter of result.sorterErrors.errors.unsupportedSorters) {
                    output += `- ${unsupportedSorter.message.replaceAll('`', '"')}\n`;
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
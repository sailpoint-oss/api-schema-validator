// import SwaggerClient from 'swagger-client';

const SwaggerClient = require('swagger-client');
const oas = require('./sailpoint-api-beta.json');
const axios = require('axios');
const secrets = require('./secrets.json');
const Ajv = require('ajv');
const addFormats = require('ajv-formats');

// TODO: Check that response content type is JSON


async function validatePath(httpClient, ajv, path, schema) {
    res = await httpClient.get(path).catch(error => {
        if (error) {
            const method = error.response.request.method;
            const url = error.response.request.protocol + "//" + error.response.request.host + error.response.request.path;
            console.log(`${method} ${url}`);
            if (error.response) {
                // The request was made and the server responded with a status code
                // that falls out of the range of 2xx
                console.log(error.response.data);
                console.log(error.response.status);
                console.log(error.response.headers);
            } else if (error.request) {
                // The request was made but no response was received
                // `error.request` is an instance of XMLHttpRequest in the browser and an instance of
                // http.ClientRequest in node.js
                console.log(error.request);
            } else {
                // Something happened in setting up the request that triggered an Error
                console.log('Error', error.message);
            }
        } else {
            console.log(`A serious error occurred for ${path}`);
        }
    });

    if (res) {
        uniqueErrors = {
            method: res.request.method,
            url: res.request.protocol + "//" + res.request.host + res.request.path,
            errors: {}
        };

        const validate = ajv.compile(schema);
        const isValid = validate(res.data)

        if (!isValid) {
            // Since there can be up to 250 items in the response data, we don't want to have 
            // the same error message appear multiple times.
            // This will allow us to have one error for each unique schema violation.
            validate.errors.forEach(error => {
                if (!(error.schemaPath in uniqueErrors.errors)) {
                    message = `Expected that ${error.instancePath} ${error.message}.  Actual value is ${error.data}.`
                    uniqueErrors.errors[error.schemaPath] = message;
                }
            });
        }

        return uniqueErrors;
    } else {
        return undefined;
    }
}

async function main() {
    result = await SwaggerClient.resolve({ spec: oas, allowMetaPatches: false });
    spec = result.spec;

    const instance = axios.create({
        baseURL: spec.servers[0].url.replace('{tenant}', 'devrel'),
        timeout: 20000, // Some endpoints can take about 10 seconds to complete
        headers: { 'Authorization': `Bearer ${secrets.token}` }
    });

    const ajv = new Ajv({
        allErrors: true,
        strictRequired: true,
        verbose: true
    });
    addFormats(ajv);
    ajv.addKeyword("example");
    ajv.addFormat("UUID", function (UUID) { return true; });

    const validations = [];
    for (const path in spec.paths) {
        if ("get" in spec.paths[path] && !path.includes('{')) {
            if ("application/json" in spec.paths[path].get.responses['200'].content) {
                validations.push(validatePath(instance, ajv, path, spec.paths[path].get.responses['200'].content['application/json'].schema));
            } else {
                console.log(`Path ${path} uses ${spec.paths[path].get.responses['200'].content} instead of application/json.  Skipping.`)
            }
        }
    }
    results = await Promise.all(validations);
    totalErrors = 0;
    results.forEach(result => {
        if (result) { // API errors return an undefined result
            console.log(`Validating ${result.method} ${result.url}`);
            for (error in result.errors) {
                console.error(`  - ${result.errors[error]}`);
                totalErrors += 1;
            }
            console.log(); // Add a newline to make output easier to read
        }
    });
    console.log(`Total errors: ${totalErrors}`);
}


main()
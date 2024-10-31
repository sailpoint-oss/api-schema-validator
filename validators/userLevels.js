const executeAs = require('../executeAs')
const log = require('loglevel')


const KNOWN_USER_LEVELS = [
    'ORG_ADMIN',
    'CERT_ADMIN',
    'HELPDESK',
    'REPORT_ADMIN',
    'ROLE_ADMIN',
    'ROLE_SUBADMIN',
    'SOURCE_ADMIN',
    'SOURCE_SUBADMIN',
    'CLOUD_GOV_ADMIN',
    'CLOUD_GOV_USER',
    'SAAS_MANAGEMENT_ADMIN',
    'SAAS_MANAGEMENT_READER',
    'das:ui-administrator',
    'das:ui-compliance_manager',
    'das:ui-auditor',
    'das:ui-data-scope',
    'sp:aic-dashboard-read',
    'sp:aic-dashboard-write',
    'sp:ui-config-hub-admin',
    'sp:ui-config-hub-backup-admin',
    'sp:ui-config-hub-read'
]

async function initializeTokens() {
    const requests = KNOWN_USER_LEVELS.map(async (userLevel) => {
        const userLevelSnakeCase = executeAs.convertToSnakeCase(userLevel) // Transforms sp:ui-config-hub-admin into SP_UI_CONFIG_HUB_ADMIN
        await executeAs.getAccessToken(process.env[`${userLevelSnakeCase}_CLIENT_ID`], process.env[`${userLevelSnakeCase}_CLIENT_SECRET`])
    })

    await Promise.all(requests)
}

// Entitlements is a list of objects, but it's creating a single object in the example
function createExample(schema) {
    if (!("readOnly" in schema) || ("readOnly" in schema && !(schema.readOnly))) {
        if (schema.type === "object") {
            const example = {}
            if ("properties" in schema) {
                for ([key, value] of Object.entries(schema.properties)) {
                    example[key] = createExample(value)
                }
            }
            return example
        } else if (schema.type === "array") {
            return [createExample(schema.items)]
        } else if (schema.type === "string") {
            if ("example" in schema) {
                return schema.example
            } else {
                return "example"
            }
        } else if (schema.type === "integer") {
            if ("example" in schema) {
                return schema.example
            } else {
                return 1
            }
        } else if (schema.type === "boolean") {
            if ("example" in schema) {
                return schema.example
            } else {
                return true
            }
        }
    }
}

// POST, PUT, and PATCH requests that require a request body, so we need to create a valid
// request body using the schema and examples.
function createRequestBody(method, path, spec) {
    let requestBody = undefined
    if (method === 'patch') {
        requestBody = [
            {
                "op": "replace",
                "path": "/description",
                "value": ""
            }
        ]
    } else {
        if ("requestBody" in spec.paths[path][method]) {
            const contentType = spec.paths[path][method].requestBody.content;
            if ("application/json" in contentType) {
                requestBody = createExample(contentType["application/json"].schema)
            } else if ("application/json-patch+json" in contentType) {
                requestBody = createExample(contentType["application/json-patch+json"].schema)
            }
        }
    }

    return requestBody
}

async function validateUserLevels(method, version, path, baseUrl, userLevels, spec, resourceIds) {
    let uniqueErrors = {
        method: method,
        endpoint: version + path,
        errors: {
            undocumentedUserLevels: [],
            unsupportedUserLevels: []
        }
    };
    let documentedUserLevels = new Set(userLevels)

    let url = path
    for (const [collection, id] of Object.entries(resourceIds)) {
        url = url.replace(/{.*}/i, id)
    }
    // Test all known user levels to make sure we verify all possible outcomes.
    const requests = KNOWN_USER_LEVELS.map(ul => {
        let request = {
            userLevel: ul,
            scopes: ['sp:scopes:all'],
            config: {
                url: url,
                method: method
            }
        }

        const data = createRequestBody(method, path, spec)
        if (data !== undefined) {
            request.config["data"] = data
        }
        const headers = (method === 'patch' ? { 'Content-Type': 'application/json-patch+json' } : undefined)
        if (headers !== undefined) {
            request.config["headers"] = headers
        }

        return request
    })

    const responses = await executeAs.processRequests(baseUrl, requests)

    for (const response of responses) {
        if (response.response.status >= 200 && response.response.status <= 299) {
            if (!(documentedUserLevels.has(response.userLevel))) {
                uniqueErrors.errors.undocumentedUserLevels.push({
                    'message': `This endpoint supports the user level \`${response.userLevel}\` but it is not documented in \`x-sailpoint-userLevels\`.`,
                    'data': null
                })
            }
        } else if (response.response.status === 403) {
            if (documentedUserLevels.has(response.userLevel)) {
                uniqueErrors.errors.unsupportedUserLevels.push({
                    'message': `This endpoint says it supports the user level \`${response.userLevel}\` but attempting to use this user level results in a 403 forbidden. If this endpoint supports record level authorization, this may be a false positive. Please manually verify.`,
                    'data': null
                })
            }
        } else {
            log.warn({
                'message': `Unable to test user level \`${response.userLevel}\` because the provided inputs resulted in a ${response.response.status}.`,
                'config': JSON.stringify(response.config),
                'response': JSON.stringify(response.response.data)
            })
        }
    }

    return uniqueErrors
}

exports.validateUserLevels = validateUserLevels
exports.initializeTokens = initializeTokens
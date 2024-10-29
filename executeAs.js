/*
TODO:

Add a function in executeAsUser to delete any PAT that was last used longer than 1 minute ago. Note, there is a bug where some user levels
can't get their access tokens (403 error). Need to fix this before implementing.

Because each run of this will delete all tokens, make sure to handle 401 by regenerating the token and running it again.
This will make the program more robust in the event that multiple instances are run and they result in the
token being deleted before a current instance has had a chance to execute the API.

Asynchronous processing
  For scope testing, we should use an org admin or client credentials. This is inherently thread safe.

Bugs in the API backend
  Some endpoints are validating the request body before checking authorization. Authorization should be verified first. This happens on POST /v3/access-profiles

  User level sp:ui-config-hub-read cannot GET personal access tokens, but it can create one.

  If user level sp:ui-config-hub-read creates a PAT with empty request body, then attempting to create more results in 500
*/

const axios = require('axios').default;
const axiosRetry = require('axios-retry')
const dotenv = require("dotenv");
const crypto = require("crypto");

function convertToSnakeCase(text) {
    return text.replaceAll(":", "_").replaceAll("-", "_").toUpperCase()
}

// A persistent map to store access tokens for each client. getAccessToken() will check this map
// first before creating a new access token. If the token exists in this variable, then it will be used.
// If it doesn't exist, then a new token will be generated. This is much more efficient and prevents
// from hitting the rate limit.
// TODO: Because this is async, it's queuing up all 2079 requests before any tokens are added to the accessTokens object. This is running into 429 rate limit. Might need a dedicated function to prep this instead of relying on this one.
const accessTokens = {}
async function getAccessToken(clientId, clientSecret) {
    if (!(clientId in accessTokens)) {
        const client = axios.create({
            baseURL: `https://${process.env.TENANT}.api.identitynow.com`,
            timeout: 20000, // Some endpoints can take up to 10 seconds to complete
        });
        axiosRetry(client, {
            retries: 1000,
            retryDelay: (retryCount) => {
                console.log(`Retry # ${retryCount} for ${clientId}`)
                return retryCount * 2000; // time interval between retries
            },
            retryCondition: (error) => {
                return error.response.status === 429 || error.response.status === 502;
            },
            shouldResetTimeout: true
        });

        const res = await client.post(`/oauth/token?grant_type=client_credentials&client_id=${clientId}&client_secret=${clientSecret}`).catch(error => {
            console.error(`An error occurred while creating access token for client ${clientId}: ${error}`)
        });

        accessTokens[clientId] = res.data.access_token
    }

    return accessTokens[clientId]
}

function makeAPIClient(baseUrl, accessToken) {
    const apiClient = axios.create({
        baseURL: baseUrl,
        timeout: 20000, // Some endpoints can take up to 10 seconds to complete
        headers: {
            'Authorization': `Bearer ${accessToken}`
        }
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

// requests: an array of objects that contain the userLevel, scopes, and request config for an individual endpoint
async function parallelExecuteAsUser(baseUrl, requests) {
    const tasks = requests.map(request => executeAsUser(request.userLevel, request.scopes, baseUrl, request.config))
    const results = await Promise.all(tasks)

    return results
}

// userLevel: The user level to assign to the test user
// scopes: array of scopes to assign to the token
// config: the axios config that specifies the path, method, and parameters of the endpoint to execute
async function executeAsUser(userLevel, scopes, baseUrl, config) {
    const userLevelSnakeCase = convertToSnakeCase(userLevel) // Transforms sp:ui-config-hub-admin into SP_UI_CONFIG_HUB_ADMIN
    const userToken = await getAccessToken(process.env[`${userLevelSnakeCase}_CLIENT_ID`], process.env[`${userLevelSnakeCase}_CLIENT_SECRET`])
    const apiClient = makeAPIClient(baseUrl, userToken)
    // We only care about the status code to see if it is a 403 or not.
    let res = await apiClient(config).catch(error => {
        return error.response
    });

    while (res === undefined) {
        // If the res is undefined, there was a network issue. Sleep for 2 seconds and try again until it succeeds.
        await new Promise(r => setTimeout(r, 2000));
        const response = await executeAsUser(userLevel, scopes, baseUrl, config)
        res = response.response
    }

    return {
        userLevel: userLevel,
        scopes: scopes,
        config: config,
        response: res
    }
}

exports.processRequests = parallelExecuteAsUser
exports.executeAsUser = executeAsUser
exports.getAccessToken = getAccessToken
exports.convertToSnakeCase = convertToSnakeCase
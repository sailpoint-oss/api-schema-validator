// Find all top level attributes within the response schema that are not arrays or objects
// Assign the correct subset of operators that are applicable to each type of property.
function getFilterableProperties(schema) {
    let filterableProperties = {}
    let properties = null
    if (schema.type === 'array') {
        properties = Object.entries(schema['items']['properties'])
    } else {
        if ('properties' in schema) {
            properties = Object.entries(schema['properties'])
        } else {
            return filterableProperties
        }
    }
    // If schema is an array, loop through the array items
    for (const [property, propertySchema] of properties) {
        if (propertySchema.type === 'string') {
            filterableProperties[property] = {
                type: propertySchema.type,
                operators: ['co', 'eq', 'ge', 'gt', 'in', 'le', 'lt', 'ne', 'pr', 'isnull', 'sw'],
                supported: [],
                unsupported: []
            }
        } else if (propertySchema.type === 'boolean') {
            filterableProperties[property] = {
                type: propertySchema.type,
                operators: ['eq', 'ne', 'pr', 'isnull'],
                supported: [],
                unsupported: []
            }
        } else if (propertySchema.type === 'number') {
            filterableProperties[property] = {
                type: propertySchema.type,
                operators: ['eq', 'ne', 'pr', 'isnull', 'gt', 'ge', 'lt', 'le'],
                supported: [],
                unsupported: []
            }
        } else if (propertySchema.type === 'object') {
            const childProperties = getFilterableProperties(propertySchema)
            for (const [child, value] of Object.entries(childProperties)) {
                filterableProperties[`${property}.${child}`] = value
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

// Contains
async function testCo(httpClient, example, property, path, propertyToTest) {
    if (typeof example === "string") {
        // Contains is case insensitive, so lowercase everything
        const partial = example.substring(example.length / 3, example.length / 2).toLowerCase()
        const res = await httpClient.get(path, { params: { filters: `${property} co "${partial}"` } })
        const badMatches = res.data.filter(item => !getPropByString(item, property).toLowerCase().includes(partial))
        if (badMatches.length > 0) {
            propertyToTest.unsupported.push('co')
        } else {
            propertyToTest.supported.push('co')
        }
    } else {
        propertyToTest.unsupported.push('co')
    }
}

// Equals
async function testEq(httpClient, example, property, path, propertyToTest) {
    let res = undefined
    if (typeof example === "string") {
        res = await httpClient.get(path, { params: { filters: `${property} eq "${example}"` } })
    } else {
        res = await httpClient.get(path, { params: { filters: `${property} eq ${example}` } })
    }

    const badMatches = res.data.filter(item => getPropByString(item, property) !== example)
    if (badMatches.length > 0) {
        propertyToTest.unsupported.push('eq')
    } else {
        propertyToTest.supported.push('eq')
    }
}

// Greater than or equal
async function testGe(httpClient, example, property, path, propertyToTest) {
    let res = undefined
    if (typeof example === "string") {
        res = await httpClient.get(path, { params: { filters: `${property} ge "${example}"` } })
    } else {
        res = await httpClient.get(path, { params: { filters: `${property} ge ${example}` } })
    }

    const badMatches = res.data.filter(item => getPropByString(item, property) < example)
    if (badMatches.length > 0) {
        propertyToTest.unsupported.push('ge')
    } else {
        propertyToTest.supported.push('ge')
    }
}

// Greater than
async function testGt(httpClient, example, property, path, propertyToTest) {
    let res = undefined
    if (typeof example === "string") {
        res = await httpClient.get(path, { params: { filters: `${property} gt "${example}"` } })
    } else {
        res = await httpClient.get(path, { params: { filters: `${property} gt ${example}` } })
    }

    const badMatches = res.data.filter(item => getPropByString(item, property) <= example)
    if (badMatches.length > 0) {
        propertyToTest.unsupported.push('gt')
    } else {
        propertyToTest.supported.push('gt')
    }
}

// Item in array
async function testIn(httpClient, example, property, path, propertyToTest) {
    let res = undefined
    if (typeof example === "string") {
        res = await httpClient.get(path, { params: { filters: `${property} in ("${example}")` } })
    } else {
        res = await httpClient.get(path, { params: { filters: `${property} in (${example})` } })
    }

    const badMatches = res.data.filter(item => getPropByString(item, property) !== example)
    if (badMatches.length > 0) {
        propertyToTest.unsupported.push('in')
    } else {
        propertyToTest.supported.push('in')
    }
}

// Less than or equal to
async function testLe(httpClient, example, property, path, propertyToTest) {
    let res = undefined
    if (typeof example === "string") {
        res = await httpClient.get(path, { params: { filters: `${property} le "${example}"` } })
    } else {
        res = await httpClient.get(path, { params: { filters: `${property} le ${example}` } })
    }

    const badMatches = res.data.filter(item => getPropByString(item, property) > example)
    if (badMatches.length > 0) {
        propertyToTest.unsupported.push('le')
    } else {
        propertyToTest.supported.push('le')
    }
}

// Less than
async function testLt(httpClient, example, property, path, propertyToTest) {
    let res = undefined
    if (typeof example === "string") {
        res = await httpClient.get(path, { params: { filters: `${property} lt "${example}"` } })
    } else {
        res = await httpClient.get(path, { params: { filters: `${property} lt ${example}` } })
    }

    const badMatches = res.data.filter(item => getPropByString(item, property) >= example)
    if (badMatches.length > 0) {
        propertyToTest.unsupported.push('lt')
    } else {
        propertyToTest.supported.push('lt')
    }
}

// Not equals
async function testNe(httpClient, example, property, path, propertyToTest) {
    let res = undefined
    if (typeof example === "string") {
        res = await httpClient.get(path, { params: { filters: `${property} ne "${example}"` } })
    } else {
        res = await httpClient.get(path, { params: { filters: `${property} ne ${example}` } })
    }

    const badMatches = res.data.filter(item => getPropByString(item, property) === example)
    if (badMatches.length > 0) {
        propertyToTest.unsupported.push('ne')
    } else {
        propertyToTest.supported.push('ne')
    }
}

// Is present
async function testPr(httpClient, property, path, propertyToTest) {
    let res = undefined
    res = await httpClient.get(path, { params: { filters: `pr ${property}` } })

    const badMatches = res.data.filter(item => getPropByString(item, property) == null)
    if (badMatches.length > 0) {
        propertyToTest.unsupported.push('pr')
    } else {
        propertyToTest.supported.push('pr')
    }
}

// Is null
async function testIsNull(httpClient, property, path, propertyToTest) {
    let res = undefined
    res = await httpClient.get(path, { params: { filters: `${property} isnull` } })

    const badMatches = res.data.filter(item => getPropByString(item, property) != null)
    if (badMatches.length > 0) {
        propertyToTest.unsupported.push('isnull')
    } else {
        propertyToTest.supported.push('isnull')
    }
}

// Starts with
async function testSw(httpClient, example, property, path, propertyToTest) {
    if (typeof example === "string") {
        const partial = example.substring(0, example.length / 2)
        const res = await httpClient.get(path, { params: { filters: `${property} sw "${partial}"` } })
        const badMatches = res.data.filter(item => getPropByString(item, property).substring(0, example.length / 2) !== partial)
        if (badMatches.length > 0) {
            propertyToTest.unsupported.push('sw')
        } else {
            propertyToTest.supported.push('sw')
        }
    } else {
        propertyToTest.unsupported.push('sw')
    }
}

function getPropByString(obj, propString) {
    if (!propString)
        return obj;

    var prop, props = propString.split('.');

    for (var i = 0, iLen = props.length - 1; i < iLen; i++) {
        prop = props[i];

        var candidate = obj[prop];
        if (candidate !== undefined && candidate !== null) {
            obj = candidate;
        } else {
            break;
        }
    }
    return obj[props[i]];
}

async function testFilters(httpClient, path, property, propertyToTest, documentedFilters) {
    // Invoke the path without any filters so we have test data to work with when crafting the queries
    const controlRes = await httpClient.get(path).catch(error => { handleResError(error) });

    if (controlRes.data.length > 0) {
        let example = null
        const nonNullExamples = controlRes.data.filter(item => getPropByString(item, property) != null)
        if (nonNullExamples.length > 0) {
            example = getPropByString(nonNullExamples[0], property)
            for (const operation of propertyToTest.operators) {
                switch (operation) {
                    case 'co':
                        try {
                            await testCo(httpClient, example, property, path, propertyToTest);
                        } catch (error) {
                            propertyToTest.unsupported.push('co')
                        }
                        break;
                    case 'eq':
                        try {
                            await testEq(httpClient, example, property, path, propertyToTest)
                        } catch (error) {
                            propertyToTest.unsupported.push('eq')
                        }
                        break;
                    case 'ge':
                        try {
                            await testGe(httpClient, example, property, path, propertyToTest)
                        } catch (error) {
                            propertyToTest.unsupported.push('ge')
                        }
                        break;
                    case 'gt':
                        try {
                            await testGt(httpClient, example, property, path, propertyToTest)
                        } catch (error) {
                            propertyToTest.unsupported.push('gt')
                        }
                        break;
                    case 'in':
                        try {
                            await testIn(httpClient, example, property, path, propertyToTest)
                        } catch (error) {
                            propertyToTest.unsupported.push('in')
                        }
                        break;
                    case 'le':
                        try {
                            await testLe(httpClient, example, property, path, propertyToTest)
                        } catch (error) {
                            propertyToTest.unsupported.push('le')
                        }
                        break;
                    case 'lt':
                        try {
                            await testLt(httpClient, example, property, path, propertyToTest)
                        } catch (error) {
                            propertyToTest.unsupported.push('lt')
                        }
                        break;
                    case 'ne':
                        try {
                            await testNe(httpClient, example, property, path, propertyToTest)
                        } catch (error) {
                            propertyToTest.unsupported.push('ne')
                        }
                        break;
                    case 'pr':
                        try {
                            await testPr(httpClient, property, path, propertyToTest)
                        } catch (error) {
                            propertyToTest.unsupported.push('pr')
                        }
                        break;
                    case 'isnull':
                        try {
                            await testIsNull(httpClient, property, path, propertyToTest)
                        } catch (error) {
                            propertyToTest.unsupported.push('isnull')
                        }
                        break;
                    case 'sw':
                        try {
                            await testSw(httpClient, example, property, path, propertyToTest)
                        } catch (error) {
                            propertyToTest.unsupported.push('sw')
                        }
                        break;
                }
            }
        } else {
            console.log(`Can't test filter for property ${property} in path ${path}. It does not have any non-null examples.`)
            // Add all documented filters for the current property as "supported" until we have data to test otherwise.
            if (property in documentedFilters) {
                for (filter of documentedFilters[property]) {
                    propertyToTest.supported.push(filter)
                }
            }
        }
    } else {
        console.debug(`No data for ${path}`)
        // No data found.  Add all documented filters as "supported" until we have data to test otherwise.
        for (property in documentedFilters) {
            for (filter of documentedFilters[property]) {
                propertyToTest.supported.push(filter)
            }
        }
    }

    let propertyObject = {}
    propertyObject[property] = propertyToTest
    return propertyObject
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

                let tests = []
                for (property in propertiesToTest) {
                    tests.push(testFilters(httpClient, path, property, propertiesToTest[property], documentedFilters))
                }
                const testedPropertiesArray = await Promise.all(tests);

                // Convert the result array into an object for easier parsing of error messages
                let testedProperties = {}
                for (prop of testedPropertiesArray) {
                    let propName = Object.keys(prop)[0]
                    testedProperties[propName] = prop[propName]
                }

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

exports.validateFilters = validateFilters
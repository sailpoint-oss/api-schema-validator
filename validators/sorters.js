// Find all top level attributes within the response schema that are not arrays or objects
function getSortableProperties(schema) {
    let sortableProperties = {}
    let properties = null
    if (schema.type === 'array') {
        properties = Object.entries(schema['items']['properties'])
    } else {
        if ('properties' in schema) {
            properties = Object.entries(schema['properties'])
        } else {
            return sortableProperties
        }
    }
    // If schema is an array, loop through the array items
    for (const [property, propertySchema] of properties) {
        if (propertySchema.type === 'object') {
            const childProperties = getSortableProperties(propertySchema)
            for (const [child, value] of Object.entries(childProperties)) {
                sortableProperties[`${property}.${child}`] = value
            }
        } else if (propertySchema.type === 'array') {
            continue // Can't sort on arrays
        } else {
            sortableProperties[property] = {
                type: propertySchema.type,
                supported: true,
                testable: true
            }
        }
    }

    return sortableProperties;
}

function parseSorters(description) {
    let sorters = null;
    const lines = description.split("\n");
    const attributeLines = lines.filter(line => line.includes("Sorting is supported for the following fields:"));
    if (attributeLines.length === 1) {
        sorters = attributeLines[0].replaceAll("*", "").split(":")[1].split(",").map((x) => x.trim());
    }

    return sorters;
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

async function testSorters(httpClient, path, propertiesToTest, documentedSorters) {
    for (const [property, value] of Object.entries(propertiesToTest)) {
        try {
            const ascRes = await httpClient.get(path, { params: { sorters: property } })
            // There must be at least two items in the response data to test sorters.
            if (ascRes.data.length < 2) {
                propertiesToTest[property].testable = false
            } else {
                const descRes = await httpClient.get(path, { params: { sorters: `-${property}` } })
                const ascItem = getPropByString(ascRes.data[0], property)
                const descItem = getPropByString(descRes.data[0], property)
    
                if (ascItem === descItem) {
                    propertiesToTest[property].supported = false
                } else if (ascItem == null && descItem != null) {
                    // Null is less than any other value, so this means that sorting appears to be supported.
                    propertiesToTest[property].supported = true
                } else if (ascItem != null && descItem == null) {
                    // The sorter for this property is unsupported if the first item from ascending response
                    // is not null and the first item from the desc response is null.  This is because
                    // null is considered less than any other value.
                    propertiesToTest[property].supported = false
                } else {
                    if (value.type === 'string') {
                        // If asc item is not less than desc item, then sorter didn't work.  localCompare is specific to string types.
                        if (ascItem.localeCompare(descItem) > -1) {
                            propertiesToTest[property].supported = false
                        }
                    } else {
                        // If asc item is not less than desc item, then sorter didn't work.  This checks numbers and booleans.
                        if (ascItem > descItem) {
                            propertiesToTest[property].supported = false
                        }
                    }
                }
            }
        } catch (error) {
            propertiesToTest[property].supported = false
        }
    }

    return propertiesToTest
}

async function validateSorters(httpClient, method, version, path, spec) {
    let uniqueErrors = {
        method: method,
        endpoint: version + path,
        errors: {
            undocumentedSorters: [],
            unsupportedSorters: []
        }
    };

    if (spec.paths[path].get.parameters != undefined) {
        const filteredParams = spec.paths[path].get.parameters.filter(param => param.name === "sorters")
        const schema = spec.paths[path].get.responses['200'].content['application/json'].schema;
        let documentedSorters = []
        if (filteredParams.length == 1) {
            documentedSorters = parseSorters(filteredParams[0].description);
        }

        try {
            const propertiesToTest = getSortableProperties(schema)
            const testedProperties = await testSorters(httpClient, path, propertiesToTest, documentedSorters)
            for (property in testedProperties) {
                // If the property wasn't able to be tested (ex. not enough data), then don't report any errors
                if (testedProperties[property].testable) {
                    if (documentedSorters.includes(property)) {
                        if (!testedProperties[property].supported) {
                            uniqueErrors.errors['unsupportedSorters'].push({
                                'message': `The property \`${property}\` **MIGHT NOT** support sorting but the documentation says it does. Please manually verify.`,
                                'data': null
                            })
                        }
                    } else {
                        if (testedProperties[property].supported) {
                            uniqueErrors.errors['undocumentedSorters'].push({
                                'message': `The property \`${property}\` **MIGHT** support sorting but it is not documented. Please manually verify.`,
                                'data': null
                            })
                        }
                    }
                }
            }
        } catch (error) {
            uniqueErrors.errors['Invalid Sorters'] = {
                'message': `Unable to parse the sorters due to improper format: ${error.message}`,
                'data': null
            }
            return uniqueErrors;
        }
    }

    return uniqueErrors;
}

exports.validateSorters = validateSorters
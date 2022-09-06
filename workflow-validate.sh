#!/bin/sh

# This is meant to be run inside a github workflow.

# Requires Node v16

TESTED_PATHS=""

validate_paths () {
    FILE_PATHS=$@
    for FILE_PATH in $FILE_PATHS
    do
        FILE_PATH_LENGTH=$(file_path_length $FILE_PATH)
        VERSION=$(echo $FILE_PATH | cut -d "/" -f 5)
        FILE_NAME=$(echo $FILE_PATH | cut -d "/" -f $FILE_PATH_LENGTH)

        # If the file is in the "paths" folder, then find which path references
        # it in the main API file.
        if echo $FILE_PATH | grep paths --quiet
        then
            API_PATH=$(grep -B 1 $FILE_NAME "${BASE_DIR}/sailpoint-api.${VERSION}.yaml" | head -n 1 | tr -d ' ' | tr -d ':')
            if ! cat tested_paths.txt | grep -x "$API_PATH"
            then
                ERRORS=$(node ../api-schema-validator/validator.js -i "../api-schema-validator/${VERSION}.yaml" -p $API_PATH --github-action)
                echo $ERRORS
                echo $API_PATH >> tested_paths.txt
            fi
        elif echo $FILE_PATH | grep schemas --quiet
        then
            MATCHING_FILE_PATHS=$(grep -lr "/${FILE_NAME}" "${BASE_DIR}/$VERSION")
            validate_paths $MATCHING_FILE_PATHS
        fi
    done
}

file_path_length () {
    echo $1 | tr "/" " " | wc -w
}

# Build the API spec
speccy resolve --quiet ../cloud-api-client-common/api-specs/src/main/yaml/sailpoint-api.v3.yaml -o v3.yaml
speccy resolve --quiet ../cloud-api-client-common/api-specs/src/main/yaml/sailpoint-api.beta.yaml -o beta.yaml

cd ../cloud-api-client-common
BASE_DIR="api-specs/src/main/yaml"
CHANGED_FILES=$@
touch tested_paths.txt

for CHANGED_FILE in $CHANGED_FILES
do
    VALIDATION=$(validate_paths $CHANGED_FILE)
    if echo $VALIDATION | grep "Expected that" --quiet
    then
        echo "**${CHANGED_FILE}** is used in one or more paths that have an invalid schema.  Please fix the schema validation issues below.  For more information on this PR check, please see the [API schema validator README](https://github.com/sailpoint/cloud-api-client-common#api-schema-validator).  For a list of common error messages and how to fix them, please [see this section in the README](https://github.com/sailpoint/cloud-api-client-common#common-api-validator-errors)."
        echo "| Path | Errors |"
        echo "|-|-|"
        echo $VALIDATION
        echo "---"
    fi
done
#!/bin/sh

# This is meant to be run inside a github workflow.

# Requires Node v16

validate_paths () {
    FILE_PATHS=$@
    # echo "\nProcess file paths: $FILE_PATHS"
    for FILE_PATH in $FILE_PATHS
    do
        # echo $FILE_PATH
        FILE_PATH_LENGTH=$(file_path_length $FILE_PATH)
        VERSION=$(echo $FILE_PATH | cut -d "/" -f 5)
        FILE_NAME=$(echo $FILE_PATH | cut -d "/" -f $FILE_PATH_LENGTH)

        # If the file is in the "paths" folder, then find which path references
        # it in the main API file.
        if echo $FILE_PATH | grep paths --quiet
        then
            # echo "Search for path in main spec"
            API_PATH=$(grep -B 1 $FILE_NAME "${BASE_DIR}/sailpoint-api.${VERSION}.yaml" | head -n 1 | tr -d ' ' | tr -d ':')
            ERRORS=$(node ../api-schema-validator/validator.js -i "../api-schema-validator/${VERSION}.yaml" -p $API_PATH --github-action)
            echo $ERRORS
        elif echo $FILE_PATH | grep schemas --quiet
        then
            MATCHING_FILE_PATHS=$(grep -lr "/${FILE_NAME}" "${BASE_DIR}/$VERSION")
            # echo "Continue path search"
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

for CHANGED_FILE in $CHANGED_FILES
do
    VALIDATION=$(validate_paths $CHANGED_FILE)
    if echo $VALIDATION | grep "Expected that" --quiet
    then
        echo "**${CHANGED_FILE}** is used in one or more paths that have an invalid schema.  Please fix the schema validation issues below."
        echo "| Path | Errors |"
        echo "|-|-|"
        echo $VALIDATION
        echo "---"
    fi
done
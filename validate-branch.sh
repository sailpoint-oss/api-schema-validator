#!/bin/sh

# Requires Node v16

BRANCH=$1

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
            ERRORS=$(node ../validator.js -i "../${VERSION}.yaml" -p $API_PATH -e ../.env --table-format)
            echo "|${API_PATH}|${ERRORS}|"
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

rm -rf cloud-api-client-common
rm v3.yaml
rm beta.yaml

git clone git@github.com:colin-mckibben-sp/cloud-api-client-common.git

# Switch to a different branch and build the API spec
cd cloud-api-client-common
git switch $BRANCH
cd ../

# Build the API spec
speccy resolve --quiet cloud-api-client-common/api-specs/src/main/yaml/sailpoint-api.v3.yaml -o v3.yaml
speccy resolve --quiet cloud-api-client-common/api-specs/src/main/yaml/sailpoint-api.beta.yaml -o beta.yaml

cd cloud-api-client-common
BASE_DIR="api-specs/src/main/yaml"
CHANGED_FILES=$(git diff --name-only HEAD master)

for CHANGED_FILE in $CHANGED_FILES
do
    echo "$CHANGED_FILE has been modified.  Testing each path that uses this file."
    echo "| Path | Errors |"
    echo "|-|-|"
    validate_paths $CHANGED_FILE
done
cd ../

rm -rf cloud-api-client-common
rm v3.yaml
rm beta.yaml
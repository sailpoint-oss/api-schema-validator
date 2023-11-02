#!/bin/sh

# Requires Node v16

BRANCH=$1

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
            if [ ! -z "$API_PATH" ] && ! cat tested_paths.txt | grep -x "$API_PATH"
            then
                ERRORS=$(node ../validator.js -i "../${VERSION}.yaml" -p $API_PATH -e ../.env --github-action)
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

rm -rf cloud-api-client-common
rm v3.yaml
rm beta.yaml

git clone git@github.com:sailpoint/cloud-api-client-common.git

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
touch tested_paths.txt

for CHANGED_FILE in $CHANGED_FILES
do
    VALIDATION=$(validate_paths $CHANGED_FILE)
    if echo $VALIDATION | grep "Expected that" --quiet
    then
        echo "**${CHANGED_FILE}** is used in one or more paths that have an invalid schema.  Please fix the schema validation issues below."
        echo "| Path | Errors |"
        echo "|-|-|"
        echo "$VALIDATION"
        echo "---"
    fi
done

cd ../

rm -rf cloud-api-client-common
rm v3.yaml
rm beta.yaml
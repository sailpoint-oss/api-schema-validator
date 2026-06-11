#!/bin/sh

# Requires Node v16+
# @apidevtools/swagger-parser handles $ref resolution directly — no speccy required.

BRANCH=$1
VERSIONS="v3 beta v2024 v2025 v2026"
SPEC_BASE="cloud-api-client-common/api-specs/src/main/yaml"

validate_paths () {
    FILE_PATHS=$@
    for FILE_PATH in $FILE_PATHS
    do
        FILE_PATH_LENGTH=$(file_path_length $FILE_PATH)
        VERSION=$(echo $FILE_PATH | cut -d "/" -f 5)
        FILE_NAME=$(echo $FILE_PATH | cut -d "/" -f $FILE_PATH_LENGTH)

        if echo $FILE_PATH | grep paths --quiet
        then
            API_PATH=$(grep -B 1 $FILE_NAME "${BASE_DIR}/sailpoint-api.${VERSION}.yaml" | head -n 1 | tr -d ' ' | tr -d ':')
            if [ ! -z "$API_PATH" ] && ! cat tested_paths.txt | grep -x "$API_PATH"
            then
                echo "TESTING: ${VERSION} ${API_PATH}"
                ERRORS=$(node ../validator.js -i $VERSION -f ../ -p $API_PATH --skip-filters --skip-sorters -e ../.env --github-action)
                if [ ! -z "$ERRORS" ]
                then
                    echo $ERRORS
                fi
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
for VERSION in $VERSIONS; do
  rm -f "${VERSION}.yaml"
done

git clone git@github.com:sailpoint/cloud-api-client-common.git

cd cloud-api-client-common
git switch $BRANCH
cd ../

# Copy raw spec files (swagger-parser resolves $refs at runtime)
for VERSION in $VERSIONS; do
  SRC="${SPEC_BASE}/sailpoint-api.${VERSION}.yaml"
  if [ -f "$SRC" ]; then
    cp "$SRC" "${VERSION}.yaml"
  fi
done

cd cloud-api-client-common
BASE_DIR="api-specs/src/main/yaml"
CHANGED_FILES=$(git diff --name-only master...)
touch tested_paths.txt
echo "Changed files: $CHANGED_FILES"
for CHANGED_FILE in $CHANGED_FILES
do
    echo "Validate $CHANGED_FILE"
    VALIDATION=$(validate_paths $CHANGED_FILE | tr -s '\n' '\n')
    if echo $VALIDATION | grep "|" --quiet
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
for VERSION in $VERSIONS; do
  rm -f "${VERSION}.yaml"
done

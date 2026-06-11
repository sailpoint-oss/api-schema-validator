#!/bin/sh

# GitHub Actions entrypoint.
# @apidevtools/swagger-parser handles $ref resolution — no speccy required.
# Supports both old-style (yaml/{version}/paths/) and
# new-style (yaml/apis/{resource}/paths/) changed files.

VERSIONS="v3 beta v2024 v2025 v2026"
SPEC_SOURCE="../cloud-api-client-common/api-specs/src/main/yaml"
APIS_SOURCE="${SPEC_SOURCE}/apis"
VALIDATOR_DIR="../api-schema-validator"

TESTED_PATHS=""

validate_paths () {
    FILE_PATHS=$@
    for FILE_PATH in $FILE_PATHS
    do
        FILE_PATH_LENGTH=$(file_path_length $FILE_PATH)
        FILE_NAME=$(echo $FILE_PATH | cut -d "/" -f $FILE_PATH_LENGTH)

        # Determine if this is a new-style (apis/{resource}/...) or old-style path
        if echo $FILE_PATH | grep "/apis/" --quiet
        then
            # New-style: extract resource name (segment after "apis/")
            RESOURCE=$(echo $FILE_PATH | sed 's|.*apis/\([^/]*\)/.*|\1|')
            SPEC_DIR="${APIS_SOURCE}"
            SPEC_IDENTIFIER="$RESOURCE"
            MAIN_SPEC="${APIS_SOURCE}/${RESOURCE}/openapi.yaml"
            SEARCH_DIR="${APIS_SOURCE}/${RESOURCE}"
        else
            # Old-style: extract version (segment after "yaml/")
            VERSION=$(echo $FILE_PATH | cut -d "/" -f 5)
            SPEC_DIR="${VALIDATOR_DIR}"
            SPEC_IDENTIFIER="$VERSION"
            MAIN_SPEC="${SPEC_SOURCE}/sailpoint-api.${VERSION}.yaml"
            SEARCH_DIR="${SPEC_SOURCE}/${VERSION}"
        fi

        if echo $FILE_PATH | grep "/paths/" --quiet
        then
            API_PATH=$(grep -B 1 "$FILE_NAME" "$MAIN_SPEC" | head -n 1 | tr -d ' ' | tr -d ':')
            DEDUPE_KEY="${SPEC_IDENTIFIER}:${API_PATH}"
            if [ ! -z "$API_PATH" ] && ! cat tested_paths.txt | grep -q -x "$DEDUPE_KEY"
            then
                ERRORS=$(node "${VALIDATOR_DIR}/validator.js" -i "$SPEC_IDENTIFIER" -f "${SPEC_DIR}/" -p "$API_PATH" --github-action)
                if [ ! -z "$ERRORS" ]
                then
                    echo $ERRORS
                fi
                echo "$DEDUPE_KEY" >> tested_paths.txt
            fi
        elif echo $FILE_PATH | grep "/schemas/" --quiet
        then
            MATCHING_FILE_PATHS=$(grep -lr "/${FILE_NAME}" "$SEARCH_DIR")
            validate_paths $MATCHING_FILE_PATHS
        fi
    done
}

file_path_length () {
    echo $1 | tr "/" " " | wc -w
}

# Stage old-style version specs (swagger-parser reads them from VALIDATOR_DIR)
for VERSION in $VERSIONS; do
  SRC="${SPEC_SOURCE}/sailpoint-api.${VERSION}.yaml"
  if [ -f "$SRC" ]; then
    cp "$SRC" "${VALIDATOR_DIR}/${VERSION}.yaml"
  fi
done

cd ../cloud-api-client-common
BASE_DIR="api-specs/src/main/yaml"
CHANGED_FILES=$@
touch tested_paths.txt

for CHANGED_FILE in $CHANGED_FILES
do
    VALIDATION=$(validate_paths $CHANGED_FILE | tr -s '\n' '\n')
    if echo $VALIDATION | grep "|" --quiet
    then
        echo "**${CHANGED_FILE}** is used in one or more paths that have an invalid schema.  Please fix the schema validation issues below.  For more information on this PR check, please see the [API schema validator README](https://github.com/sailpoint/cloud-api-client-common#api-schema-validator).  For a list of common error messages and how to fix them, please [see this section in the README](https://github.com/sailpoint/cloud-api-client-common#common-api-validator-errors)."
        echo "| Path | Errors |"
        echo "|-|-|"
        echo "$VALIDATION"
        echo "---"
    fi
done

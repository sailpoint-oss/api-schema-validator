#!/bin/sh

# Requires Node v16

rm -rf cloud-api-client-common
rm v3.yaml
rm beta.yaml
rm v2024.yaml

git clone git@github.com:sailpoint/cloud-api-client-common.git

# Build the API spec
speccy resolve --quiet cloud-api-client-common/api-specs/src/main/yaml/sailpoint-api.v3.yaml -o v3.yaml
speccy resolve --quiet cloud-api-client-common/api-specs/src/main/yaml/sailpoint-api.beta.yaml -o beta.yaml
speccy resolve --quiet cloud-api-client-common/api-specs/src/main/yaml/sailpoint-api.v2024.yaml -o v2024.yaml

node validator.js -i v3 -f . --skip-filters --skip-sorters | tee v3-results.txt
node validator.js -i beta -f . --skip-filters --skip-sorters | tee beta-results.txt
node validator.js -i v2024 -f . --skip-filters --skip-sorters | tee v2024-results.txt

rm -rf cloud-api-client-common
rm v3.yaml
rm beta.yaml
rm v2024.yaml

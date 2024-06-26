#!/bin/sh

# Requires Node v16

rm -rf cloud-api-client-common
rm v3.yaml
rm beta.yaml

git clone git@github.com:sailpoint/cloud-api-client-common.git

# Build the API spec
speccy resolve --quiet cloud-api-client-common/api-specs/src/main/yaml/sailpoint-api.v3.yaml -o v3.yaml
speccy resolve --quiet cloud-api-client-common/api-specs/src/main/yaml/sailpoint-api.beta.yaml -o beta.yaml

node validator.js -i v3.yaml --skip-filters --skip-sorters | tee v3-results.txt
node validator.js -i beta.yaml --skip-filters --skip-sorters | tee beta-results.txt

rm -rf cloud-api-client-common
rm v3.yaml
rm beta.yaml

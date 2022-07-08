#!/bin/sh

rm -rf cloud-api-client-common
rm v3.yaml
rm beta.yaml

git clone git@github.com:sailpoint/cloud-api-client-common.git

speccy resolve cloud-api-client-common/api-specs/src/main/yaml/sailpoint-api.v3.yaml -o v3.yaml
speccy resolve cloud-api-client-common/api-specs/src/main/yaml/sailpoint-api.beta.yaml -o beta.yaml

node validator.js -i v3.yaml | tee v3-results.txt
node validator.js -i beta.yaml | tee beta-results.txt

rm -rf cloud-api-client-common
rm v3.yaml
rm beta.yaml
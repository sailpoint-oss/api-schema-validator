#!/bin/sh

rm -rf cloud-api-client-common
rm openapi.yaml

git clone git@github.com:sailpoint/cloud-api-client-common.git

speccy resolve cloud-api-client-common/api-specs/src/main/yaml/sailpoint-api.beta.yaml -o openapi.yaml

node validator.js | tee results.txt

rm -rf cloud-api-client-common
rm openapi.yaml
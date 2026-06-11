#!/bin/sh

# Requires Node v16+
# @apidevtools/swagger-parser handles $ref resolution directly — no speccy required.

VERSIONS="v3 beta v2024 v2025 v2026"
SPEC_BASE="cloud-api-client-common/api-specs/src/main/yaml"

rm -rf cloud-api-client-common
for VERSION in $VERSIONS; do
  rm -f "${VERSION}.yaml"
done

git clone git@github.com:sailpoint/cloud-api-client-common.git

# Copy raw spec files (swagger-parser resolves $refs at runtime)
for VERSION in $VERSIONS; do
  SRC="${SPEC_BASE}/sailpoint-api.${VERSION}.yaml"
  if [ -f "$SRC" ]; then
    cp "$SRC" "${VERSION}.yaml"
  fi
done

for VERSION in $VERSIONS; do
  if [ -f "${VERSION}.yaml" ]; then
    node validator.js -i "$VERSION" -f . --skip-filters --skip-sorters | tee "${VERSION}-results.txt"
  fi
done

rm -rf cloud-api-client-common
for VERSION in $VERSIONS; do
  rm -f "${VERSION}.yaml"
done

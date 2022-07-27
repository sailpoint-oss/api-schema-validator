# api-schema-validator

The API Schema Validator is an automated integration test generator that verifies the accuracy of each schema defined in an OpenAPI specification with the actual data returned by the API server.  This tool uses [Ajv](https://ajv.js.org/) to evaluate schema definitions and [Speccy](https://www.npmjs.com/package/speccy/v/0.8.7) to bundle all remote references in an OpenAPI specification into one file.  This tool performs the following steps to test an OpenAPI specification:

1. Bundle the OpenAPI specification into a single file.
2. Construct an HTTP request for each defined path that has a **GET** operation and no path parameters.  These are commonly known as **collection** or **list** endpoints, and they are the easiest to test.
3. Execute each request and use Ajv to validate that the response data adheres to the schema definition.
4. Log each schema violation to the console.

## Setup

In order to use this tool, the following dependencies must be installed.

- [Node.js](https://nodejs.org/en/download/) - Latest LTS version.
- [Speccy 0.8.7](https://www.npmjs.com/package/speccy/v/0.8.7)
  - `npm install -g speccy@0.8.7`
- [Git](https://git-scm.com/book/en/v2/Getting-Started-Installing-Git)

Start by cloning this repository onto your machine:

```
git clone https://github.com/sailpoint-oss/api-schema-validator.git
```

Change directory into the repository and install the NPM packages.

```
npm install
```

Create a `.env` file in the root of the project folder to hold the secret values for your target API server.  This code is designed to work with IdentityNow, so you will need to provide the client ID and secret of your [personal access token](https://developer.sailpoint.com/docs/authentication.html#overview), along with the name of your tenant.

```
CLIENT_ID="{your client ID}"
CLIENT_SECRET="{your client secret}"
TENANT="{the name of your IDN tenant}"
```

## Running the tool

This repository contains the validator code (`validator.js`) along with shell scripts to automate the setup and teardown work.  These shell scripts are designed to work for SailPoint's environment, but can be modified to suit your needs.

### validator.js

To run the validator, execute the following command in your terminal:

```
node validator.js -i {path/to/spec.yaml}
```

This will run the validator on every path that has a **GET** operation and no path parameters, and will output the results to the console.  The spec must be in yaml format.  This program provides several CLI options, which you can view by running `node validator.js -h`.

### validate-master.sh

This helper script is designed to work for SailPoint's environment.  It clones the github repo that contains the OpenAPI specification files, resolves the files into a single file using speccy, and then runs the validator, saving the output to a file.

### validate-branch.sh

This helper script works almost the same as `validate-master.sh`.  The only difference is that is accepts one argument that specifies the branch to validate, and it will only validate the files that have changed in the branch.  This is useful if you want to test just the changes that were made in a branch instead of the entire specification.

### workflow-validate.sh

This script is meant to be run in a Github action.  It is similar to `validate-branch.sh` in that it will only validate the files that are changed in the pull request that triggers the action.  It will output any violations in a formatted Github comment.
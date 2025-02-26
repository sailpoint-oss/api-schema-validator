function countEndpointsByStatus(data, status) {
    return data.reduce((count, obj) => {
      const key = Object.keys(obj)[0]; 
      if (obj[key].status.includes(status)) {
        count++;
      }
      return count;
    }, 0);
  }

  function countValidEndpoints(endpoints) {
    return endpoints.filter(endpoint => endpoint.status.length === 0).length;
  }

  function groupErrorsByTag(data) {
    return data.reduce((acc, apiEntry) => {
      Object.entries(apiEntry).forEach(([endpoint, details]) => {
        const tag = details.tag;
        if (!acc[tag]) acc[tag] = [];
        
        acc[tag].push({
          endpoint: details.endpoint,
          method: details.method,
          status: details.status,
          schemaErrors: details.schemaErrors ? details.schemaErrors : [],
          undocumentedFilters: details.undocumentedFilters,
          unsupportedFilters: details.unsupportedFilters,
          undocumentedSorters: details.undocumentedSorters,
          unsupportedSorters: details.unsupportedSorters,
        });
      });
      return acc;
    }, {});
  }

function generateProgressBar(endpoints) {
    const percentage = ((countValidEndpoints(endpoints)/endpoints.length) * 100).toFixed(0);

    if (percentage >= 75) return `<div class="progress-bar-green" style="width: ${percentage}%">${percentage}%</div>`;
    if (percentage >= 50) return `<div class="progress-bar-yellow" style="width: ${percentage}%">${percentage}%</div>`;
    return `<div class="progress-bar-red" style="width: ${percentage}%">${percentage}%</div>`; 
}
// Generate HTML Report
function generateHtmlReport(data, totalEndpoints, version) {

const coveragePercentage = ((data.length / totalEndpoints) * 100).toFixed(2);
const testedCount = data.length;

const endpointsByTag = groupErrorsByTag(data);

const validEndpoints = data.filter(item => {
  const key = Object.keys(item)[0];
  return item[key].status.length === 0;
}).length;

console.log(`Total tested endpoints with no errors: ${validEndpoints}`);
console.log(`Total tested endpoints with errors: ${data.length - validEndpoints}`);
console.log(`Total tested endpoints with unsupported sorters: ${countEndpointsByStatus(data, "UNSUPPORTED_SORTERS")}`);
console.log(`Total tested endpoints with undocumented sorters: ${countEndpointsByStatus(data, "UNDOCUMENTED_SORTERS")}`);
console.log(`Total tested endpoints with unsupported filters: ${countEndpointsByStatus(data, "UNSUPPORTED_FILTERS")}`);
console.log(`Total tested endpoints with undocumented filters: ${countEndpointsByStatus(data, "UNDOCUMENTED_FILTERS")}`);
console.log(`Total tested endpoints with additional properties: ${countEndpointsByStatus(data, "ADDITIONAL_PROPERTIES")}`);
console.log(`Total tested endpoints with API errors: ${countEndpointsByStatus(data, "API_ERROR")}`);
console.log(`Total tested endpoints with API schema mismatch: ${countEndpointsByStatus(data, "API_SCHEMA_MISMATCH")}`);
console.log(`Total tested endpoints with invalid schema: ${countEndpointsByStatus(data, "INVALID_SCHEMA")}`);
console.log(`Total tested endpoints with no data: ${countEndpointsByStatus(data, "NO_DATA")}`);
console.log(`Total tested endpoints with path param unresolved: ${countEndpointsByStatus(data, "PATH_PARAM_UNRESOLVED")}`);
console.log(`Total tested endpoints with schema not found: ${countEndpointsByStatus(data, "SCHEMA_NOT_FOUND")}`);
console.log(`Total tested endpoints: ${data.length}`);

    return `<!DOCTYPE html>
  <html lang="en">
  <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>API Schema Validation Coverage Report: ${version}</title>
      <style>
        body {
            font-family: Arial, sans-serif;
            margin: 20px;
        }

        h1 {
            color: #333;
            text-align: center;
        }

        .heading-section {
            display: flex;
            justify-content: center;
            align-items: center;
            text-align: center;
            width: 100%;
            /* Makes it fill the viewport */
            gap: 20px;
        }

        .progress-text {
            position: absolute; 
            width: 100%; 
            height: 100%; 
            display: flex; 
            align-items: center; 
            justify-content: center; 
            color: white; 
            z-index: 1; 
            font-weight: bolder;
            text-shadow: 1px 1px 2px rgba(0, 0, 0, 1);
        }

        .progress-container {
            border-radius: 5px;
            overflow: hidden;
            position: relative; 
            width: 100%; 
            height: 35px; 
            background-color: #d0d0d0;
            text-align: center;
            border: 2px solid #a0a0a0;
            box-shadow: 0 2px 5px rgba(0, 0, 0, 0.1);
        }

        .progress-container-tag {
            width: 250px;
            border-radius: 5px;
            overflow: hidden;
            background-color: #d0d0d0; 
            position: relative;
            border: 2px solid #a0a0a0;
            box-shadow: 0 2px 5px rgba(0, 0, 0, 0.1);
            height: 35px;  
            position: relative;
            margin-left: 1%;
            margin-bottom: 1%;
        }

        .progress-bar-green {
            height: 35px;
            background-color: #4CAF50;
            text-align: center;
            color: white;
            line-height: 30px;
            padding: 0 10px;
            display: flex;
            justify-content: center;
            align-items: center;
            white-space: nowrap;  
            position: absolute; 
            top: 0; 
            left: 0;
        }

        .progress-bar-yellow {
            height: 35px;
            background-color: #FFC107;
            text-align: center;
            color: white;
            line-height: 30px;
            padding: 0 10px;
            display: flex;
            justify-content: center;
            align-items: center;
            white-space: nowrap;
            position: absolute; 
            top: 0; 
            left: 0;
        }

        .progress-bar-red {
            height: 35px;
            background-color: #F44336;
            text-align: center;
            color: white;
            line-height: 30px;
            padding: 0 10px;
            display: flex;
            justify-content: center;
            align-items: center;
            white-space: nowrap;
            position: absolute; 
            top: 0; 
            left: 0;
        }

        .tag-section {
            margin-top: 20px;
            padding: 10px;
            border: 1px solid #ccc;
            border-radius: 5px;
            background-color: #f9f9f9;
            display: flex;
            flex-direction: column;
        }

        .tag-container {
            display: grid;
            grid-template-columns: repeat(auto-fill, minmax(400px, 1fr));
            gap: 10px;
        }

        .tag-header {
            display: block;
            align-items: center;
        }
        
        .tag-title {
            padding-left: 1%;
            padding-right: 1%;
            min-width: 430px;
        }
        .endpoint {
            padding: 8px;
            background-color: #ffffff;
            border-radius: 5px;
            box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1);
            margin-bottom: 5px;
        }


        h3 {
            padding-left: 1%;
        }

        .status {
            font-weight: bold;
            padding-left: 1%;
        }

        .error {
            color: red;
        }

        .endpoint {
            padding: 5px 0;
            cursor: pointer; /* Indicates it's clickable */
            padding: 10px;
            background-color: #f2f2f2;
            border: 1px solid #ccc;
            border-radius: 5px;
            margin-bottom: 10px;
            transition: background-color 0.3s ease;
        }

        /* Hover effect for the endpoint */
        .endpoint:hover {
            background-color: #e0e0e0;
            border-color: #007BFF;
        }

        /* Hidden content inside the endpoint (details) */
        .endpoint-details {
            display: none;
            margin-top: 10px;
            padding-left: 20px;
            background-color: #f9f9f9;
            border-left: 3px solid #4CAF50;
        }


        .error {
            color: red;
        }

        table {
            width: 90%;
            margin: 20px auto;
            border-collapse: collapse;
            text-align: center;
            box-shadow: 0px 4px 8px rgba(0, 0, 0, 0.1);
            border-radius: 5px;
            overflow: hidden;
        }

        th,
        td {
            border: 1px solid #ccc;
            padding: 12px;
            text-align: center;
        }

        th {
            background-color: #007BFF;
            color: black;
            font-size: 16px;
        }

        td {
            font-size: 14px;
            background-color: #f8f9fa;
        }

        .summary-container {
            text-align: center;
            font-size: 22px;
            font-weight: bold;
            margin-bottom: 20px;
        }

        .summary-highlight {
            color: #007BFF;
            font-size: 26px;
            font-weight: bold;
        }

        th,
        td {
            border: 1px solid #ccc;
            padding: 8px;
            text-align: left;
        }

        th {
            background-color: #f4f4f4;
        }
      </style>
          <script>
        // Ensure the script runs after the page is fully loaded
        document.addEventListener("DOMContentLoaded", function() {
          console.log("Page is fully loaded");
    
          // Select all the endpoints
          const endpoints = document.querySelectorAll('.endpoint');
    
          // Add a click event to each endpoint
          endpoints.forEach(endpoint => {
            endpoint.addEventListener('click', function() {
              console.log("Endpoint clicked!");  // Debug: check if the event fires
    
              const details = endpoint.querySelector('.endpoint-details');
              if (details.style.display === 'block') {
                details.style.display = 'none';
              } else {
                details.style.display = 'block';
              }
            });
          });
        });
      </script>
  </head>
  <body>
  
      <h1>API Schema Validation Coverage Report: ${version}</h1>
      <p><strong>Total Endpoints:</strong> ${totalEndpoints}</p>
      <p><strong>Tested Endpoints:</strong> ${testedCount} (${coveragePercentage}%)</p>

      <table>
      <thead>
        <tr>
            <th>Category</th>
            <th>Count</th>
            <th>Percent</th>
        </tr>
      </thead>
        <tbody>
            <tr><td>Total tested endpoints with no errors</td><td>${validEndpoints}</td><td>${((validEndpoints/testedCount) * 100).toFixed(0)}%</td></tr>
            <tr><td>Total tested endpoints with errors</td><td>${data.length - validEndpoints}</td><td>${(((data.length-validEndpoints)/testedCount)*100).toFixed(0)}%</td></tr>
            <tr><td>Total tested endpoints with unsupported sorters</td><td>${countEndpointsByStatus(data, "UNSUPPORTED_SORTERS")}</td><td>${((countEndpointsByStatus(data, "UNSUPPORTED_SORTERS")/testedCount)*100).toFixed(0)}%</td></tr>
            <tr><td>Total tested endpoints with undocumented sorters</td><td>${countEndpointsByStatus(data, "UNDOCUMENTED_SORTERS")}</td><td>${((countEndpointsByStatus(data, "UNDOCUMENTED_SORTERS")/testedCount)*100).toFixed(0)}%</td></tr>
            <tr><td>Total tested endpoints with unsupported filters</td><td>${countEndpointsByStatus(data, "UNSUPPORTED_FILTERS")}</td><td>${((countEndpointsByStatus(data, "UNSUPPORTED_FILTERS")/testedCount)*100).toFixed(0)}%</td></tr>
            <tr><td>Total tested endpoints with undocumented filters</td><td>${countEndpointsByStatus(data, "UNDOCUMENTED_FILTERS")}</td><td>${((countEndpointsByStatus(data, "UNDOCUMENTED_FILTERS")/testedCount)*100).toFixed(0)}%</td></tr>
            <tr><td>Total tested endpoints with additional properties</td><td>${countEndpointsByStatus(data, "ADDITIONAL_PROPERTIES")}</td><td>${((countEndpointsByStatus(data, "ADDITIONAL_PROPERTIES")/testedCount)*100).toFixed(0)}%</td></tr>
            <tr><td>Total tested endpoints with API errors</td><td>${countEndpointsByStatus(data, "API_ERROR")}</td><td>${((countEndpointsByStatus(data, "API_ERROR")/testedCount)*100).toFixed(0)}%</td></tr>
            <tr><td>Total tested endpoints with API schema mismatch</td><td>${countEndpointsByStatus(data, "API_SCHEMA_MISMATCH")}</td><td>${((countEndpointsByStatus(data, "API_SCHEMA_MISMATCH")/testedCount)*100).toFixed(0)}%</td></tr>
            <tr><td>Total tested endpoints with invalid schema</td><td>${countEndpointsByStatus(data, "INVALID_SCHEMA")}</td><td>${((countEndpointsByStatus(data, "INVALID_SCHEMA")/testedCount)*100).toFixed(0)}%</td></tr>
            <tr><td>Total tested endpoints with no data</td><td>${countEndpointsByStatus(data, "NO_DATA")}</td><td>${((countEndpointsByStatus(data, "NO_DATA")/testedCount)*100).toFixed(0)}%</td></tr>
            <tr><td>Total tested endpoints with path param unresolved</td><td>${countEndpointsByStatus(data, "PATH_PARAM_UNRESOLVED")}</td><td>${((countEndpointsByStatus(data, "PATH_PARAM_UNRESOLVED")/testedCount)*100).toFixed(0)}%</td></tr>
            <tr><td>Total tested endpoints with schema not found</td><td>${countEndpointsByStatus(data, "SCHEMA_NOT_FOUND")}</td><td>${((countEndpointsByStatus(data,"SCHEMA_NOT_FOUND")/testedCount)*100).toFixed(0)}%</td></tr>
        </tbody>
      </table>
  
      </br>
      <div class="progress-container">
          <div class="progress-bar-green" style="width: ${coveragePercentage}%">
            <div class="progress-text">
            ${coveragePercentage}%
            </div>
          </div>
      </div>

    ${Object.entries(endpointsByTag).map(([tag, endpoints]) => `
        <div class="tag-section">
            <div class="tag-header">
            <h2 class="tag-title">${tag}</h2>
            <div class="progress-container-tag">
                <div class="progress-text">
                ${generateProgressBar(endpoints)}
                </div>
            </div>
            </div>
            ${endpoints.map(entry => `
                <div class="endpoint">
                    ${entry.status.length > 0 ? `
                    <h3>${entry.method} ${entry.endpoint} ❌</h3> ` : `
                    <h3>${entry.method} ${entry.endpoint} ✅</h3>`}
                    <p class="status">Status: <span>${entry.status}</span></p>
                    ${entry.errors?.length > 0 ? `
                    <ul>
                        ${entry.errors.map(error => `
                        <li class="error"><strong>Message:</strong> ${error.message}${error.path ? ` (Path: <code>${error.path}</code>)` : ''}</li>
                        `).join('')}
                    </ul>` : ""}
                    <div class="endpoint-details">
                    ${entry.schemaErrors && Object.keys(entry.schemaErrors).length > 0 ? `
                      <div class="schema-errors">
                          <h4>Schema Errors:</h4>
                          <ul>
                              ${Object.entries(entry.schemaErrors).map(([key, error]) => `
                              <li>
                                ${error.message}
                              </li>
                              `).join('')}
                          </ul>
                      </div>` : ""}
                      ${entry.unsupportedFilters && entry.unsupportedFilters.length > 0 ? `
                      <div class="unsupported-filters">
                          <h4>Unsupported Filters:</h4>
                          <ul>
                              ${entry.unsupportedFilters.map( filter => `
                              <li>
                                ${filter.message}
                              </li>
                              `).join('')}
                          </ul>
                      </div>` : ""}
                      ${entry.undocumentedFilters && entry.undocumentedFilters.length > 0 ? `
                      <div class="undocumented-filters">
                          <h4>Undocumented Filters:</h4>
                          <ul>
                              ${entry.undocumentedFilters.map( filter => `
                              <li>
                                ${filter.message}
                              </li>
                              `).join('')}
                          </ul>
                      </div>` : ""}
                      ${entry.undocumentedSorters && entry.undocumentedSorters.length > 0 ? `
                      <div class="undocumented-sorters">
                          <h4>Undocumented Sorters:</h4>
                          <ul>
                              ${entry.unsupportedSorters.map( filter => `
                              <li>
                                ${filter.message}
                              </li>
                              `).join('')}
                          </ul>
                      </div>` : ""}
                      ${entry.unsupportedSorters && entry.unsupportedSorters.length > 0 ? `
                      <div class="unsupported-sorters">
                          <h4>Unsupported Sorters:</h4>
                          <ul>
                              ${entry.unsupportedSorters.map( filter => `
                              <li>
                                ${filter.message}
                              </li>
                              `).join('')}
                          </ul>
                      </div>` : ""}
                    </div>
                </div>
            `).join('')}
        </div>
    `).join('')}
  
  </body>
  </html>`;
  }
  

module.exports = { generateHtmlReport };
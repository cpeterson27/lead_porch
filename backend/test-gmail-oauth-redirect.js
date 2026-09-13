const assert = require("node:assert/strict");
const { primaryFrontendUrl } = require("./utils/frontendUrl");

assert.equal(
  primaryFrontendUrl(
    "https://leadporch.co, https://www.leadporch.co, https://elliescoaching.com/",
  ),
  "https://leadporch.co",
);
assert.equal(primaryFrontendUrl("https://leadporch.co/"), "https://leadporch.co");
assert.equal(primaryFrontendUrl(""), "http://localhost:5173");

console.log("Gmail OAuth selects one valid frontend redirect origin.");

import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const source = fs.readFileSync(path.join(__dirname, "src/services/api.js"), "utf8");
assert.match(source, /data\?\.code !== "CSRF_INVALID"/);
assert.match(source, /api\.get\("\/auth\/session", \{ __skipCsrfRecovery: true \}\)/);
assert.match(source, /sessionStorage\.setItem\("ellie-csrf-token", data\.csrfToken\)/);
assert.match(source, /original\.__csrfRetried/);
assert.match(source, /return api\.request\(original\)/);
console.log("Cross-tab CSRF recovery checks passed.");

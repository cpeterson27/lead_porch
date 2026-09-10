import assert from "node:assert/strict";
import fs from "node:fs";

const source = fs.readFileSync("src/pages/Opportunities.jsx", "utf8");
const styles = fs.readFileSync("src/pages/Opportunities.css", "utf8");
const api = fs.readFileSync("src/services/api.js", "utf8");
// The Sales Agent panel is a shared component (also used on the main Sales Pipeline drawer, not
// just the Closer Queue), so its controls live in SalesAgentPanel.jsx rather than this page.
const salesAgentPanel = fs.readFileSync("src/components/SalesAgentPanel.jsx", "utf8");

for (const label of ["Closer Queue", "My Leads", "High Priority", "Needs Follow-up", "New / Uncontacted", "Application Submitted", "Why qualified", "Next action", "Record activity", "Assign Closer"]) assert(source.includes(label), `Missing Closer Queue control: ${label}`);
assert(source.includes("SalesAgentPanel"), "Closer Queue must render the shared Sales Agent panel");
for (const label of ["Ask Sales Agent", "Summarize Lead", "What Should I Do Next?", "Draft Outreach", "Handle Objection", "AI assistance only", "Copy draft"]) assert(salesAgentPanel.includes(label), `Missing user-initiated Sales Agent control: ${label}`);
assert(source.includes('canAssign ? [["all", "All Assigned"]]'), "All Assigned must remain authorization-gated");
assert(source.includes("fetchWorkspaceMembers") && source.includes('member.roles?.includes("closer")'), "Assignment choices must reuse active workspace Closers");
assert(api.includes('/opportunities/closer-queue') && api.includes('/activities') && api.includes('/assign'), "Closer UI must use the scoped workflow APIs");
assert(api.includes('/sales-assist'), "Sales Agent must use the explicit user-initiated endpoint");
assert(styles.includes("grid-template-columns:repeat(auto-fit") && styles.includes("@media(max-width:600px)"), "Closer cards must use responsive layout rules");
console.log("Closer Queue controls, authorization visibility, API wiring, and responsive contracts passed.");

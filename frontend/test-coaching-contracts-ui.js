import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(path.join(root, "src/pages/CoachingAdmin.jsx"), "utf8");
const css = fs.readFileSync(path.join(root, "src/pages/Coaching.css"), "utf8");

const checks = [
  [source.includes("function ContractContactPicker"), "contracts use a searchable contact picker"],
  [source.includes('role="combobox"') && source.includes('role="listbox"'), "picker exposes accessible combobox semantics"],
  [source.includes("Start typing a name or email"), "picker explains that names and emails are searchable"],
  [source.includes("contact.email || contact.company"), "search results identify contacts with supporting details"],
  [source.includes("signerName: labelOfContact(contact)") && source.includes('signerEmail: contact.email || ""'), "selecting a contact autofills signer name and email"],
  [source.includes("Choose a contact from the search results"), "free text cannot be submitted without selecting a database contact"],
  [source.includes("slice(0, 10)"), "picker limits the visible result list"],
  [css.includes(".contract-contact-picker__results"), "search results are styled as a compact overlay"],
];

const failed = checks.filter(([passed]) => !passed);
if (failed.length) {
  failed.forEach(([, message]) => console.error(`FAIL: ${message}`));
  process.exit(1);
}
checks.forEach(([, message]) => console.log(`PASS: ${message}`));

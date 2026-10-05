// Simple {{firstName}}/{{lastName}}/{{company}} substitution shared by
// every plain-text send path that isn't the full campaign email-template
// system (sequences, one-off sends, newsletters) — deliberately not the
// richer invitationTemplateService token set, which is scoped to team
// invitations specifically.
function applyEmailTokens(text, contact) {
  const firstName = String(contact?.firstName || contact?.name || "").trim().split(/\s+/)[0] || "there";
  const lastName = String(contact?.lastName || "").trim();
  const company = String(contact?.company || "").trim();
  return String(text || "")
    .replaceAll("{{firstName}}", firstName)
    .replaceAll("{{lastName}}", lastName)
    .replaceAll("{{company}}", company);
}

module.exports = { applyEmailTokens };

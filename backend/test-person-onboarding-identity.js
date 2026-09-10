const assert = require("node:assert/strict");
const service = require("./services/workspaceMemberService");
const doc = data => ({ ...data, async save() { return this; } });
const query = value => ({ select() { return this; }, lean: async () => value, then: resolve => Promise.resolve(value).then(resolve) });
async function fixture(kind, existing = false, foreign = false) {
  const user = doc({ _id: "u1", name: existing ? "Existing Person" : "", email: "person@example.test", phone: existing ? "+1 existing" : "" });
  const member = doc({ workspaceId: "w1", userId: "u1", status: "active", roles: [kind], role: kind, responsibilities: {} });
  let creates = 0, invitations = 0;
  const models = {
    User: { findOne: async () => existing ? user : null, create: async data => { creates++; return Object.assign(user, data); } },
    WorkspaceMembership: { findOne: async filter => { assert.equal(filter.workspaceId,"w1"); return existing && !foreign ? member : null; }, findOneAndUpdate: async (filter, update) => Object.assign(member, update.$set), exists: async () => foreign },
    WorkspaceInvitation: { findOneAndUpdate: async (filter, update) => { invitations++; assert.equal(filter.workspaceId,"w1"); return doc(update.$set); } },
    CoachProfile: { findOne: () => query(null), findOneAndUpdate: async (filter, update) => { assert.equal(filter.workspaceId,"w1"); assert.equal(filter.userId,"u1"); return doc(update.$set); } },
    AmbassadorProfile: { findOne: () => query(null), findOneAndUpdate: async (filter, update) => { assert.equal(filter.workspaceId,"w1"); assert.equal(filter.userId,"u1"); return doc(update.$set); } },
    CoachingProgram: { find: () => query([]) },
    integrationHub: { execute() { throw Error("No provider calls allowed"); } },
  };
  const fn = kind === "coach" ? service.onboardCoach : kind === "ambassador" ? service.onboardAmbassador : service.inviteMember;
  const result = await fn({workspaceId:"w1",actorUserId:"owner",firstName:"  Jordan  ",lastName:"  Taylor  ",email:" PERSON@example.test ",phone:"+1 555 0100",roles:[kind]}, models);
  assert.equal(creates, existing ? 0 : 1);
  assert.equal(result.user.name,existing?"Existing Person":"Jordan Taylor");
  assert.equal(result.user.phone,existing?"+1 existing":"+1 555 0100");
  if (!existing) { assert.equal(user.firstName,"Jordan"); assert.equal(user.lastName,"Taylor"); assert.equal(invitations,1); }
  if (foreign) assert.equal(user.firstName,undefined,"No global identity modification from a foreign workspace");
  if (kind === "coach") assert.equal(result.coachProfile.displayName,result.user.name);
  if (kind === "ambassador") assert.equal(result.ambassadorProfile.displayName,result.user.name);
}
(async () => {
  for (const role of ["member","coach","ambassador"]) { await fixture(role); await fixture(role,true); await fixture(role,true,true); }
  await assert.rejects(service.inviteMember({firstName:"Jordan",lastName:"",email:"person@example.test"},{}),/last name/);
  await assert.rejects(service.inviteMember({firstName:"J",lastName:"T",phone:"x".repeat(51)},{}),/length/);
  console.log("Canonical structured names, optional phone, Coach/Ambassador linkage, duplicate reuse and foreign-user preservation passed.");
})().catch(error => {console.error(error);process.exitCode=1;});

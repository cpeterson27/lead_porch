const agentRegistry = require("./agentRegistry");
const agentToolExecutor = require("./agentToolExecutor");
const aiConfigService = require("./aiConfigService");
const knowledgeService = require("./knowledgeService");
const conversationService = require("./jarvisConversationService");
const llmService = require("./llmService");
const { PROMPT_VERSION, buildAgentMessages } = require("./agentPromptRegistry");
const proposalService = require("./agentProposalService");

const safeText = (value, limit) => typeof value === "string" ? value.slice(0, limit) : JSON.stringify(value ?? {}).slice(0, limit);
function capabilitiesAllowed(auth, definition) { return agentToolExecutor.hasRequiredCapabilities(auth, definition.requiredCapabilities, definition.capabilityMode); }

async function runAgent(request, dependencies = {}) {
  const { workspaceId, userId, actorType = "user", principal = "", agent, task, input = {}, operationalContext = "", conversationId = null, correlationId = "", options = {}, auth } = request || {};
  const agents = dependencies.agentRegistry || agentRegistry;
  const definition = agents.getAgent(agent);
  if (!definition) { const error = new Error("Unknown AI agent"); error.code = "AGENT_UNKNOWN"; throw error; }
  if (!workspaceId || !auth || String(auth.workspaceId) !== String(workspaceId)) { const error = new Error("Agent workspace context does not match the caller"); error.code = "AGENT_WORKSPACE_FORBIDDEN"; throw error; }
  if (!capabilitiesAllowed(auth, definition)) { const error = new Error("The caller cannot use this AI agent"); error.code = "AGENT_CAPABILITY_FORBIDDEN"; throw error; }
  const config = dependencies.aiConfigService || aiConfigService;
  await config.assertEnabled({ workspaceId, agent });

  const knowledge = await (dependencies.knowledgeService || knowledgeService).retrieveKnowledge({ workspaceId, query: safeText(options.knowledgeQuery || task || input, 1000), agent, categories: options.knowledgeCategories || definition.knowledgeCategories, limit: Math.min(6, Math.max(1, Number(options.knowledgeLimit) || 4)) });
  const conversation = conversationId
    ? await (dependencies.conversationService || conversationService).history({ workspaceId, userId, conversationId })
    : { messages: [] };
  const toolResults = [];
  for (const request of (Array.isArray(options.tools) ? options.tools : []).slice(0, 8)) {
    toolResults.push(await (dependencies.toolExecutor || agentToolExecutor).executeTool({ workspaceId, userId, agent, toolId: request.toolId, input: request.input || {}, auth }, dependencies.toolDependencies));
  }
  const messages = buildAgentMessages({
    agent,
    task: safeText(task, 2000),
    input,
    // Default 20000 is plenty for a normal instruction+context prompt, but
    // a blind character slice at that limit will cut a large JSON payload
    // (e.g. 20 candidates' full evidence) off mid-object — the model then
    // never receives valid data for whichever candidates landed past the
    // cutoff, and silently omits them from its output. A caller building a
    // genuinely large structured payload can raise this explicitly via
    // options.operationalContextLimit instead of hitting that silently.
    operationalContext: safeText(operationalContext, Math.max(20000, Math.min(120000, Number(options.operationalContextLimit) || 20000))),
    approvedKnowledge: safeText(knowledge.context, 8000),
    conversationContext: safeText(conversation.messages?.map((item) => `${item.role}: ${item.content}`).join("\n"), 12000),
    toolResults,
  });
  const llm = dependencies.llmService || llmService;
  const feature = `agent.${String(task || "run").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 100) || "run"}`;
  let output;
  if (options.responseSchema) {
    if (!definition.structuredOutput) { const error = new Error("This agent does not support structured output"); error.code = "AGENT_STRUCTURED_OUTPUT_FORBIDDEN"; throw error; }
    output = await llm.generateStructured({ workspaceId, userId, actorType, principal, agent, feature, correlationId, model: options.model, messages, schema: options.responseSchema, schemaName: options.schemaName || `${agent}_output` });
  } else {
    if (!definition.generateText) { const error = new Error("This agent does not support text generation"); error.code = "AGENT_TEXT_OUTPUT_FORBIDDEN"; throw error; }
    output = await llm.generateText({ workspaceId, userId, actorType, principal, agent, feature, correlationId, model: options.model, messages });
  }
  const proposedAction = options.proposedAction
    ? (dependencies.proposalService || proposalService).prepareProposal({ agent, recommendation: typeof output === "string" ? output : "Structured recommendation prepared", ...options.proposedAction })
    : null;
  return { output, proposedAction, metadata: { agent, feature, promptVersion: PROMPT_VERSION, model: options.model || llm.getStatus?.().model || null, correlationId: String(correlationId || ""), usageRecorded: true, toolsUsed: toolResults.map((item) => item.tool), knowledgeSources: knowledge.sources || [] } };
}

module.exports = { capabilitiesAllowed, runAgent };

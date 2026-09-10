/**
 * Jarvis Assistant Service
 * AI control layer for Growth Operator systems
 * Provides intelligent insights and recommendations
 * Executes marketing actions (campaigns, email delivery)
 */

const Organization = require("../models/OrganizationRelationship");
const Audience = require("../models/Audience");
const Contact = require("../models/Contact");
const MarketingCampaign = require("../models/MarketingCampaign");
const Event = require("../models/Event");
const contactService = require("./contactService");
const bootcampMarketingWorkflow = require("./bootcampMarketingWorkflow");
const marketingCampaignExecution = require("./marketingCampaignExecution");
const llmService = require("./llmService");
const knowledgeService = require("./knowledgeService");
const jarvisConversationService = require("./jarvisConversationService");
const jarvisProfileService = require("./jarvisProfileService");
const growthAnalyticsService = require("./growthAnalyticsService");
const jarvisAgentCoordinator = require("./jarvisAgentCoordinator");

class JarvisService {
  selectSpecializedAgent(message) {
    return jarvisAgentCoordinator.selectSpecializedAgent(message);
  }
  /**
   * Process natural language queries and return insights
   * @param {String} message - User query
   * @returns {Object} { answer, data, actionsAvailable }
   */
  async processQuery(message, executionContext = {}) {
    if (!message || typeof message !== "string") {
      throw new Error("Message is required");
    }

    const activity = [{ label: "Checking Growth Operator workspace data", status: "complete" }];
    const profile = await jarvisProfileService.getProfile();
    const memory = executionContext.workspaceId
      ? await knowledgeService.retrieveKnowledge({ workspaceId: executionContext.workspaceId, query: message, agent: "jarvis" })
      : { available: false, sources: [], context: "", authority: "approved_business_knowledge" };
    const conversation = executionContext.conversationId
      ? await jarvisConversationService.history({ workspaceId: executionContext.workspaceId, userId: executionContext.userId, conversationId: executionContext.conversationId })
      : { conversation: null, messages: [] };
    if (memory.available) activity.push({ label: memory.sources.length ? `Consulted ${memory.sources.length} relevant vault note${memory.sources.length === 1 ? "" : "s"}` : "No matching vault notes found", status: "complete", sources: memory.sources });
    const lowerMessage = message.toLowerCase();
    let result = null;

    // Route to appropriate handler based on keywords
    if (/active students|commission|referred.*revenue|campaign.*sales|missed.*sessions|communications.*failing|social content|revenue|funnel/i.test(lowerMessage)) {
      result = await this.handleGrowthAnalyticsQuery(message);
    } else if (
      lowerMessage.includes("priority") ||
      lowerMessage.includes("priorities") ||
      lowerMessage.includes("focus") ||
      lowerMessage.includes("important")
    ) {
      result = await this.handlePriorityQuery(message);
    } else if (
      lowerMessage.includes("organization") ||
      lowerMessage.includes("company")
    ) {
      result = await this.handleOrganizationQuery(message);
    } else if (
      lowerMessage.includes("contact") ||
      lowerMessage.includes("attendee") ||
      lowerMessage.includes("recipient")
    ) {
      result = await this.handleContactQuery(message);
    } else if (
      lowerMessage.includes("campaign") ||
      lowerMessage.includes("email")
    ) {
      result = await this.handleCampaignQuery(message);
    } else if (
      lowerMessage.includes("audience") ||
      lowerMessage.includes("analytics")
    ) {
      result = await this.handleAudienceQuery(message);
    } else if (
      lowerMessage.includes("opportunity") ||
      lowerMessage.includes("growth")
    ) {
      result = await this.handleGrowthQuery(message);
    } else {
      result = await this.handleGeneralQuery(message);
    }

    // Jarvis coordinates: for questions squarely inside a specialized agent's
    // domain that Jarvis's own deterministic handlers can't ground with real
    // tool access (Lead research, Content drafting), delegate to that agent
    // and attach its grounded answer alongside Jarvis's own verified summary.
    // This never replaces the deterministic answer above — only adds to it.
    const specializedAgent = executionContext.auth && executionContext.workspaceId
      ? jarvisAgentCoordinator.selectSpecializedAgent(message)
      : null;
    if (llmService.isEnabled() && ["lead", "content"].includes(specializedAgent)) {
      try {
        const delegated = await jarvisAgentCoordinator.runSpecialized({
          task: message,
          agent: specializedAgent,
          workspaceId: executionContext.workspaceId,
          userId: executionContext.userId,
          auth: executionContext.auth,
          correlationId: executionContext.correlationId,
          options: {
            tools: specializedAgent === "content"
              ? [{ toolId: "content.list_briefs", input: { limit: 10 } }, { toolId: "growth.analytics", input: {} }]
              : [{ toolId: "crm.search_contacts", input: { limit: 10 } }, { toolId: "crm.list_opportunities", input: { limit: 10 } }],
          },
        });
        result.delegatedAgent = { agent: specializedAgent, answer: delegated.output };
        activity.push({ label: `Consulted the ${specializedAgent === "content" ? "Content" : "Lead"} Agent`, status: "complete" });
      } catch (error) {
        activity.push({ label: `${specializedAgent === "content" ? "Content" : "Lead"} Agent unavailable`, status: "warning" });
      }
    }

    if (llmService.isEnabled()) {
      try {
        const answer = await llmService.chat({
          message,
          context: [
            "AUTHORITATIVE OPERATIONAL FACTS (Growth Operator database):",
            result.answer,
            memory.context ? `APPROVED LONG-TERM BUSINESS KNOWLEDGE (must not override operational facts):\n${memory.context}` : "",
            conversation.messages.length ? `RECENT CONVERSATION CONTINUITY:\n${conversation.messages.map((item) => `${item.role}: ${item.content}`).join("\n")}` : "",
          ].filter(Boolean).join("\n\n"),
          profile,
          workspaceId: executionContext.workspaceId,
          userId: executionContext.userId,
          agent: "jarvis",
          feature: "jarvis.chat",
          correlationId: executionContext.correlationId,
        });
        activity.push({ label: "Drafted a response with OpenAI", status: "complete" });
        result = { ...result, answer, aiAssisted: true };
      } catch (error) {
        console.warn("[Jarvis] OpenAI response unavailable; using verified workspace summary", { code: error.code || "OPENAI_REQUEST_FAILED" });
        activity.push({ label: "OpenAI unavailable; used the workspace summary", status: "warning" });
      }
    }

    if (executionContext.conversationId) {
      const savedConversation = await jarvisConversationService.appendTurn({ workspaceId: executionContext.workspaceId, userId: executionContext.userId, conversationId: executionContext.conversationId, userMessage: message, assistantMessage: result.answer });
      result.conversationId = savedConversation._id;
    }
    result.memory = { recorded: false, reason: "long_term_memory_requires_explicit_approval" };

    return { ...result, activity, memorySources: memory.sources };
  }

  async handleGrowthAnalyticsQuery() {
    const analytics = await growthAnalyticsService.getAnalytics();
    const topReferral = analytics.attribution.byCoachReferral[0]; const topCampaign = analytics.attribution.byCampaign[0];
    return { answer: `Growth Operator currently has ${analytics.coaching.activeStudents} active students, $${analytics.revenue.total.toLocaleString()} tracked revenue, and $${analytics.referrals.pendingCommission.toLocaleString()} pending commission.${topReferral ? ` ${topReferral.coach} leads coach-referral revenue at $${topReferral.revenue.toLocaleString()}.` : ""}${topCampaign ? ` The leading attributed campaign/content is ${topCampaign.campaign}.` : ""}`, data: analytics, actionsAvailable: [] };
  }

  /**
   * Handle priority-related queries
   * @private
   */
  async handlePriorityQuery(message) {
    const summary = await this.getPrioritySummary();
    const topOrgs = await this.getTopOrganizations();

    return {
      answer: this.formatPrioritySummary(summary, topOrgs),
      data: {
        summary,
        topOrganizations: topOrgs,
      },
      actionsAvailable: [
        "review_organization",
        "view_audience",
        "start_campaign",
      ],
    };
  }

  /**
   * Handle organization-related queries
   * @private
   */
  async handleOrganizationQuery(message) {
    const topOrgs = await this.getTopOrganizations();
    const stats = await this.getOrganizationStats();

    return {
      answer: this.formatOrganizationSummary(topOrgs, stats),
      data: {
        topOrganizations: topOrgs,
        stats,
      },
      actionsAvailable: [
        "view_organization",
        "add_audience",
        "create_campaign",
      ],
    };
  }

  /**
   * Handle contact-related queries
   * @private
   */
  async handleContactQuery(message) {
    const contactStats = await this.getContactStats();
    const stats = await this.getStats();

    return {
      answer: this.formatContactSummary(contactStats),
      data: {
        bySource: contactStats.bySource,
        byStatus: contactStats.byStatus,
        total: contactStats.total,
        stats,
      },
      actionsAvailable: [
        "view_contacts",
        "filter_by_source",
        "export_contacts",
      ],
    };
  }

  /**
   * Handle campaign-related queries
   * @private
   */
  async handleCampaignQuery(message) {
    const campaignStatus = await this.getCampaignStatus();
    const stats = await this.getStats();

    return {
      answer: this.formatCampaignSummary(campaignStatus),
      data: {
        campaigns: campaignStatus,
        stats,
      },
      actionsAvailable: [
        "view_campaigns",
        "create_campaign",
        "view_performance",
      ],
    };
  }

  /**
   * Handle audience-related queries
   * @private
   */
  async handleAudienceQuery(message) {
    const audienceStats = await this.getAudienceStats();
    const stats = await this.getStats();

    return {
      answer: this.formatAudienceSummary(audienceStats),
      data: {
        audiences: audienceStats,
        stats,
      },
      actionsAvailable: ["view_audiences", "create_audience", "view_analytics"],
    };
  }

  /**
   * Handle growth-related queries
   * @private
   */
  async handleGrowthQuery(message) {
    const opportunities = await this.getGrowthOpportunities();
    const topOrgs = await this.getTopOrganizations();

    return {
      answer: this.formatGrowthSummary(opportunities),
      data: {
        opportunities,
        topOrganizations: topOrgs,
      },
      actionsAvailable: [
        "create_campaign",
        "start_outreach",
        "review_organization",
      ],
    };
  }

  /**
   * Handle general queries
   * @private
   */
  async handleGeneralQuery(message) {
    const summary = await this.getPrioritySummary();
    const topOrgs = await this.getTopOrganizations();
    const campaigns = await this.getCampaignStatus();

    return {
      answer: this.formatGeneralSummary(summary, topOrgs, campaigns),
      data: {
        summary,
        topOrganizations: topOrgs,
        campaigns,
      },
      actionsAvailable: ["view_dashboard", "create_campaign", "start_outreach"],
    };
  }

  /**
   * Get priority summary across all systems
   * @returns {Object} Priority metrics
   */
  async getPrioritySummary() {
    try {
      const organizations = await Organization.find({})
        .populate("organizationId", "name")
        .sort({ priority: -1 })
        .limit(10)
        .lean();

      const highPriority = organizations.filter(
        (o) => o.priority && o.priority >= 7,
      ).length;
      const mediumPriority = organizations.filter(
        (o) => o.priority && o.priority >= 4 && o.priority < 7,
      ).length;
      const lowPriority = organizations.filter(
        (o) => !o.priority || o.priority < 4,
      ).length;

      return {
        totalOrganizations: organizations.length,
        highPriority,
        mediumPriority,
        lowPriority,
        topOrganization:
          organizations[0]?.organizationId?.name || "No organizations",
      };
    } catch (err) {
      console.error("[Jarvis] Priority summary error:", err.message);
      return {
        error: err.message,
        totalOrganizations: 0,
        highPriority: 0,
        mediumPriority: 0,
        lowPriority: 0,
      };
    }
  }

  /**
   * Get top organizations by priority
   * @returns {Array} Top organizations
   */
  async getTopOrganizations() {
    try {
      const organizations = await Organization.find({})
        .populate("organizationId", "name")
        .sort({ priority: -1 })
        .limit(5)
        .select("organizationId priority relationshipType createdAt")
        .lean();

      return organizations.map((org) => ({
        name: org.organizationId?.name || "Unknown",
        priority: org.priority || 0,
        type: org.relationshipType || "unknown",
        createdAt: org.createdAt,
      }));
    } catch (err) {
      console.error("[Jarvis] Top organizations error:", err.message);
      return [];
    }
  }

  /**
   * Get organization statistics
   * @returns {Object} Organization stats
   */
  async getOrganizationStats() {
    try {
      const total = await Organization.countDocuments();
      const highPriority = await Organization.countDocuments({
        priority: { $gte: 7 },
      });

      return {
        total,
        highPriority,
        avgPriority: total > 0 ? ((highPriority / total) * 10).toFixed(1) : 0,
      };
    } catch (err) {
      console.error("[Jarvis] Organization stats error:", err.message);
      return { total: 0, highPriority: 0, avgPriority: 0 };
    }
  }

  /**
   * Get audience statistics
   * @returns {Array} Audience stats
   */
  async getAudienceStats() {
    try {
      const audiences = await Audience.find({})
        .select("name discoverySource createdAt")
        .lean();

      const bySource = {};
      audiences.forEach((aud) => {
        const source = aud.discoverySource || "unknown";
        bySource[source] = (bySource[source] || 0) + 1;
      });

      return {
        total: audiences.length,
        bySource,
        audiences: audiences.slice(0, 5),
      };
    } catch (err) {
      console.error("[Jarvis] Audience stats error:", err.message);
      return { total: 0, bySource: {}, audiences: [] };
    }
  }

  /**
   * Get contact statistics
   * @returns {Object} Contact stats
   */
  async getContactStats() {
    try {
      const total = await Contact.countDocuments();

      // Count by source (Contact stores multiple sources per contact in `sources`)
      const bySource = await Contact.aggregate([
        { $unwind: { path: "$sources", preserveNullAndEmptyArrays: true } },
        {
          $group: {
            _id: "$sources",
            count: { $sum: 1 },
          },
        },
      ]);

      // Count by status
      const byStatus = await Contact.aggregate([
        {
          $group: {
            _id: "$status",
            count: { $sum: 1 },
          },
        },
      ]);

      const sourceMap = {};
      bySource.forEach((item) => {
        sourceMap[item._id || "unknown"] = item.count;
      });

      const statusMap = {};
      byStatus.forEach((item) => {
        statusMap[item._id || "unknown"] = item.count;
      });

      return {
        total,
        bySource: sourceMap,
        byStatus: statusMap,
      };
    } catch (err) {
      console.error("[Jarvis] Contact stats error:", err.message);
      return { total: 0, bySource: {}, byStatus: {} };
    }
  }

  /**
   * Get campaign status
   * @returns {Array} Campaign info
   */
  async getCampaignStatus() {
    try {
      const campaigns = await MarketingCampaign.find({})
        .select("name type status createdAt")
        .sort({ createdAt: -1 })
        .limit(10)
        .lean();

      const byStatus = {};
      campaigns.forEach((camp) => {
        byStatus[camp.status] = (byStatus[camp.status] || 0) + 1;
      });

      return {
        total: campaigns.length,
        byStatus,
        recent: campaigns.slice(0, 3),
      };
    } catch (err) {
      console.error("[Jarvis] Campaign status error:", err.message);
      return { total: 0, byStatus: {}, recent: [] };
    }
  }

  /**
   * Get growth opportunities
   * @returns {Object} Growth recommendations
   */
  async getGrowthOpportunities() {
    try {
      const contactStats = await this.getContactStats();
      const campaignStatus = await this.getCampaignStatus();
      const topOrgs = await this.getTopOrganizations();

      const opportunities = [];

      // Opportunity: New contacts available
      if (contactStats.total > 0) {
        const inactiveContacts = contactStats.byStatus?.inactive || 0;
        if (inactiveContacts === 0) {
          opportunities.push({
            title: "Engage with inactive contacts",
            description: `You have ${contactStats.total} contacts available for outreach`,
            priority: "high",
            action: "create_campaign",
          });
        }
      }

      // Opportunity: Campaign performance
      if (campaignStatus.byStatus?.draft > 0) {
        opportunities.push({
          title: "Launch draft campaigns",
          description: `${campaignStatus.byStatus.draft} campaigns ready to send`,
          priority: "high",
          action: "launch_campaign",
        });
      }

      // Opportunity: High-priority organizations
      if (topOrgs.length > 0) {
        const unengagedHighPriority = topOrgs.filter((o) => o.priority >= 8);
        if (unengagedHighPriority.length > 0) {
          opportunities.push({
            title: "Focus on high-priority organizations",
            description: `${unengagedHighPriority.length} organizations require attention`,
            priority: "high",
            action: "review_organization",
          });
        }
      }

      return {
        total: opportunities.length,
        opportunities,
        recommendation:
          opportunities.length > 0
            ? opportunities[0]
            : {
                title: "System operational",
                description: "All key metrics are healthy",
                priority: "low",
              },
      };
    } catch (err) {
      console.error("[Jarvis] Growth opportunities error:", err.message);
      return { total: 0, opportunities: [], recommendation: {} };
    }
  }

  /**
   * Get general statistics
   * @returns {Object} Overall stats
   */
  async getStats() {
    try {
      const [
        organizationCount,
        audienceCount,
        contactCount,
        campaignCount,
        eventCount,
      ] = await Promise.all([
        Organization.countDocuments(),
        Audience.countDocuments(),
        Contact.countDocuments(),
        MarketingCampaign.countDocuments(),
        Event.countDocuments(),
      ]);

      return {
        organizations: organizationCount,
        audiences: audienceCount,
        contacts: contactCount,
        campaigns: campaignCount,
        events: eventCount,
      };
    } catch (err) {
      console.error("[Jarvis] Stats error:", err.message);
      return {
        organizations: 0,
        audiences: 0,
        contacts: 0,
        campaigns: 0,
        events: 0,
      };
    }
  }

  /**
   * Format priority summary as readable text
   * @private
   */
  formatPrioritySummary(summary, topOrgs) {
    const lines = [
      "📊 **Priority Summary**",
      `• Total Organizations: ${summary.totalOrganizations}`,
      `• High Priority: ${summary.highPriority}`,
      `• Medium Priority: ${summary.mediumPriority}`,
      `• Low Priority: ${summary.lowPriority}`,
    ];

    if (topOrgs.length > 0) {
      lines.push(`\n🎯 **Top Organization**: ${topOrgs[0].name}`);
      if (topOrgs[0].priority) {
        lines.push(`   Priority Level: ${topOrgs[0].priority}/10`);
      }
    }

    lines.push(
      `\n💡 **Recommendation**: Focus on high-priority organizations to maximize impact.`,
    );

    return lines.join("\n");
  }

  /**
   * Format organization summary
   * @private
   */
  formatOrganizationSummary(topOrgs, stats) {
    const lines = [
      "🏢 **Organization Summary**",
      `• Total Organizations: ${stats.total}`,
      `• High Priority: ${stats.highPriority}`,
      `• Average Priority: ${stats.avgPriority}/10`,
    ];

    if (topOrgs.length > 0) {
      lines.push("\n**Top 5 Organizations:**");
      topOrgs.forEach((org, i) => {
        lines.push(`${i + 1}. ${org.name} (Priority: ${org.priority}/10)`);
      });
    }

    return lines.join("\n");
  }

  /**
   * Format contact summary
   * @private
   */
  formatContactSummary(contactStats) {
    const lines = [
      "👥 **Contact Summary**",
      `• Total Contacts: ${contactStats.total}`,
    ];

    if (Object.keys(contactStats.bySource).length > 0) {
      lines.push("\n**Contacts by Source:**");
      Object.entries(contactStats.bySource).forEach(([source, count]) => {
        lines.push(`• ${source}: ${count}`);
      });
    }

    if (Object.keys(contactStats.byStatus).length > 0) {
      lines.push("\n**Contacts by Status:**");
      Object.entries(contactStats.byStatus).forEach(([status, count]) => {
        lines.push(`• ${status}: ${count}`);
      });
    }

    return lines.join("\n");
  }

  /**
   * Format campaign summary
   * @private
   */
  formatCampaignSummary(campaignStatus) {
    const lines = [
      "📧 **Campaign Summary**",
      `• Total Campaigns: ${campaignStatus.total}`,
    ];

    if (Object.keys(campaignStatus.byStatus).length > 0) {
      lines.push("\n**Campaigns by Status:**");
      Object.entries(campaignStatus.byStatus).forEach(([status, count]) => {
        lines.push(`• ${status}: ${count}`);
      });
    }

    if (campaignStatus.recent.length > 0) {
      lines.push("\n**Recent Campaigns:**");
      campaignStatus.recent.forEach((camp) => {
        lines.push(`• ${camp.name} (${camp.status})`);
      });
    }

    return lines.join("\n");
  }

  /**
   * Format audience summary
   * @private
   */
  formatAudienceSummary(audienceStats) {
    const lines = [
      "🎯 **Audience Summary**",
      `• Total Audiences: ${audienceStats.total}`,
    ];

    if (Object.keys(audienceStats.bySource).length > 0) {
      lines.push("\n**Audiences by Source:**");
      Object.entries(audienceStats.bySource).forEach(([source, count]) => {
        lines.push(`• ${source}: ${count}`);
      });
    }

    if (audienceStats.audiences.length > 0) {
      lines.push("\n**Recent Audiences:**");
      audienceStats.audiences.forEach((aud) => {
        lines.push(`• ${aud.name}`);
      });
    }

    return lines.join("\n");
  }

  /**
   * Format growth summary
   * @private
   */
  formatGrowthSummary(opportunities) {
    const lines = [
      "🚀 **Growth Opportunities**",
      `• Total Opportunities: ${opportunities.total}`,
    ];

    if (opportunities.opportunities.length > 0) {
      lines.push("\n**Available Actions:**");
      opportunities.opportunities.forEach((opp) => {
        lines.push(`• **${opp.title}** (${opp.priority})`);
        lines.push(`  ${opp.description}`);
      });
    } else {
      lines.push(
        "\n✅ No immediate opportunities - system is running smoothly",
      );
    }

    return lines.join("\n");
  }

  /**
   * Format general summary
   * @private
   */
  formatGeneralSummary(summary, topOrgs, campaigns) {
    const lines = [
      "🤖 **Jarvis System Overview**",
      `• Organizations: ${summary.totalOrganizations}`,
      `• High Priority: ${summary.highPriority}`,
    ];

    if (campaigns.total > 0) {
      lines.push(`• Campaigns: ${campaigns.total}`);
    }

    lines.push(`\n💡 **What you can ask:**`);
    lines.push(`• Organization priorities`);
    lines.push(`• Contact statistics`);
    lines.push(`• Campaign status`);
    lines.push(`• Growth opportunities`);
    lines.push(`• Audience analytics`);

    return lines.join("\n");
  }

  // =========================================================================
  // ACTION LAYER - Campaign Recommendations & Execution
  // =========================================================================

  /**
   * Recommend and create a bootcamp campaign draft
   * @param {Object} options - { audienceId, organizationId, templateType }
   * @returns {Object} Campaign draft
   */
  async recommendCampaignDraft(options = {}) {
    try {
      const {
        audienceId,
        organizationId,
        templateType = "announcement",
      } = options;

      // Get or create audience
      let audience = null;
      if (audienceId) {
        audience = await Audience.findById(audienceId);
      } else {
        // Use first available audience or create default
        audience = await Audience.findOne().lean();
        if (!audience) {
          audience = await Audience.create({
            name: "Default Jarvis Audience",
            discoverySource: "jarvis",
          });
        }
      }

      if (!audience) {
        throw new Error("No audience available for campaign");
      }

      // Get template
      const templates = bootcampMarketingWorkflow.getTemplates();
      const template = templates[templateType];

      if (!template) {
        throw new Error(`Template "${templateType}" not found`);
      }

      // Create campaign draft
      const campaign = new MarketingCampaign({
        name: `${template.name} - Generated by Jarvis`,
        type: "email",
        status: "draft",
        audienceId: audience._id,
        organizationId,
        content: {
          subject: template.subject,
          body: template.htmlBody,
          htmlBody: template.htmlBody,
          callToAction: template.callToAction,
          callToActionUrl: "https://example.com/register",
        },
      });

      await campaign.save();

      return {
        success: true,
        campaign: {
          id: campaign._id,
          name: campaign.name,
          type: campaign.type,
          status: campaign.status,
          template: templateType,
          subject: template.subject,
          callToAction: template.callToAction,
        },
        message: `Campaign draft created: "${campaign.name}"`,
      };
    } catch (err) {
      console.error("[Jarvis] Recommend campaign error:", err.message);
      return {
        success: false,
        error: err.message,
      };
    }
  }

  /**
   * Generate campaign recipient summary
   * @param {String} campaignId - Campaign ID
   * @param {Object} filters - { source, tags, limit }
   * @returns {Object} Recipient summary
   */
  async prepareRecipients(campaignId, filters = {}) {
    try {
      // Get campaign
      const campaign = await MarketingCampaign.findById(campaignId);
      if (!campaign) {
        throw new Error("Campaign not found");
      }

      // Get recipients based on filters
      const recipients = await contactService.getCampaignRecipients(
        campaignId,
        {
          ...filters,
          limit: filters.limit || 100,
        },
      );

      if (recipients.length === 0) {
        return {
          success: true,
          campaignId,
          recipientCount: 0,
          recipients: [],
          message: "No recipients matched the filter criteria",
        };
      }

      // Analyze recipients
      const bySource = {};
      recipients.forEach((r) => {
        const source = r.source || "unknown";
        bySource[source] = (bySource[source] || 0) + 1;
      });

      return {
        success: true,
        campaignId,
        recipientCount: recipients.length,
        bySource,
        recipients: recipients.slice(0, 10), // Return first 10 for preview
        totalAvailable: recipients.length,
        message: `Found ${recipients.length} recipients ready for campaign`,
        actionsAvailable: [
          "send_test_email",
          "review_recipients",
          "launch_campaign",
        ],
      };
    } catch (err) {
      console.error("[Jarvis] Prepare recipients error:", err.message);
      return {
        success: false,
        error: err.message,
      };
    }
  }

  /**
   * Prepare and execute test email
   * @param {String} campaignId - Campaign ID
   * @param {String} testEmail - Recipient email for test
   * @returns {Object} Execution result
   */
  async executeTestEmail(campaignId, testEmail) {
    try {
      if (!testEmail || typeof testEmail !== "string") {
        throw new Error("Valid test email is required");
      }

      // Get campaign
      const campaign = await MarketingCampaign.findById(campaignId);
      if (!campaign) {
        throw new Error("Campaign not found");
      }

      if (campaign.type !== "email") {
        throw new Error("Only email campaigns can be executed");
      }

      // Ensure campaign has HTML content
      if (!campaign.content?.htmlBody) {
        if (campaign.content?.body && !campaign.content?.htmlBody) {
          campaign.content.htmlBody = campaign.content.body;
          await campaign.save();
        } else {
          throw new Error("Campaign missing required email content");
        }
      }

      // Execute test email via marketing campaign execution service
      const result = await marketingCampaignExecution.executeCampaign(
        campaignId,
        {
          testEmail,
        },
      );

      return {
        success: true,
        campaignId,
        testEmail,
        messageId: result.messageId,
        status: result.campaignStatus,
        sentAt: result.sentAt,
        message: `Test email sent successfully to ${testEmail}`,
        next: "Review email then launch campaign to all recipients",
      };
    } catch (err) {
      console.error("[Jarvis] Execute test email error:", err.message);
      return {
        success: false,
        error: err.message,
      };
    }
  }

  /**
   * Get campaign execution status
   * @param {String} campaignId - Campaign ID
   * @returns {Object} Campaign status
   */
  async getCampaignExecutionStatus(campaignId) {
    try {
      const campaign = await MarketingCampaign.findById(campaignId).lean();
      if (!campaign) {
        throw new Error("Campaign not found");
      }

      const recipientCount = await Contact.countDocuments({
        // Rough estimate based on audience
        status: "active",
      });

      return {
        success: true,
        campaign: {
          id: campaign._id,
          name: campaign.name,
          type: campaign.type,
          status: campaign.status,
          subject: campaign.content?.subject,
        },
        metrics: {
          sent: campaign.metrics?.sent || 0,
          delivered: campaign.metrics?.delivered || 0,
          opened: campaign.metrics?.opened || 0,
          clicked: campaign.metrics?.clicked || 0,
          converted: campaign.metrics?.converted || 0,
        },
        recipients: {
          available: recipientCount,
          sent: campaign.metrics?.sent || 0,
        },
        timeline: {
          createdAt: campaign.createdAt,
          startedAt: campaign.startedAt,
          completedAt: campaign.completedAt,
        },
        integrations: campaign.integrations,
      };
    } catch (err) {
      console.error("[Jarvis] Campaign execution status error:", err.message);
      return {
        success: false,
        error: err.message,
      };
    }
  }
}

module.exports = new JarvisService();

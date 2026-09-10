/**
 * Marketing Campaign Execution Service
 * Converts MarketingCampaigns into email deliveries via Resend
 */

const MarketingCampaign = require("../models/MarketingCampaign");
const IntegrationConnection = require("../models/IntegrationConnection");
const ResendAdapter = require("./integrations/email/ResendAdapter");
const { checkSendEligibility } = require("./email");

class MarketingCampaignExecutionService {
  /**
   * Execute an email marketing campaign
   * @param {String} campaignId - Marketing campaign ID
   * @param {Object} options - Execution options (testEmail, recipientEmail)
   * @returns {Promise<Object>} Execution result
   */
  async executeCampaign(campaignId, options = {}) {
    try {
      // Get campaign
      const campaign = await MarketingCampaign.findById(campaignId);
      if (!campaign) {
        throw new Error("Marketing campaign not found");
      }

      // Only email campaigns can be executed currently
      if (campaign.type !== "email") {
        throw new Error(
          `Campaign type "${campaign.type}" not supported for execution`,
        );
      }

      // Validate campaign has required content
      if (!campaign.content?.subject || !campaign.content?.htmlBody) {
        throw new Error(
          "Campaign missing required email content (subject or htmlBody)",
        );
      }

      // Get Resend adapter with credentials
      const adapter = await this.getResendAdapter();
      if (!adapter) {
        throw new Error("Resend email provider not configured");
      }

      // Determine recipient
      const recipientEmail = options.recipientEmail || options.testEmail;
      if (!recipientEmail) {
        throw new Error("No recipient email provided");
      }

      // Get sender email
      const fromEmail = process.env.EMAIL_FROM || "noreply@example.com";

      // Send email
      const emailResult = await adapter.sendEmail({
        from: fromEmail,
        to: recipientEmail,
        subject: campaign.content.subject,
        html: campaign.content.htmlBody || campaign.content.body,
      });

      // Update campaign tracking
      campaign.status = "active";
      campaign.metrics.sent = (campaign.metrics.sent || 0) + 1;
      campaign.startedAt = new Date();

      campaign.integrations.email = {
        provider: "resend",
        campaignId: emailResult.messageId,
        status: "sent",
      };

      await campaign.save();

      return {
        success: true,
        campaignId: campaign._id,
        messageId: emailResult.messageId,
        recipient: recipientEmail,
        subject: campaign.content.subject,
        sentAt: emailResult.sentAt,
        campaignStatus: "active",
        message: "Email campaign sent successfully",
      };
    } catch (error) {
      console.error(
        "[MarketingCampaignExecutionService] Execute error:",
        error.message,
      );
      throw error;
    }
  }

  /**
   * Execute campaign to multiple recipients (batch)
   * @param {String} campaignId - Campaign ID
   * @param {Array} recipients - Array of recipient email addresses
   * @returns {Promise<Object>} Batch execution result
   */
  async executeCampaignBatch(campaignId, recipients = []) {
    try {
      if (!Array.isArray(recipients) || recipients.length === 0) {
        throw new Error("Recipients array is required and must not be empty");
      }

      // Get campaign
      const campaign = await MarketingCampaign.findById(campaignId);
      if (!campaign) {
        throw new Error("Marketing campaign not found");
      }

      if (campaign.type !== "email") {
        throw new Error(
          `Campaign type "${campaign.type}" not supported for execution`,
        );
      }

      if (!campaign.content?.subject || !campaign.content?.htmlBody) {
        throw new Error("Campaign missing required email content");
      }

      // Get Resend adapter
      const adapter = await this.getResendAdapter();
      if (!adapter) {
        throw new Error("Resend email provider not configured");
      }

      const fromEmail = process.env.EMAIL_FROM || "noreply@example.com";

      // Never send campaign email to a suppressed, unverified, or
      // non-consenting address — checkSendEligibility is the same gate
      // services/email.js uses for individual outreach.
      const eligibility = await Promise.all(
        recipients.map(async (to) => ({ to, result: await checkSendEligibility(to, { emailTopic: campaign.communication?.topic }) })),
      );
      const eligible = eligibility.filter((row) => row.result.eligible);
      const blocked = eligibility.filter((row) => !row.result.eligible).map((row) => ({ to: row.to, reason: row.result.message }));
      if (!eligible.length) {
        throw new Error("No recipients are eligible for campaign email (suppressed, unverified, or not opted in).");
      }

      // Build email array
      const emails = eligible.map(({ to }) => ({
        from: fromEmail,
        to,
        subject: campaign.content.subject,
        html: campaign.content.htmlBody || campaign.content.body,
      }));

      // Send batch
      const batchResult = await adapter.sendBatch(emails);

      // Update campaign
      campaign.status = "active";
      campaign.metrics.sent = (campaign.metrics.sent || 0) + eligible.length;
      campaign.startedAt = new Date();

      campaign.integrations.email = {
        provider: "resend",
        campaignId: batchResult.results[0]?.messageId || "batch",
        status: "sent",
      };

      await campaign.save();

      return {
        success: true,
        campaignId: campaign._id,
        recipientCount: eligible.length,
        sentCount: batchResult.results.length,
        sentAt: new Date(),
        results: batchResult.results,
        blocked,
        message: `Campaign sent to ${eligible.length} recipients${blocked.length ? `, ${blocked.length} blocked (suppressed/unverified/not opted in)` : ""}`,
      };
    } catch (error) {
      console.error(
        "[MarketingCampaignExecutionService] Batch execute error:",
        error.message,
      );
      throw error;
    }
  }

  /**
   * Update campaign execution status
   * @param {String} campaignId - Campaign ID
   * @param {Object} statusUpdate - Status update {status, metrics}
   * @returns {Promise<Object>}
   */
  async updateCampaignStatus(campaignId, statusUpdate = {}) {
    try {
      const campaign = await MarketingCampaign.findById(campaignId);
      if (!campaign) {
        throw new Error("Marketing campaign not found");
      }

      // Update status if provided
      if (statusUpdate.status) {
        const validStatuses = [
          "draft",
          "scheduled",
          "active",
          "completed",
          "paused",
          "archived",
        ];
        if (!validStatuses.includes(statusUpdate.status)) {
          throw new Error(`Invalid status: ${statusUpdate.status}`);
        }
        campaign.status = statusUpdate.status;
      }

      // Update metrics if provided
      if (statusUpdate.metrics) {
        campaign.metrics = {
          ...campaign.metrics,
          ...statusUpdate.metrics,
          _updated: new Date(),
        };
      }

      await campaign.save();

      return {
        success: true,
        campaignId: campaign._id,
        status: campaign.status,
        metrics: campaign.metrics,
      };
    } catch (error) {
      console.error(
        "[MarketingCampaignExecutionService] Update status error:",
        error.message,
      );
      throw error;
    }
  }

  /**
   * Get campaign execution status
   * @param {String} campaignId - Campaign ID
   * @returns {Promise<Object>}
   */
  async getCampaignStatus(campaignId) {
    try {
      const campaign = await MarketingCampaign.findById(campaignId).select(
        "name type status content metrics integrations startedAt scheduledFor",
      );

      if (!campaign) {
        throw new Error("Marketing campaign not found");
      }

      return {
        success: true,
        campaign: {
          id: campaign._id,
          name: campaign.name,
          type: campaign.type,
          status: campaign.status,
          subject: campaign.content?.subject,
          metrics: campaign.metrics,
          integrations: campaign.integrations,
          startedAt: campaign.startedAt,
          scheduledFor: campaign.scheduledFor,
        },
      };
    } catch (error) {
      console.error(
        "[MarketingCampaignExecutionService] Get status error:",
        error.message,
      );
      throw error;
    }
  }

  /**
   * Pause campaign execution
   * @param {String} campaignId - Campaign ID
   * @returns {Promise<Object>}
   */
  async pauseCampaign(campaignId) {
    try {
      const campaign = await MarketingCampaign.findByIdAndUpdate(
        campaignId,
        { status: "paused" },
        { new: true },
      ).select("name status metrics");

      if (!campaign) {
        throw new Error("Marketing campaign not found");
      }

      return {
        success: true,
        campaignId: campaign._id,
        status: campaign.status,
        message: "Campaign paused",
      };
    } catch (error) {
      console.error(
        "[MarketingCampaignExecutionService] Pause error:",
        error.message,
      );
      throw error;
    }
  }

  /**
   * Resume campaign execution
   * @param {String} campaignId - Campaign ID
   * @returns {Promise<Object>}
   */
  async resumeCampaign(campaignId) {
    try {
      const campaign = await MarketingCampaign.findByIdAndUpdate(
        campaignId,
        { status: "active" },
        { new: true },
      ).select("name status metrics");

      if (!campaign) {
        throw new Error("Marketing campaign not found");
      }

      return {
        success: true,
        campaignId: campaign._id,
        status: campaign.status,
        message: "Campaign resumed",
      };
    } catch (error) {
      console.error(
        "[MarketingCampaignExecutionService] Resume error:",
        error.message,
      );
      throw error;
    }
  }

  /**
   * Execute campaign to contact recipients
   * @param {String} campaignId - Campaign ID
   * @param {Array} contacts - Array of contact objects {email, name, company}
   * @returns {Promise<Object>} Execution result
   */
  async executeCampaignToContacts(campaignId, contacts = []) {
    try {
      if (!Array.isArray(contacts) || contacts.length === 0) {
        throw new Error("Contacts array is required and must not be empty");
      }

      // Get campaign
      const campaign = await MarketingCampaign.findById(campaignId);
      if (!campaign) {
        throw new Error("Marketing campaign not found");
      }

      if (campaign.type !== "email") {
        throw new Error(
          `Campaign type "${campaign.type}" not supported for execution`,
        );
      }

      if (!campaign.content?.subject || !campaign.content?.htmlBody) {
        throw new Error("Campaign missing required email content");
      }

      // Get Resend adapter
      const adapter = await this.getResendAdapter();
      if (!adapter) {
        throw new Error("Resend email provider not configured");
      }

      const fromEmail = process.env.EMAIL_FROM || "noreply@example.com";

      // Extract valid emails from contacts
      const candidateContacts = contacts.filter(
        (c) => c.email && typeof c.email === "string",
      );
      if (candidateContacts.length === 0) {
        throw new Error("No valid email addresses in contacts");
      }

      // Never send campaign email to a suppressed, unverified, or
      // non-consenting contact — checkSendEligibility is the same gate
      // services/email.js uses for individual outreach.
      const eligibility = await Promise.all(
        candidateContacts.map(async (contact) => ({ contact, result: await checkSendEligibility(contact.email, { contactId: contact._id, emailTopic: campaign.communication?.topic }) })),
      );
      const validContacts = eligibility.filter((row) => row.result.eligible).map((row) => row.contact);
      const blocked = eligibility.filter((row) => !row.result.eligible).map((row) => ({ email: row.contact.email, reason: row.result.message }));
      if (validContacts.length === 0) {
        throw new Error("No contacts are eligible for campaign email (suppressed, unverified, or not opted in).");
      }

      // Build email array with contact data
      const emails = validContacts.map((contact) => ({
        from: fromEmail,
        to: contact.email,
        subject: campaign.content.subject,
        html: campaign.content.htmlBody || campaign.content.body,
      }));

      // Send batch to contacts
      const batchResult = await adapter.sendBatch(emails);

      // Update campaign
      campaign.status = "active";
      campaign.metrics.sent =
        (campaign.metrics.sent || 0) + validContacts.length;
      campaign.startedAt = new Date();

      campaign.integrations.email = {
        provider: "resend",
        campaignId: batchResult.results[0]?.messageId || "batch",
        status: "sent",
        recipientCount: validContacts.length,
      };

      await campaign.save();

      return {
        success: true,
        campaignId: campaign._id,
        recipientCount: validContacts.length,
        sentCount: batchResult.results.length,
        sentAt: new Date(),
        results: batchResult.results.map((r) => ({
          messageId: r.messageId,
          contact: validContacts[batchResult.results.indexOf(r)],
        })),
        blocked,
        message: `Campaign sent to ${validContacts.length} contacts${blocked.length ? `, ${blocked.length} blocked (suppressed/unverified/not opted in)` : ""}`,
      };
    } catch (error) {
      console.error(
        "[MarketingCampaignExecutionService] Execute to contacts error:",
        error.message,
      );
      throw error;
    }
  }

  /**
   * Get Resend adapter with credentials
   * @private
   * @returns {Promise<ResendAdapter|null>}
   */
  async getResendAdapter() {
    try {
      // Try to get credentials from IntegrationConnection
      const connection = await IntegrationConnection.findOne({
        provider: "resend",
      }).select("credentials");

      let apiKey =
        connection?.credentials?.apiKey || process.env.RESEND_API_KEY;

      if (!apiKey) {
        console.warn(
          "[MarketingCampaignExecutionService] No Resend API key available",
        );
        return null;
      }

      return new ResendAdapter({
        apiKey,
      });
    } catch (error) {
      console.error(
        "[MarketingCampaignExecutionService] Get adapter error:",
        error.message,
      );
      return null;
    }
  }
}

module.exports = new MarketingCampaignExecutionService();

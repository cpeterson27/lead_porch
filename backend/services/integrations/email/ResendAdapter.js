/**
 * Resend Email Integration Adapter
 * Handles email sending via Resend API
 */

const BaseIntegration = require("../BaseIntegration");

class ResendAdapter extends BaseIntegration {
  constructor(config = {}) {
    super("Resend", "email", config);
    this.baseUrl = "https://api.resend.com";
    this.capabilities = [
      "send_email",
      "send_batch",
      "track_opens",
      "track_clicks",
    ];
  }

  getVersion() {
    return "2.0.0"; // Resend API version
  }

  getCapabilities() {
    return this.capabilities;
  }

  /**
   * Verify Resend connection
   * Without live credentials, we just validate config structure
   */
  async verify() {
    try {
      if (!this.config.apiKey) {
        throw new Error("Resend API key not configured");
      }

      // In production, would make actual API call
      // const response = await fetch(`${this.baseUrl}/emails`, {
      //   headers: { Authorization: `Bearer ${this.config.apiKey}` }
      // });
      // if (!response.ok) throw new Error("Failed to authenticate with Resend");

      this.authenticated = true;
      this.clearError();
      return {
        success: true,
        message: "Resend configured (not authenticated)",
      };
    } catch (error) {
      this.setError(error.message);
      return { success: false, error: error.message };
    }
  }

  /**
   * Send email campaign
   * @param {Object} params { to, subject, html, from }
   * @returns {Promise<Object>}
   */
  async sendEmail(params, credentialContext = null) {
    try {
      const apiKey = credentialContext?.credentials?.apiKey ||
        this.config.apiKey ||
        process.env.RESEND_API_KEY;

      if (!apiKey) {
        throw new Error("Resend API key missing.");
      }

      const { to, subject, text, html, from, replyTo, headers, idempotencyKey } = params;

      if (!to || !subject || !html || !from) {
        throw new Error("Missing required email fields");
      }

      // Call Resend API
      const response = await fetch(`${this.baseUrl}/emails`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          ...(idempotencyKey ? { "Idempotency-Key": String(idempotencyKey).slice(0, 256) } : {}),
        },
        signal: AbortSignal.timeout(15000),
        body: JSON.stringify({
          from,
          to,
          subject,
          text,
          html,
          ...(replyTo ? { reply_to: replyTo } : {}),
          ...(headers ? { headers } : {}),
        }),
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(
          errorData.message || `Resend API error: ${response.status}`,
        );
      }

      const result = await response.json();

      return {
        success: true,
        messageId: result.id,
        to,
        subject,
        sentAt: new Date(),
      };
    } catch (error) {
      this.setError(error.message);
      throw error;
    }
  }

  /**
   * Send batch emails
   * @param {Array} emails Array of { to, subject, html, from }
   * @returns {Promise<Object>}
   */
  async sendBatch(emails) {
    try {
      if (!this.config.apiKey) {
        throw new Error("Resend not configured");
      }

      const results = [];
      for (const email of emails) {
        const result = await this.sendEmail(email);
        results.push(result);
      }

      return {
        success: true,
        sent: results.length,
        results,
      };
    } catch (error) {
      this.setError(error.message);
      throw error;
    }
  }
}

module.exports = ResendAdapter;

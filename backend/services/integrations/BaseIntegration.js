/**
 * Base Integration Adapter
 * All integration adapters extend this class to provide a consistent interface
 */

class BaseIntegration {
  constructor(name, type, config = {}) {
    this.name = name;
    this.type = type; // 'email' | 'events' | 'social'
    this.config = config;
    this.authenticated = false;
    this.lastError = null;
  }

  /**
   * Get integration status
   * @returns {Object} { name, type, authenticated, lastChecked, version, capabilities }
   */
  async getStatus() {
    return {
      name: this.name,
      type: this.type,
      authenticated: this.authenticated,
      lastChecked: new Date(),
      version: this.getVersion(),
      capabilities: this.getCapabilities(),
      config: this.getSafeConfig(), // Only return non-sensitive config
    };
  }

  // Provider contract. Adapters override only the capabilities they support.
  async connect() {
    return this.authenticate();
  }

  async authenticate() {
    return this.verify();
  }

  async status() {
    const configured = Object.values(this.config || {}).some(Boolean);

    return {
      connected: this.authenticated,
      configured,
      missingRequirements: configured ? [] : ["configuration"],
      availableOperations: this.getCapabilities(),
    };
  }

  async search() {
    throw new Error(`${this.name} does not support search()`);
  }

  async create() {
    throw new Error(`${this.name} does not support create()`);
  }

  async update() {
    throw new Error(`${this.name} does not support update()`);
  }

  async delete() {
    throw new Error(`${this.name} does not support delete()`);
  }

  async sync() {
    throw new Error(`${this.name} does not support sync()`);
  }

  normalize(record) {
    return record;
  }

  /**
   * Extract field value from data by trying multiple possible keys.
   * Shared by adapters that map loosely-shaped provider payloads
   * (varying column/field names) into contact records.
   * @param {Object} data - Data object
   * @param {Array} possibleKeys - Array of possible keys to try
   * @returns {String|null} Field value or null
   */
  extractFieldValue(data, possibleKeys) {
    if (!data || typeof data !== "object") return null;
    for (const key of possibleKeys) {
      if (data[key]) return data[key];
    }
    return null;
  }

  /**
   * Get version info
   * @returns {String} Semantic version
   */
  getVersion() {
    return "1.0.0";
  }

  /**
   * Get available capabilities
   * @returns {Array} List of operations this integration can perform
   */
  getCapabilities() {
    return [];
  }

  /**
   * Get safe config (non-sensitive)
   * @returns {Object} Config without credentials
   */
  getSafeConfig() {
    const safe = { ...this.config };
    delete safe.apiKey;
    delete safe.apiSecret;
    delete safe.accessToken;
    delete safe.refreshToken;
    delete safe.password;
    return safe;
  }

  /**
   * Verify connection
   * Override in subclasses
   */
  async verify() {
    throw new Error("verify() must be implemented by subclass");
  }

  /**
   * Disconnect
   * Override in subclasses if needed
   */
  async disconnect() {
    this.authenticated = false;
  }

  /**
   * Set error state
   */
  setError(error) {
    this.lastError = error;
    this.authenticated = false;
  }

  /**
   * Clear error state
   */
  clearError() {
    this.lastError = null;
  }
}

module.exports = BaseIntegration;

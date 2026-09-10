/**
 * Eventbrite Integration Adapter
 * Syncs attendees from Eventbrite events into contacts
 */

const BaseIntegration = require("./BaseIntegration");

class EventbriteAdapter extends BaseIntegration {
  constructor() {
    super("eventbrite", "Eventbrite Events");
    this.endpoint = "https://www.eventbriteapi.com/v3";
  }

  getCapabilities() {
    return ["syncAttendees", "normalizeContacts"];
  }

  /**
   * Sync attendees from Eventbrite events
   * @param {Object} credentials - { apiKey, eventIds }
   * @returns {Array} Attendees from Eventbrite events
   */
  async syncAttendees(credentials) {
    if (!credentials || !credentials.apiKey) {
      throw new Error("Eventbrite API key required for sync");
    }

    const eventIds =
      credentials.eventIds ||
      process.env.EVENTBRITE_EVENT_IDS?.split(",") ||
      [];
    if (!Array.isArray(eventIds) || eventIds.length === 0) {
      throw new Error(
        "Eventbrite event IDs required (set EVENTBRITE_EVENT_IDS or provide eventIds)",
      );
    }

    try {
      const allAttendees = [];

      // Fetch attendees from each event
      for (const eventId of eventIds) {
        const attendees = await this.fetchEventAttendees(
          credentials.apiKey,
          eventId,
        );
        allAttendees.push(...attendees);
      }

      if (allAttendees.length === 0) {
        console.log(
          "[EventbriteAdapter] No attendees found in configured events",
        );
        return [];
      }

      // Map to contact format
      const contacts = this.mapEventbriteAttendees(allAttendees);
      return contacts;
    } catch (err) {
      throw new Error(
        `Failed to sync attendees from Eventbrite: ${err.message}`,
      );
    }
  }

  /**
   * Fetch attendees from a specific Eventbrite event
   * @private
   * @param {String} apiKey - Eventbrite API key
   * @param {String} eventId - Event ID
   * @returns {Array} Attendees from event
   */
  async fetchEventAttendees(apiKey, eventId) {
    const attendees = [];
    let page = 1;
    let hasMore = true;

    while (hasMore) {
      try {
        const url = `${this.endpoint}/events/${eventId}/attendees/?page=${page}&expand=profile`;

        const response = await fetch(url, {
          method: "GET",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
          },
        });

        if (!response.ok) {
          if (response.status === 404) {
            console.log(`[EventbriteAdapter] Event ${eventId} not found`);
            break;
          }
          throw new Error(`Eventbrite API error: ${response.statusText}`);
        }

        const data = await response.json();

        if (!data.attendees || !Array.isArray(data.attendees)) {
          break;
        }

        // Log attendee statuses for debugging
        const statuses = data.attendees.map((a) => a.status);
        const uniqueStatuses = [...new Set(statuses)];
        console.log(
          `[EventbriteAdapter] Event ${eventId} page ${page}: ${data.attendees.length} attendees. Statuses: ${uniqueStatuses.join(", ")}`,
        );

        attendees.push(...data.attendees);

        // Check for pagination
        hasMore = data.pagination?.page_number < data.pagination?.page_count;
        page++;
      } catch (err) {
        console.error(
          `[EventbriteAdapter] Error fetching page ${page} for event ${eventId}:`,
          err.message,
        );
        break;
      }
    }

    return attendees;
  }

  /**
   * Fetch Eventbrite user info for validation
   * @param {Object} credentials - { apiKey }
   * @returns {Object} User info
   */
  async fetchUserInfo(credentials) {
    if (!credentials || !credentials.apiKey) {
      throw new Error("Eventbrite API key required");
    }

    try {
      const response = await fetch(`${this.endpoint}/users/me/`, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${credentials.apiKey}`,
          "Content-Type": "application/json",
        },
      });

      if (!response.ok) {
        throw new Error(`Eventbrite API error: ${response.statusText}`);
      }

      const data = await response.json();
      return data || null;
    } catch (err) {
      throw new Error(`Failed to fetch user info: ${err.message}`);
    }
  }

  /**
   * Map Eventbrite attendees to contact format
   * @param {Array} attendees - Eventbrite attendees
   * @returns {Array} Contacts in standard format
   */
  mapEventbriteAttendees(attendees) {
    if (!attendees || !Array.isArray(attendees)) return [];

    const statuses = {};
    const filtered = attendees.filter((attendee) => {
      // Only include attendees with email
      if (!attendee.profile || !attendee.profile.email) {
        return false;
      }

      // Accept multiple status formats (Eventbrite may use various capitalization/formats)
      // Eventbrite API typically returns: "attending", "checked_in", "not_attending", "tentative"
      const status = attendee.status?.toLowerCase() || "";
      const checkedIn = attendee.checked_in;

      // Track all statuses for logging
      statuses[attendee.status || "unknown"] =
        (statuses[attendee.status || "unknown"] || 0) + 1;

      // Include attendees with "attending" or "checked_in" status, or those marked as checked_in
      return (
        status === "attending" ||
        status === "checked_in" ||
        status === "checked in" ||
        checkedIn === true
      );
    });

    // Log filtering statistics
    if (attendees.length > 0) {
      const filteredCount = filtered.length;
      const totalCount = attendees.length;
      if (filteredCount < totalCount) {
        console.log(
          `[EventbriteAdapter] Filtered: ${filteredCount}/${totalCount} attendees passed status filter`,
        );
        console.log(`[EventbriteAdapter] Status breakdown:`, statuses);
      }
    }

    return filtered
      .map((attendee) => {
        const profile = attendee.profile;
        let firstName = profile.first_name || "";
        let lastName = profile.last_name || "";
        let fullName = `${firstName} ${lastName}`.trim();

        if (!fullName) {
          fullName = profile.name || profile.email;
        }

        return {
          name: fullName,
          firstName: firstName || profile.name || "",
          lastName: lastName || "",
          email: profile.email.toLowerCase(),
          company: profile.company || "",
          externalId: attendee.id,
          tags: ["eventbrite"],
          status: "active",
          eventParticipation: { provider: "eventbrite", eventId: String(attendee.event_id || attendee.event?.id || ""), attendeeId: String(attendee.id || ""), status: attendee.checked_in === true || String(attendee.status || "").toLowerCase().replace(" ", "_") === "checked_in" ? "attended" : "registered", checkedInAt: attendee.checked_in === true ? new Date() : null },
        };
      })
      .filter((contact) => contact.email && contact.email.trim().length > 0); // Remove invalid emails
  }

  /**
   * Validate connection to Eventbrite API
   * @param {Object} credentials - { apiKey }
   * @returns {Boolean} True if connection is valid
   */
  async validateConnection(credentials) {
    try {
      if (!credentials || !credentials.apiKey) {
        return false;
      }

      const response = await fetch(`${this.endpoint}/users/me/`, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${credentials.apiKey}`,
          "Content-Type": "application/json",
        },
      });

      return response.ok;
    } catch (err) {
      console.error("[EventbriteAdapter] Validation error:", err.message);
      return false;
    }
  }

  /**
   * Get adapter info
   * @returns {Object} Adapter details
   */
  getInfo() {
    return {
      name: "Eventbrite Events",
      provider: "eventbrite",
      version: "1.0.0",
      capabilities: ["sync_attendees", "map_profiles", "prevent_duplicates"],
      status: "active",
      description: "Sync attendees from Eventbrite events as contacts",
    };
  }
}

module.exports = EventbriteAdapter;

const axios = require("axios");
const dns = require("node:dns").promises;
const net = require("node:net");
const BusinessIndexRecord = require("../models/BusinessIndexRecord");

const PRIVATE_IPV4 = /^(10\.|127\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/;

function sourceStatus() {
  const endpoint = String(process.env.ELLIE_BUSINESS_DATA_API_URL || "").trim();
  return {
    id: "ellie_business_data",
    name: "Lead Porch-owned Business Index",
    configured: true,
    mode: endpoint ? "owned_index_plus_feed" : "owned_index",
    supports: ["organization_search", "evidence", "pagination", "sacramento_open_data_pilot"],
    message: endpoint
      ? "Lead Porch will search its owned index and the configured licensed feed."
      : "Lead Porch will search its owned index, with a live OpenStreetMap pilot for Sacramento-area business searches. No external API URL or key is required.",
  };
}

function safeRegex(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function searchOwnedIndex({ plan, cursor = null, limit = 100 }) {
  const criteria = plan?.criteria || {};
  const locations = (criteria.locations || []).filter(Boolean);
  const industries = (criteria.industries || []).filter(Boolean);
  const keywords = (criteria.keywords || []).filter(Boolean);
  const clauses = [];
  if (locations.length) clauses.push({ $or: locations.flatMap((value) => {
    const pattern = new RegExp(safeRegex(value), "i");
    return [{ location: pattern }, { city: pattern }, { state: pattern }];
  }) });
  if (industries.length) clauses.push({ industry: { $in: industries.map((value) => new RegExp(safeRegex(value), "i")) } });
  if (keywords.length) clauses.push({ $or: [
    { name: { $in: keywords.map((value) => new RegExp(safeRegex(value), "i")) } },
    { description: { $in: keywords.map((value) => new RegExp(safeRegex(value), "i")) } },
    { keywords: { $in: keywords.map((value) => new RegExp(safeRegex(value), "i")) } },
  ] });
  const query = clauses.length ? { $and: clauses } : {};
  if (cursor) query._id = { $gt: cursor };
  const rows = await BusinessIndexRecord.find(query).sort({ _id: 1 }).limit(Math.min(500, Math.max(1, limit))).lean();
  return {
    success: true,
    results: rows.map((row) => normalizeResult({
      ...row,
      id: row.sourceRecordId,
      evidence: [{ sourceType: row.sourceDataset, sourceUrl: row.sourceUrl, field: "organization", observedValue: row.name, observedAt: row.observedAt }],
    }, "ellie_owned_index")),
    cursor: rows.length === Math.min(500, Math.max(1, limit)) ? String(rows.at(-1)._id) : null,
    total: rows.length,
  };
}

function websiteDomain(website) {
  try { return new URL(/^https?:\/\//i.test(website) ? website : `https://${website}`).hostname.replace(/^www\./, ""); }
  catch (_error) { return ""; }
}

async function searchSacramentoOpenData({ plan, limit = 100 }) {
  const locations = (plan?.criteria?.locations || []).join(" ").toLowerCase();
  if (!locations.includes("sacramento")) return { success: true, results: [], cursor: null, total: 0 };
  const bbox = "38.437,-121.560,38.685,-121.362";
  const query = `[out:json][timeout:25];(nwr["name"]["shop"](${bbox});nwr["name"]["office"](${bbox});nwr["name"]["amenity"](${bbox});nwr["name"]["tourism"](${bbox});nwr["name"]["craft"](${bbox}););out center ${Math.min(500, Math.max(25, limit * 3))};`;
  const response = await axios.post("https://overpass-api.de/api/interpreter", new URLSearchParams({ data: query }).toString(), {
    timeout: 30000,
    maxContentLength: 8 * 1024 * 1024,
    headers: { "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8", "User-Agent": "LeadPorch/1.0 (business-research; support@elliescoaching.com)" },
  });
  const keywords = [...(plan?.criteria?.keywords || []), ...(plan?.criteria?.industries || [])].map((value) => String(value).toLowerCase()).filter(Boolean);
  const mapped = (response.data?.elements || []).map((element) => {
    const tags = element.tags || {};
    const category = tags.shop || tags.office || tags.amenity || tags.tourism || tags.craft || "business";
    const searchable = [tags.name, category, tags.description, tags.cuisine].filter(Boolean).join(" ").toLowerCase();
    if (keywords.length && !keywords.some((keyword) => searchable.includes(keyword) || keyword.includes(String(category).replace(/_/g, " ")))) return null;
    const website = tags.website || tags["contact:website"] || "";
    const street = [tags["addr:housenumber"], tags["addr:street"]].filter(Boolean).join(" ");
    const city = tags["addr:city"] || "Sacramento";
    return normalizeResult({
      id: `${element.type}/${element.id}`,
      name: tags.name,
      website,
      domain: websiteDomain(website),
      industry: String(category).replace(/_/g, " "),
      description: tags.description || "",
      location: [street, city, tags["addr:state"] || "CA"].filter(Boolean).join(", "),
      phone: tags.phone || tags["contact:phone"] || "",
      evidence: [{ sourceType: "openstreetmap", sourceUrl: `https://www.openstreetmap.org/${element.type}/${element.id}`, field: "organization", observedValue: tags.name, observedAt: new Date() }],
    }, "openstreetmap_sacramento");
  }).filter(Boolean).slice(0, limit);
  return { success: true, results: mapped, cursor: null, total: mapped.length, attribution: "© OpenStreetMap contributors, ODbL" };
}

async function validateEndpoint(rawUrl) {
  const url = new URL(rawUrl);
  if (url.protocol !== "https:") throw new Error("The business-data endpoint must use HTTPS.");
  const addresses = await dns.lookup(url.hostname, { all: true });
  if (!addresses.length) throw new Error("The business-data endpoint could not be resolved.");
  for (const { address } of addresses) {
    if ((net.isIPv4(address) && PRIVATE_IPV4.test(address)) || address === "::1" || address.startsWith("fc") || address.startsWith("fd") || address.startsWith("fe80")) {
      throw new Error("Private-network business-data endpoints are not allowed.");
    }
  }
  return url.toString();
}

function normalizeResult(item = {}, sourceId) {
  const evidence = Array.isArray(item.evidence) ? item.evidence : [];
  const people = Array.isArray(item.people) ? item.people : [];
  return {
    name: String(item.name || "").trim(),
    domain: String(item.domain || "").trim().toLowerCase().replace(/^https?:\/\/(www\.)?/, "").split("/")[0],
    website: String(item.website || "").trim(),
    industry: String(item.industry || "").trim(),
    description: String(item.description || "").trim(),
    employeeCount: Number(item.employeeCount) || null,
    location: String(item.location || "").trim(),
    phone: String(item.phone || "").trim(),
    locationCount: Number(item.locationCount) || null,
    rating: Number(item.rating) || null,
    reviewCount: Number(item.reviewCount) || null,
    keywords: Array.isArray(item.keywords) ? item.keywords.map(String) : [],
    sourceId,
    providerId: String(item.id || item.providerId || "").trim(),
    evidence: evidence.map((entry) => ({
      sourceType: String(entry.sourceType || sourceId),
      sourceUrl: String(entry.sourceUrl || entry.url || ""),
      field: String(entry.field || "organization"),
      observedValue: String(entry.observedValue || entry.value || ""),
      observedAt: entry.observedAt ? new Date(entry.observedAt) : new Date(),
    })).filter((entry) => entry.sourceUrl),
    decisionMakers: people.map((person) => ({
      name: String(person.name || "").trim(),
      title: String(person.title || "").trim(),
      linkedinUrl: String(person.linkedinUrl || "").trim(),
      email: String(person.email || "").trim().toLowerCase(),
      emailStatus: person.email ? "published_unverified" : "unknown",
      evidenceUrl: String(person.evidenceUrl || person.sourceUrl || "").trim(),
      observedAt: person.observedAt ? new Date(person.observedAt) : new Date(),
    })).filter((person) => person.name && person.evidenceUrl),
  };
}

async function searchBusinessFeed({ plan, cursor = null, limit = 100 }) {
  const status = sourceStatus();
  const owned = await searchOwnedIndex({ plan, cursor, limit });
  if (owned.results.length) return owned;
  if (!cursor) {
    const sacramentoPilot = await searchSacramentoOpenData({ plan, limit });
    if (sacramentoPilot.results.length || !process.env.ELLIE_BUSINESS_DATA_API_URL?.trim()) return sacramentoPilot;
  }
  if (!process.env.ELLIE_BUSINESS_DATA_API_URL?.trim()) return owned;
  const endpoint = await validateEndpoint(process.env.ELLIE_BUSINESS_DATA_API_URL.trim());
  const response = await axios.post(endpoint, { plan, cursor, limit: Math.min(500, Math.max(1, limit)) }, {
    timeout: 30000,
    maxContentLength: 10 * 1024 * 1024,
    headers: {
      "Content-Type": "application/json",
      "User-Agent": "LeadPorch/1.0 market-research",
      ...(process.env.ELLIE_BUSINESS_DATA_API_KEY?.trim() ? { Authorization: `Bearer ${process.env.ELLIE_BUSINESS_DATA_API_KEY.trim()}` } : {}),
    },
  });
  const items = Array.isArray(response.data?.results) ? response.data.results : [];
  return {
    success: true,
    results: items.map((item) => normalizeResult(item, status.id)).filter((item) => item.name && (item.domain || item.providerId)),
    cursor: response.data?.nextCursor || null,
    total: Number(response.data?.total) || items.length,
  };
}

module.exports = { normalizeResult, searchBusinessFeed, searchOwnedIndex, searchSacramentoOpenData, sourceStatus, validateEndpoint };

const OpenAI = require("openai");
const { fetchPublicPage } = require("./publicWebsiteResearchService");
const { recordOpenAiUsage } = require("./aiUsageTracker");

function client() {
  const apiKey = String(process.env.OPENAI_API_KEY || "").trim();
  if (!apiKey) throw new Error("Business-card image reading is not configured.");
  return new OpenAI({ apiKey });
}

const clean = (value) => String(value || "").trim();

const aliases = {
  firstName: ["firstName", "first_name", "givenName"],
  lastName: ["lastName", "last_name", "familyName", "surname"],
  email: ["email", "emailAddress"], phone: ["phone", "phoneNumber", "telephone"],
  company: ["company", "companyName", "organization"],
  title: ["title", "jobTitle", "position"],
  linkedin: ["linkedin", "linkedIn", "linkedinUrl", "linkedInUrl"],
  website: ["website", "websiteUrl", "url"], city: ["city"], state: ["state", "region"],
  country: ["country"], notes: ["notes", "other"],
};

function normalizeContact(parsed = {}) {
  const contact = Object.fromEntries(Object.entries(aliases).map(([field, keys]) => [
    field,
    clean(keys.map((key) => parsed[key]).find((value) => clean(value))),
  ]));
  if (!contact.firstName && !contact.lastName && clean(parsed.name)) {
    const parts = clean(parsed.name).split(/\s+/);
    contact.firstName = parts.shift() || "";
    contact.lastName = parts.join(" ");
  }
  return contact;
}

async function extractBusinessCard(imageDataUrl, { workspaceId, userId } = {}) {
  const image = String(imageDataUrl || "");
  if (!/^data:image\/(?:png|jpeg|jpg|webp);base64,/i.test(image)) {
    throw new Error("Upload a PNG, JPEG, or WebP business-card image.");
  }
  if (image.length > 10 * 1024 * 1024) throw new Error("The business-card image is too large.");
  const model = process.env.BUSINESS_CARD_OPENAI_MODEL || process.env.JARVIS_OPENAI_MODEL || "gpt-4.1-mini";
  const started = Date.now();
  let response;
  try {
    response = await client().chat.completions.create({
      model,
      response_format: { type: "json_object" },
      messages: [{
        role: "user",
        content: [
          {
            type: "text",
            text: "Read this business card. Return JSON with only these string fields: firstName, lastName, email, phone, company, title, linkedin, website, city, state, country, notes. Copy only information visibly printed or encoded on the card. Do not guess missing fields. Put secondary phone numbers, addresses, certifications, social handles, and other useful printed details that do not fit a field into notes.",
          },
          { type: "image_url", image_url: { url: image, detail: "high" } },
        ],
      }],
    });
  } catch (error) {
    await recordOpenAiUsage({ workspaceId, userId, agent: "sales", feature: "business_card_extraction", model, error, latencyMs: Date.now() - started });
    throw error;
  }
  await recordOpenAiUsage({ workspaceId, userId, agent: "sales", feature: "business_card_extraction", model, response, latencyMs: Date.now() - started });
  const parsed = JSON.parse(response.choices?.[0]?.message?.content || "{}");
  return normalizeContact(parsed);
}

async function extractDigitalBusinessCard(rawUrl) {
  const url = new URL(String(rawUrl || "").trim());
  if (!/(^|\.)blinq\.me$/i.test(url.hostname)) throw new Error("Only public Blinq card links are supported by this resolver.");
  const page = await fetchPublicPage(url.toString());
  if (page.blocked) throw new Error("Blinq did not allow this public card to be read.");
  const contact = parseBlinqHtml(page.html);
  contact.notes = [contact.notes, `Digital business card: ${page.url}`].filter(Boolean).join("\n");
  return contact;
}

function parseBlinqHtml(html) {
  const decoded = String(html || "")
    .replace(/\\u([0-9a-f]{4})/gi, (_match, code) => String.fromCharCode(parseInt(code, 16)))
    .replace(/\\"/g, '"');
  const stringField = (key) => {
    const match = decoded.match(new RegExp(`"${key}"\\s*:\\s*"((?:\\\\.|[^"\\\\])*)"`, "i"));
    if (!match || match[1] === "$undefined") return "";
    return clean(match[1].replace(/\\n/g, " ").replace(/\\"/g, '"').replace(/\\\\/g, "\\"));
  };
  const arrayValue = (key) => {
    const start = decoded.search(new RegExp(`"${key}"\\s*:\\s*\\[`, "i"));
    if (start < 0) return "";
    return decoded.slice(start, start + 5000).match(/"value"\s*:\s*"((?:\\.|[^"\\])*)"/i)?.[1] || "";
  };
  const cardStart = decoded.indexOf('"card":{');
  const cardData = cardStart >= 0 ? decoded.slice(cardStart, cardStart + 30000) : decoded;
  const urlsStart = cardData.search(/"urls"\s*:\s*\[/i);
  const urlsData = urlsStart >= 0 ? cardData.slice(urlsStart, urlsStart + 8000) : "";
  const urls = [...urlsData.matchAll(/https?:\/\/[^"\\\s]+/gi)].map((match) => match[0]);
  const linkedin = urls.find((value) => /linkedin\.com/i.test(value)) || "";
  const website = urls.find((value) => !/linkedin\.com|blinq\.me|googleapis\.com/i.test(value)) || "";
  return normalizeContact({
    firstName: stringField("firstName"), lastName: stringField("lastName"),
    email: clean(arrayValue("emails")), phone: clean(arrayValue("phoneNumbers")),
    company: stringField("orgName"), title: stringField("jobTitle"), linkedin, website,
    city: stringField("city"), state: stringField("state"), country: stringField("country"),
  });
}

module.exports = { extractBusinessCard, extractDigitalBusinessCard, normalizeContact, parseBlinqHtml };

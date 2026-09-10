const PlatformConfig = require("../models/PlatformConfig");

const defaults = () => ({ providerAvailability: { gemini: true, vertex: true } });

async function get(Model = PlatformConfig) {
  const row = await Model.findOne({ key: "singleton" }).lean();
  return { ...defaults(), providerAvailability: { ...defaults().providerAvailability, ...(row?.providerAvailability || {}) } };
}

async function save(input = {}, userId = null, Model = PlatformConfig) {
  const current = await get(Model);
  const providerAvailability = {
    gemini: input.providerAvailability?.gemini === undefined ? current.providerAvailability.gemini : Boolean(input.providerAvailability.gemini),
    vertex: input.providerAvailability?.vertex === undefined ? current.providerAvailability.vertex : Boolean(input.providerAvailability.vertex),
  };
  const row = await Model.findOneAndUpdate(
    { key: "singleton" },
    { $set: { providerAvailability, updatedByUserId: userId }, $setOnInsert: { key: "singleton" } },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );
  return { providerAvailability: row.providerAvailability?.toObject ? row.providerAvailability.toObject() : row.providerAvailability };
}

/** True only when both the platform-wide switch AND the server env flags allow it. */
async function geminiPlatformAvailable(Model = PlatformConfig) {
  const config = await get(Model);
  return config.providerAvailability.gemini !== false;
}

/** True only when both the platform-wide switch AND the server env flags allow it. */
async function vertexPlatformAvailable(Model = PlatformConfig) {
  const config = await get(Model);
  return config.providerAvailability.vertex !== false;
}

module.exports = { defaults, get, save, geminiPlatformAvailable, vertexPlatformAvailable };

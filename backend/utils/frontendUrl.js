function primaryFrontendUrl(value = process.env.FRONTEND_URL) {
  const frontend = String(value || "http://localhost:5173")
    .split(",")
    .map((entry) => entry.trim())
    .find(Boolean);
  return (frontend || "http://localhost:5173").replace(/\/+$/, "");
}

module.exports = { primaryFrontendUrl };

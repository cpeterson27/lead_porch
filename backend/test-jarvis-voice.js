#!/usr/bin/env node
/**
 * Jarvis Voice Interface Tests
 * Test audio transcription and voice query processing
 */

const mongoose = require("mongoose");
require("dotenv").config();

function withGet(req) {
  return { get: () => "", ...req };
}

function fakeRes() {
  const res = { statusCode: 200, body: null };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (data) => { res.body = data; return res; };
  return res;
}

// jarvis.js applies requireCapability("jarvis.manage") via router.use() ahead
// of every route, not inline per-route, so the walker must also run
// router-level middleware layers (those with no `.route`), not just the
// matched route's own handler stack.
async function runRoute(router, path, method, rawReq) {
  const req = withGet(rawReq);
  const res = fakeRes();
  for (const layer of router.stack) {
    const handlers = layer.route ? (layer.route.path === path && layer.route.methods[method] ? layer.route.stack : null) : [layer];
    if (!handlers) continue;
    let stopped = false;
    for (const routeLayer of handlers) {
      let calledNext = false, nextError = null;
      await routeLayer.handle(req, res, (error) => { calledNext = true; nextError = error; });
      if (nextError) throw nextError;
      if (!calledNext) { stopped = true; break; }
    }
    if (stopped || layer.route) break;
  }
  return res;
}

const authorizedAuth = { workspaceId: new mongoose.Types.ObjectId().toString(), user: { _id: "voice-test-user" }, effectivePermissions: ["jarvis.manage"] };

async function runTests() {
  try {
    console.log("════════════════════════════════════════════════");
    console.log("Jarvis Voice Interface Tests");
    console.log("════════════════════════════════════════════════\n");

    console.log("═══ SETUP: Database Connection ═══\n");
    await mongoose.connect(process.env.MONGO_URI);
    console.log("✓ Connected to MongoDB\n");

    const router = require("./routes/jarvis");

    await testSpeechService();
    await testVoiceEndpointBasic(router);
    await testVoiceEndpointWithTrascript(router);
    await testVoiceEndpointActionFlow(router);
    await testVoiceEndpointErrorHandling(router);
    await testVoiceEndpointCapabilityGate(router);

    console.log("\n════════════════════════════════════════════════");
    console.log("Test Summary");
    console.log("════════════════════════════════════════════════");
    console.log("✓ Passed: 11");
    console.log("✗ Failed: 0");
    console.log("Total: 11");
    console.log("\n🎉 ALL VOICE INTERFACE TESTS PASSED!");

    await mongoose.disconnect();
    process.exit(0);
  } catch (error) {
    console.error("\n❌ TEST FAILED:", error.message);
    await mongoose.disconnect().catch(() => {});
    process.exit(1);
  }
}

async function testSpeechService() {
  console.log("═══ PHASE 1: Speech Service ═══\n");

  const speechService = require("./services/speechService");

  // Test 1: Service info
  const info = speechService.getInfo();
  if (!info || info.service !== "SpeechService") {
    throw new Error("Speech service info not available");
  }
  console.log("✓ Test 1: Speech service initialized");

  // Test 2: Get provider
  const provider = speechService.getProvider();
  if (provider !== "mock") {
    throw new Error(`Expected mock provider, got ${provider}`);
  }
  console.log("✓ Test 2: Mock provider is default");

  // Test 3: Transcribe audio (mock)
  const mockAudio = Buffer.from("mock-audio-data");
  const transcript = await speechService.transcribeAudio(mockAudio);
  if (!transcript || typeof transcript !== "string") {
    throw new Error("Transcription should return a string");
  }
  console.log(
    `✓ Test 3: Mock transcription works - "${transcript.substring(0, 40)}..."`,
  );

  // Test 4: Set provider
  speechService.setProvider("mock"); // Verify it accepts mock
  console.log("✓ Test 4: Provider setter works\n");
}

async function testVoiceEndpointBasic(router) {
  console.log("═══ PHASE 2: Voice Endpoint - Basic ═══\n");

  const mockAudio = Buffer.from("mock-audio-data").toString("base64");
  const res = await runRoute(router, "/voice", "post", { auth: authorizedAuth, body: { audio: mockAudio } });

  if (res.statusCode !== 200) {
    throw new Error(`Voice endpoint returned ${res.statusCode}`);
  }

  const result = res.body;
  if (!result.success || !result.data) {
    throw new Error("Voice endpoint response missing success or data");
  }
  console.log("✓ Test 5: POST /jarvis/voice returns 200");

  if (!result.data.transcript || typeof result.data.transcript !== "string") {
    throw new Error("Response should include transcript string");
  }
  console.log(
    `✓ Test 6: Response includes transcript - "${result.data.transcript.substring(0, 40)}..."`,
  );

  if (!result.data.response) {
    throw new Error("Response should include Jarvis response");
  }
  console.log("✓ Test 7: Response includes Jarvis response\n");
}

async function testVoiceEndpointWithTrascript(router) {
  console.log("═══ PHASE 3: Voice Endpoint - Transcript Handling ═══\n");

  const mockAudio = Buffer.from("mock-audio-data").toString("base64");
  const res = await runRoute(router, "/voice", "post", { auth: authorizedAuth, body: { audio: mockAudio } });

  const transcript = res.body.data.transcript;
  const jarvisResponse = res.body.data.response;

  if (!transcript || transcript.trim().length === 0) {
    throw new Error("Transcript should not be empty");
  }
  console.log(`✓ Test 8: Transcript is non-empty`);

  if (!jarvisResponse.answer || typeof jarvisResponse.answer !== "string") {
    throw new Error("Jarvis response should include answer");
  }
  console.log(`✓ Test 9: Jarvis response contains answer\n`);
}

async function testVoiceEndpointActionFlow(router) {
  console.log("═══ PHASE 4: Voice Endpoint - Action Flow ═══\n");

  const mockAudio = Buffer.from("mock-audio-data").toString("base64");
  const res = await runRoute(router, "/voice", "post", { auth: authorizedAuth, body: { audio: mockAudio } });

  const jarvisResponse = res.body.data.response;
  if (!jarvisResponse.data || !jarvisResponse.actionsAvailable) {
    throw new Error("Response should have data and actionsAvailable");
  }
  console.log("✓ Test 10: Voice response includes data and actions\n");
}

async function testVoiceEndpointErrorHandling(router) {
  console.log("═══ PHASE 5: Voice Endpoint - Error Handling ═══\n");

  // Test 1: Missing audio
  const res1 = await runRoute(router, "/voice", "post", { auth: authorizedAuth, body: {} });
  if (res1.statusCode !== 400) {
    throw new Error("Should return 400 when audio is missing");
  }
  if (!res1.body.error || !res1.body.error.includes("Audio")) {
    throw new Error("Error message should mention audio");
  }
  console.log("✓ Error handling: Missing audio returns 400");

  // Test 2: Handled gracefully (not 500)
  const mockAudio = Buffer.from("mock-audio-data").toString("base64");
  const res2 = await runRoute(router, "/voice", "post", { auth: authorizedAuth, body: { audio: mockAudio } });
  if (res2.statusCode >= 500) {
    throw new Error("Voice endpoint should not return 500");
  }
  console.log("✓ Error handling: Valid requests handled without 500\n");
}

async function testVoiceEndpointCapabilityGate(router) {
  console.log("═══ PHASE 6: Voice Endpoint - Capability Gate ═══\n");

  const mockAudio = Buffer.from("mock-audio-data").toString("base64");
  const res = await runRoute(router, "/voice", "post", {
    auth: { workspaceId: authorizedAuth.workspaceId, user: { _id: "no-permission-user" }, effectivePermissions: [] },
    body: { audio: mockAudio },
  });
  if (res.statusCode !== 403) {
    throw new Error(`Expected 403 without jarvis.manage capability, got ${res.statusCode}`);
  }
  console.log("✓ Capability gate: requires jarvis.manage\n");
}

runTests();

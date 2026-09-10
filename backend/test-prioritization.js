require("dotenv").config();
const mongoose = require("mongoose");
const Organization = require("./models/Organization");
const Audience = require("./models/Audience");
const { calculatePriorityScore } = require("./services/organizationPriority");
const { connectDatabase } = require("./config/database");

async function runTests() {
  console.log(
    "═════════════════════════════════════════════════════════════════",
  );
  console.log(
    "ORGANIZATION PRIORITIZATION - PHASE 3 TESTING",
  );
  console.log(
    "═════════════════════════════════════════════════════════════════\n",
  );

  try {
    // Connect to database
    const mongoUri =
      process.env.MONGO_URI || "mongodb://localhost:27017/ellie";
    await connectDatabase(mongoUri);
    console.log("✓ Connected to MongoDB\n");

    // Step 1: Get an existing Audience
    console.log("Step 1: Loading test Audience...\n");
    const audience = await Audience.findOne().lean();
    if (!audience) {
      console.log("❌ No audiences found. Creating test audience...");
      const newAudience = await Audience.create({
        name: "Priority Test Audience",
        description: "Testing prioritization",
        status: "active",
        source: "manual",
        criteria: {
          keywords: ["multifamily", "apartment", "syndication"],
          industries: ["real estate", "real estate investment trust"],
          locations: [],
          employeeRange: {
            min: 5,
            max: 500,
          },
          minimumScore: 50,
          targetTier: "medium",
        },
      });
      console.log(`✓ Created test audience: ${newAudience.name}\n`);
    } else {
      console.log(`✓ Found audience: ${audience.name}\n`);
    }

    // Use the audience we found or just created
    const testAudience = audience || (await Audience.findOne());

    // Step 2: Get Organizations
    console.log("Step 2: Loading Organizations...\n");
    const organizations = await Organization.find().limit(5).lean();
    if (organizations.length === 0) {
      console.log("❌ No organizations found in database. Exiting.\n");
      process.exit(1);
    }
    console.log(`✓ Found ${organizations.length} organizations\n`);

    // Step 3: Calculate priority for each organization
    console.log(
      "═════════════════════════════════════════════════════════════════",
    );
    console.log("Step 3: Priority Calculations");
    console.log(
      "═════════════════════════════════════════════════════════════════\n",
    );

    const results = [];
    let testsPassed = 0;
    let testsFailed = 0;

    for (let i = 0; i < organizations.length; i++) {
      const org = organizations[i];
      console.log(`\n--- Organization ${i + 1}: ${org.name} ---\n`);

      try {
        const priority = calculatePriorityScore(org, testAudience);

        console.log(`Audience Score: ${org.audienceScore}/100`);
        console.log(`Priority Score: ${priority.score}/100`);
        console.log(`Priority Tier: ${priority.tier.toUpperCase()}`);
        console.log(`\nSignal Breakdown:`);
        console.log(
          `  • Audience Fit:      ${priority.signals.audienceFit}/40 points`,
        );
        console.log(
          `  • Industry Match:    ${priority.signals.industryMatch}/15 points`,
        );
        console.log(
          `  • Company Size:      ${priority.signals.companySize}/15 points`,
        );
        console.log(
          `  • Keyword Match:     ${priority.signals.keywordMatch}/10 points`,
        );
        console.log(
          `  • Data Quality:      ${priority.signals.dataQuality}/10 points`,
        );
        console.log(
          `  • Recency:           ${priority.signals.recency}/10 points`,
        );
        console.log(
          `  ─────────────────────────────────────────────`,
        );
        console.log(
          `  TOTAL:               ${priority.score}/100 points`,
        );

        console.log(`\nPriority Reasons:`);
        if (priority.reasons.length > 0) {
          priority.reasons.forEach((reason) => {
            console.log(`  • ${reason}`);
          });
        } else {
          console.log("  (No priority reasons generated)");
        }

        // Verify calculations
        const verifications = [];

        // Check score is in valid range
        if (priority.score >= 0 && priority.score <= 100) {
          verifications.push("✅ Score in range [0-100]");
        } else {
          verifications.push("❌ Score outside range");
        }

        // Check signals sum to total
        const signalSum =
          priority.signals.audienceFit +
          priority.signals.industryMatch +
          priority.signals.companySize +
          priority.signals.keywordMatch +
          priority.signals.dataQuality +
          priority.signals.recency;
        if (signalSum === priority.score) {
          verifications.push("✅ Signals sum correctly to total");
        } else {
          verifications.push(
            `❌ Signal sum (${signalSum}) ≠ total (${priority.score})`,
          );
        }

        // Check tier matches score
        const expectedTier =
          priority.score >= 80 ? "hot" : priority.score >= 50 ? "warm" : "cold";
        if (priority.tier === expectedTier) {
          verifications.push(`✅ Tier "${priority.tier}" matches score`);
        } else {
          verifications.push(
            `❌ Tier mismatch: got "${priority.tier}", expected "${expectedTier}"`,
          );
        }

        // Check signals are within max values
        const signalMaxes = {
          audienceFit: 40,
          industryMatch: 15,
          companySize: 15,
          keywordMatch: 10,
          dataQuality: 10,
          recency: 10,
        };
        let signalsValid = true;
        Object.entries(signalMaxes).forEach(([signal, max]) => {
          if (priority.signals[signal] < 0 || priority.signals[signal] > max) {
            signalsValid = false;
          }
        });
        if (signalsValid) {
          verifications.push("✅ All signal values within max limits");
        } else {
          verifications.push("❌ Some signals exceed max limits");
        }

        // Check reasons generated
        if (priority.reasons.length > 0) {
          verifications.push(
            `✅ Reasons generated (${priority.reasons.length} reasons)`,
          );
        } else {
          verifications.push("❌ No reasons generated");
        }

        console.log(`\nVerifications:`);
        verifications.forEach((v) => console.log(`  ${v}`));

        // Count test pass/fail
        const failed = verifications.filter((v) => v.startsWith("❌"));
        if (failed.length === 0) {
          console.log("\n✅ ORGANIZATION TEST PASSED\n");
          testsPassed += 1;
          results.push({
            org: org.name,
            score: priority.score,
            tier: priority.tier,
            passed: true,
          });
        } else {
          console.log(`\n❌ ORGANIZATION TEST FAILED (${failed.length} issues)\n`);
          testsFailed += 1;
          results.push({
            org: org.name,
            score: priority.score,
            tier: priority.tier,
            passed: false,
          });
        }
      } catch (error) {
        console.log(`❌ ERROR: ${error.message}\n`);
        testsFailed += 1;
        results.push({
          org: org.name,
          passed: false,
          error: error.message,
        });
      }
    }

    // Summary
    console.log(
      "═════════════════════════════════════════════════════════════════",
    );
    console.log("TEST SUMMARY");
    console.log(
      "═════════════════════════════════════════════════════════════════\n",
    );

    results.forEach((result) => {
      const status = result.passed ? "✅ PASS" : "❌ FAIL";
      const score = result.score !== undefined ? ` (${result.score}/100)` : "";
      console.log(`${status} ${result.org}${score}`);
    });

    console.log(
      `\n✅ ${testsPassed} organizations passed prioritization`
    );
    console.log(`❌ ${testsFailed} organizations failed\n`);

    if (testsFailed === 0) {
      console.log("🎉 ALL TESTS PASSED!\n");
    } else {
      console.log(
        `⚠️  ${testsFailed} tests failed. Check results above.\n`,
      );
    }

    process.exit(testsFailed > 0 ? 1 : 0);
  } catch (error) {
    console.error("Test error:", error);
    process.exit(1);
  }
}

runTests();

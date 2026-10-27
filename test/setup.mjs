// Loaded before every test file (npm test): the tests must not depend on how much memory the PC has right now.
// The memory guard has its own tests (processes.test.mjs), which pass their own limits.
process.env.AUTOMATA_MIN_FREE_MB = "0";
process.env.AUTOMATA_MIN_COMMIT_MB = "0";

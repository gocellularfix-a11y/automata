// Loaded before every test file (npm test): the tests must not depend on how much memory the PC has right now,
// nor read what its processes use. The memory guard and the budget have their own tests (processes.test.mjs,
// memory-budget.test.mjs), which pass their own limits and readings.
process.env.AUTOMATA_MIN_FREE_MB = "0";
process.env.AUTOMATA_MIN_COMMIT_MB = "0";
process.env.AUTOMATA_RAM_BUDGET_MB = "0";
// Looking at the PC's tools (environment.mjs) never runs a program during the tests.
process.env.AUTOMATA_ENV_PROBE = "0";

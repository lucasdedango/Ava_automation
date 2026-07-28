const assert = require("node:assert/strict");
const fs = require("node:fs");
const test = require("node:test");

const source = fs.readFileSync("script.js", "utf8");

test("fridge discovery uses the confirmed model type and server cooldown", () => {
    assert.match(source, /FRIDGE_COOLDOWN_SECONDS\s*=\s*3\s*\*\s*60\s*\*\s*60/);
    assert.match(source, /typeId\s*!==\s*"refrigerator3"/);
    assert.match(source, /lastProductionTime/);
    assert.match(source, /seenIds\.has\(String\(objectId\)\)/);
});

test("fridge actions use RoomActionNetManager signatures and expose helpers", () => {
    assert.match(source, /manager\.startAction\(\s*row\.objectId,\s*"use",\s*HOME_OWNER_ID,\s*null/s);
    assert.match(source, /manager\.finishAction\(\s*row\.objectId,\s*"use",\s*HOME_OWNER_ID,/s);
    assert.match(source, /w\.__AVA_LIST_FRIDGES__/);
    assert.match(source, /w\.__AVA_EAT_FROM_FRIDGE__/);
    assert.match(source, /w\.__AVA_EAT_AVAILABLE__/);
});

test("low energy recovery is guarded and preserves interrupted work", () => {
    assert.match(source, /energyRecoveryInProgress:\s*false/);
    assert.match(source, /phase\s*=\s*"energy-recovery"/);
    assert.match(source, /prepareForEnergyRecovery\(\)/);
    assert.match(source, /resumeAfterEnergyRecovery\(state\.savedWork\)/);
    assert.match(source, /pauseReason\s*=\s*"insufficient-ready-fridges"/);
});

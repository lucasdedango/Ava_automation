const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');

const source = fs.readFileSync('script.js', 'utf8');

test('fridge readiness uses refrigerator3 and server lastProductionTime', () => {
    assert.match(source, /const FRIDGE_COOLDOWN_SECONDS = 3 \* 60 \* 60/);
    assert.match(source, /shopItem\?\.typeId \?\? ""\) !== "refrigerator3"/);
    assert.match(source, /Number\(model\.lastProductionTime \?\? 0\)/);
    assert.match(source, /remainingSeconds === 0/);
});

test('fridge use follows start then finish room action flow', () => {
    const implementation = source.match(
        /async function eatFromFridge\(objectId\) \{[\s\S]*?\n    \}\r?\n\r?\n    async function eatAvailable/
    )?.[0] ?? '';
    assert.match(implementation, /manager\.startAction\(/);
    assert.match(implementation, /"use"/);
    assert.match(implementation, /await waitForHouseState/);
    assert.match(implementation, /manager\.finishAction\(/);
    assert.ok(
        implementation.indexOf('manager.startAction') <
        implementation.indexOf('manager.finishAction')
    );
});

test('energy recovery goes home, eats twice, and returns through work teleport', () => {
    const implementation = source.match(
        /async function startEnergyRecovery\(cleaner, energy = null, restoredState = null\) \{[\s\S]*?\n    \}\r?\n\r?\n    \/\*/
    )?.[0] ?? '';
    assert.match(implementation, /goHouse\(HOME_OWNER_ID, HOME_ROOM_ID\)/);
    assert.match(implementation, /loadedFridges = findFridgesInCurrentRoom\(\)/);
    assert.match(implementation, /houseContentReady/);
    assert.match(implementation, /homeResult\.roomSwitched !== true/);
    assert.match(implementation, /await eatAvailable\(remainingCount\)/);
    assert.match(implementation, /w\.__AVA_GO_WORK__\(savedWork\.currentMap\)/);
    assert.match(implementation, /insufficient-ready-fridges/);
    assert.match(source, /__AVA_EAT_AVAILABLE__/);
});

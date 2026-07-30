const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');

const source = fs.readFileSync('script.js', 'utf8');

test('house teleport uses native HouseLocation and waits before room switching', () => {
    const implementation = source.match(
        /async function goHouse\(ownerId, roomId = null\) \{[\s\S]*?\n    \}\r?\n\r?\n    function getDestinationRegistry/
    )?.[0] ?? '';

    assert.match(implementation, /new HouseLocation\(ownerId, null\)/);
    assert.match(implementation, /Context\.currentLocation = location/);
    assert.match(implementation, /await waitForHouseState/);
    assert.match(implementation, /activeLocation\.switchRoom\(roomId\)/);
    assert.ok(
        implementation.indexOf('await waitForHouseState') <
        implementation.indexOf('activeLocation.switchRoom(roomId)')
    );
});

test('public house helpers and saved obfuscated fields remain available', () => {
    assert.match(source, /ownerId: location\._gl/);
    assert.match(source, /roomId: location\.Lmc/);
    assert.match(source, /roomKey: location\.qmc/);
    assert.match(source, /w\.__AVA_GO_HOUSE__ = function/);
    assert.match(source, /w\.__AVA_RETURN_HOME__ = async function/);
});

test('room4 readiness accepts loaded refrigerator content when room metadata is null', () => {
    const readiness = source.match(
        /function houseRoomContentIsReady\(ownerId, roomId\) \{[\s\S]*?\n    \}\r?\n\r?\n    async function goHouse/
    )?.[0] ?? '';
    const teleport = source.match(
        /async function goHouse\(ownerId, roomId = null\) \{[\s\S]*?\n    \}\r?\n\r?\n    function fridgeRow/
    )?.[0] ?? '';

    assert.match(readiness, /findFridgesInCurrentRoom\(\)/);
    assert.match(readiness, /fridges\.length > 0/);
    assert.match(readiness, /"room-content"/);
    assert.match(teleport, /houseRoomContentIsReady\(ownerId, roomId\)/);
    assert.match(teleport, /confirmedBy: roomReady\.confirmedBy/);
    assert.match(teleport, /fridgeCount: roomReady\.fridges\.length/);
});

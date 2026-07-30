const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');

const source = fs.readFileSync('script.js', 'utf8');

test('shift countdown parser supports hour and minute formats', () => {
    const pattern = /(?:(\d+):)?(\d{1,2}):(\d{2}) left until the end of this shift/i;
    const withHours = '0:34:20 left until the end of this shift'.match(pattern);
    const withoutHours = '34:20 left until the end of this shift'.match(pattern);

    assert.deepEqual(withHours.slice(1), ['0', '34', '20']);
    assert.deepEqual(withoutHours.slice(1), [undefined, '34', '20']);
    assert.equal(Number(withHours[1]) * 3600 + Number(withHours[2]) * 60 + Number(withHours[3]), 2060);
    assert.equal(Number(withoutHours[1] ?? 0) * 3600 + Number(withoutHours[2]) * 60 + Number(withoutHours[3]), 2060);
});

test('shift readiness adds safety and aligns upward to thirty seconds', () => {
    const detectedAt = 1_000_000;
    const totalSeconds = 2060;
    const rawReadyAt = detectedAt + totalSeconds * 1000;
    const readyAt = Math.ceil((rawReadyAt + 10_000) / 30_000) * 30_000;

    assert.equal(rawReadyAt, 3_060_000);
    assert.equal(readyAt, 3_090_000);
    assert.ok(readyAt >= rawReadyAt + 10_000);
    assert.equal(readyAt % 30_000, 0);
});

test('shift detection traverses both OpenFL roots and all known text fields', () => {
    const implementation = source.match(
        /function findVisibleShiftCountdown\(\) \{[\s\S]*?\n    \}\r?\n\r?\n    function gameLooksPlayable/
    )?.[0] ?? '';
    assert.match(implementation, /workDisplayRoots\(\)/);
    assert.match(implementation, /"text", "__text", "_text", "htmlText", "_htmlText"/);
    assert.match(implementation, /SHIFT_READY_SAFETY_MS/);
    assert.match(implementation, /SHIFT_ALIGNMENT_MS/);
});

test('auto loop uses map availability and preserves fixed delays only as fallback', () => {
    assert.match(source, /source: "display-countdown"/);
    assert.match(source, /source: "fallback-fixed-delay"/);
    assert.match(source, /Math\.min\(garbageReadyAt, gardenReadyAt\)/);
    assert.match(source, /Math\.max\(garbageReadyAt, gardenReadyAt\)/);
    assert.match(source, /mapAvailability: autoLoop\?\.serializableMapAvailability/);
    assert.match(source, /__AVA_FIND_SHIFT_COUNTDOWN__/);
    assert.match(source, /__AVA_SHIFT_STATUS__/);
});

const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync('script.js', 'utf8');

test('userscript parent match is limited to vk.ru', () => {
    assert.match(source, /\/\/ @match\s+https:\/\/vk\.ru\/\*/);
    assert.doesNotMatch(source, /\/\/ @match\s+https:\/\/vk\.com\/\*/);
});

function loadParentContext() {
    const messageListeners = [];
    const intervals = [];
    const timeouts = [];
    let now = 1_000_000;
    let reloads = 0;
    class FakeDate extends Date {
        constructor(value = now) {
            super(value);
        }
        static now() {
            return now;
        }
    }
    const childWindow = {};
    const frame = {
        src: 'https://cdn-sp.tortugasocial.com/avataria-vk/app/index_js.html',
        contentWindow: childWindow
    };
    const page = {
        top: null,
        location: { reload() { reloads++; } },
        addEventListener(type, listener) {
            if (type === 'message') messageListeners.push(listener);
        }
    };
    page.top = page;
    const values = new Map();
    const context = {
        window: page,
        unsafeWindow: page,
        document: { querySelectorAll: () => [frame] },
        console: { log() {}, warn() {}, error() {}, table() {} },
        Date: FakeDate,
        Math,
        Promise,
        URL,
        setTimeout(callback) { timeouts.push(callback); return timeouts.length; },
        setInterval(callback) { intervals.push(callback); return intervals.length; },
        GM_getValue(key, fallback) { return values.has(key) ? values.get(key) : fallback; },
        GM_setValue(key, value) { values.set(key, value); },
        GM_deleteValue(key) { values.delete(key); }
    };
    vm.runInNewContext(source, context, { filename: 'script.js' });
    return {
        page,
        frame,
        childWindow,
        messageListeners,
        intervals,
        timeouts,
        values,
        advance(ms) { now += ms; },
        reloadCount() { return reloads; }
    };
}

test('VK top context installs only the parent watchdog', () => {
    const fixture = loadParentContext();
    assert.equal(typeof fixture.page.__AVA_CRASH_WATCHDOG_STATUS__, 'function');
    assert.equal(fixture.page.__AVA_V11_INSTALLED__, undefined);
    assert.equal(fixture.page.__AVA_MAP_CLEANER__, undefined);
});

test('parent watchdog arms only for a strictly validated heartbeat', () => {
    const fixture = loadParentContext();
    const onMessage = fixture.messageListeners[0];
    onMessage({
        origin: 'https://attacker.invalid',
        source: fixture.childWindow,
        data: { type: 'AVA_HEARTBEAT', version: 1 }
    });
    assert.equal(fixture.page.__AVA_CRASH_WATCHDOG_STATUS__().armed, false);

    onMessage({
        origin: 'https://cdn-sp.tortugasocial.com',
        source: fixture.childWindow,
        data: {
            type: 'AVA_HEARTBEAT',
            version: 1,
            instanceId: 'test-instance',
            recoverySnapshot: null
        }
    });
    const status = fixture.page.__AVA_CRASH_WATCHDOG_STATUS__();
    assert.equal(status.armed, true);
    assert.equal(status.lastInstanceId, 'test-instance');
});

test('idle crash is deferred until the next cycle without crash recovery', async () => {
    const fixture = loadParentContext();
    const idleUntil = 1_060_000;
    fixture.messageListeners[0]({
        origin: 'https://cdn-sp.tortugasocial.com',
        source: fixture.childWindow,
        data: {
            type: 'AVA_HEARTBEAT',
            version: 1,
            instanceId: 'idle-instance',
            recoverySnapshot: {
                schemaVersion: 1,
                autoLoop: { phase: 'idle', nextReloadAt: idleUntil },
                cleaner: { currentMap: 'garden' }
            }
        }
    });

    fixture.advance(20_000);
    fixture.intervals[0]();
    assert.equal(
        fixture.page.__AVA_CRASH_WATCHDOG_STATUS__().idleReloadDeferredUntil,
        idleUntil
    );
    assert.equal(fixture.timeouts.length, 0);

    fixture.advance(41_000);
    fixture.intervals[0]();
    await new Promise(resolve => setImmediate(resolve));
    await new Promise(resolve => setImmediate(resolve));

    const checkpoint = fixture.values.get('__AVA_CRASH_RECOVERY_V1__');
    assert.equal(checkpoint.reason, 'idle-cycle-due');
    assert.equal(checkpoint.recoveryRequested, false);
    assert.equal(fixture.timeouts.length, 1);
    fixture.timeouts[0]();
    assert.equal(fixture.reloadCount(), 1);
});

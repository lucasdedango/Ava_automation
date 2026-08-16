// ==UserScript==
// @name         Avataria Safe Inspector V12
// @namespace    local-debug
// @version      12.0
// @description  Inspection réseau, WalkAction et événements UI filtrés
// @match        https://vk.ru/*
// @match        https://cdn-sp.tortugasocial.com/avataria-vk/app/index_js.html*
// @run-at       document-start
// @grant        unsafeWindow
// @grant        GM_setClipboard
// @grant        GM_registerMenuCommand
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// ==/UserScript==

(function () {
    /*
     * Ne pas ajouter "use strict".
     *
     * La capture des fonctions métier utilise encore
     * Function.caller et Function.arguments.
     */

    const HEARTBEAT_INTERVAL_MS = 3000;
    const HEARTBEAT_TIMEOUT_MS = 15000;
    const HEARTBEAT_WATCHDOG_CHECK_MS = 3000;
    const HEARTBEAT_REQUIRED_TIMEOUT_CHECKS = 2;
    const RECOVERY_STORAGE_KEY = "__AVA_CRASH_RECOVERY_V1__";
    const RECOVERY_RELOAD_HISTORY_KEY = "__AVA_CRASH_RELOAD_HISTORY_V1__";
    const HOUSE_STORAGE_KEY = "__AVA_SAVED_HOUSE_V1__";
    const HOME_OWNER_ID = "921180938";
    const HOME_ROOM_ID = "room4";
    const FRIDGE_COOLDOWN_SECONDS = 3 * 60 * 60;
    const RECOVERY_SCHEMA_VERSION = 1;
    const RECOVERY_TTL_MS = 10 * 60 * 1000;
    const RECOVERY_MAX_RELOADS = 3;
    const RECOVERY_RELOAD_WINDOW_MS = 10 * 60 * 1000;

    function gmRead(key, fallback = null) {
        try {
            return Promise.resolve(GM_getValue(key, fallback));
        } catch {
            return Promise.resolve(fallback);
        }
    }

    function gmWrite(key, value) {
        try {
            return Promise.resolve(GM_setValue(key, value)).then(() => true, () => false);
        } catch {
            return Promise.resolve(false);
        }
    }

    function gmDelete(key) {
        try {
            return Promise.resolve(GM_deleteValue(key)).then(() => true, () => false);
        } catch {
            return Promise.resolve(false);
        }
    }

    function validHeartbeatEvent(event, gameFrame) {
        return Boolean(
            event?.origin === "https://cdn-sp.tortugasocial.com" &&
            gameFrame?.contentWindow &&
            event.source === gameFrame.contentWindow &&
            event.data?.type === "AVA_HEARTBEAT" &&
            event.data?.version === 1
        );
    }

    function trimReloadHistory(value, now = Date.now()) {
        const timestamps = Array.isArray(value?.timestamps)
            ? value.timestamps.filter(timestamp =>
                Number.isFinite(Number(timestamp)) &&
                now - Number(timestamp) < RECOVERY_RELOAD_WINDOW_MS
            )
            : [];
        return { timestamps };
    }

    function checkpointCanRecover(checkpoint, now = Date.now()) {
        return Boolean(
            checkpoint?.schemaVersion === RECOVERY_SCHEMA_VERSION &&
            checkpoint?.recoveryRequested === true &&
            Number(checkpoint?.expiresAt) > now &&
            checkpoint?.autoLoopEnabled === true &&
            typeof checkpoint?.cleaner?.currentMap === "string" &&
            checkpoint.cleaner.currentMap.length > 0 &&
            Array.isArray(checkpoint?.autoLoop?.maps) &&
            checkpoint.autoLoop.maps.includes(checkpoint.cleaner.currentMap)
        );
    }

    function findParentGameFrame() {
        try {
            return [...document.querySelectorAll("iframe")].find(frame =>
                /cdn-sp\.tortugasocial\.com\/avataria-vk\/app\/index_js\.html/i.test(frame.src)
            ) ?? null;
        } catch {
            return null;
        }
    }

    function initializeParentCrashWatchdog() {
        const parentState = {
            armed: false,
            lastHeartbeatAt: 0,
            lastHeartbeatPayload: null,
            lastInstanceId: null,
            timeoutChecks: 0,
            reloadBlocked: false,
            healthySince: 0,
            reloading: false,
            crashReloadCount: 0,
            lastCrashReason: null,
            lastPhase: null,
            lastNextReloadAt: 0,
            frameConnected: false
        };

        async function reloadAfterCrash(options = {}) {
            if (parentState.reloading || parentState.reloadBlocked) return;
            const recoveryRequested = options.recoveryRequested !== false;
            const reason = options.reason ?? "iframe-heartbeat-timeout";
            parentState.reloading = true;
            const now = Date.now();
            const history = trimReloadHistory(
                await gmRead(RECOVERY_RELOAD_HISTORY_KEY, { timestamps: [] }),
                now
            );
            parentState.crashReloadCount = history.timestamps.length;
            if (history.timestamps.length >= RECOVERY_MAX_RELOADS) {
                parentState.reloadBlocked = true;
                parentState.reloading = false;
                console.error("[AVA RECOVERY] Reload loop protection triggered");
                return;
            }

            const snapshot = parentState.lastHeartbeatPayload?.recoverySnapshot;
            if (snapshot && typeof snapshot === "object") {
                const checkpoint = {
                    ...snapshot,
                    reason,
                    crashDetectedAt: now,
                    recoveryRequested,
                    expiresAt: now + RECOVERY_TTL_MS
                };
                await gmWrite(RECOVERY_STORAGE_KEY, checkpoint);
                if (recoveryRequested) {
                    console.log(`[AVA RECOVERY] Saved crash checkpoint for map ${checkpoint.cleaner?.currentMap ?? "unknown"}`);
                } else {
                    console.log("[AVA RECOVERY] Idle game context died; reloading without work recovery");
                }
            }

            history.timestamps.push(now);
            parentState.crashReloadCount = history.timestamps.length;
            await gmWrite(RECOVERY_RELOAD_HISTORY_KEY, history);
            console.warn(`[AVA RECOVERY] Reloading VK page (${history.timestamps.length}/${RECOVERY_MAX_RELOADS})`);
            setTimeout(() => window.location.reload(), 2500);
        }

        function onHeartbeat(event) {
            const gameFrame = findParentGameFrame();
            if (!validHeartbeatEvent(event, gameFrame)) return;
            const now = Date.now();
            parentState.lastHeartbeatAt = now;
            parentState.lastHeartbeatPayload = event.data;
            parentState.lastInstanceId = event.data.instanceId ?? null;
            parentState.timeoutChecks = 0;
            parentState.lastPhase = event.data?.recoverySnapshot?.autoLoop?.phase ?? null;
            parentState.lastNextReloadAt = Number(
                event.data?.recoverySnapshot?.autoLoop?.nextReloadAt ?? 0
            );
            if (!parentState.armed) {
                parentState.armed = true;
                parentState.healthySince = now;
                console.log("[AVA HEARTBEAT] Parent watchdog armed");
            }
            if (now - parentState.healthySince >= RECOVERY_RELOAD_WINDOW_MS) {
                gmWrite(RECOVERY_RELOAD_HISTORY_KEY, { timestamps: [] });
                parentState.healthySince = now;
                parentState.reloadBlocked = false;
            }
        }

        window.addEventListener("message", onHeartbeat);
        setInterval(() => {
            if (!parentState.armed || parentState.reloading || parentState.reloadBlocked) return;
            const frame = findParentGameFrame();
            if (!frame) {
                parentState.timeoutChecks = 0;
                parentState.frameConnected = false;
                return;
            }
            parentState.frameConnected = Boolean(frame.isConnected);
            const age = Date.now() - parentState.lastHeartbeatAt;
            if (age <= HEARTBEAT_TIMEOUT_MS) {
                parentState.timeoutChecks = 0;
                return;
            }
            const autoLoopSnapshot =
                parentState.lastHeartbeatPayload?.recoverySnapshot?.autoLoop;
            const phase =
                autoLoopSnapshot?.phase ?? null;
            const idleUntil =
                Number(autoLoopSnapshot?.nextReloadAt ?? 0);
            const idleCrash =
                phase === "idle";
            parentState.lastPhase = phase;
            parentState.lastNextReloadAt = idleUntil;
            parentState.timeoutChecks++;
            console.warn(
                `[AVA HEARTBEAT] Heartbeat lost for ${(age / 1000).toFixed(1)}s`,
                {
                    phase,
                    idleUntil,
                    frameConnected: parentState.frameConnected
                }
            );
            if (parentState.timeoutChecks >= HEARTBEAT_REQUIRED_TIMEOUT_CHECKS) {
                const reason = idleCrash
                    ? "idle-iframe-context-dead"
                    : "iframe-heartbeat-timeout";
                parentState.lastCrashReason = reason;
                console.error(
                    "[AVA HEARTBEAT] Game context considered dead",
                    {
                        reason,
                        phase,
                        frameConnected: parentState.frameConnected
                    }
                );
                reloadAfterCrash({
                    recoveryRequested: !idleCrash,
                    reason
                });
            }
        }, HEARTBEAT_WATCHDOG_CHECK_MS);

        const parentWindow = typeof unsafeWindow === "object" ? unsafeWindow : window;
        parentWindow.__AVA_CRASH_WATCHDOG_STATUS__ = function () {
            const frame = findParentGameFrame();
            return {
                armed: parentState.armed,
                gameFrameFound: Boolean(frame),
                lastHeartbeatAt: parentState.lastHeartbeatAt || null,
                lastHeartbeatAgeMs: parentState.lastHeartbeatAt
                    ? Date.now() - parentState.lastHeartbeatAt
                    : null,
                lastInstanceId: parentState.lastInstanceId,
                timeoutMs: HEARTBEAT_TIMEOUT_MS,
                crashReloadCount: parentState.crashReloadCount,
                lastCrashReason: parentState.lastCrashReason,
                lastPhase: parentState.lastPhase,
                lastNextReloadAt: parentState.lastNextReloadAt || null,
                frameConnected: Boolean(frame?.isConnected),
                timeoutChecks: parentState.timeoutChecks,
                reloadBlocked: parentState.reloadBlocked
            };
        };

        gmRead(RECOVERY_RELOAD_HISTORY_KEY, { timestamps: [] }).then(value => {
            parentState.crashReloadCount = trimReloadHistory(value).timestamps.length;
        });
    }

    const isTopContext = window === window.top;
    if (isTopContext) {
        initializeParentCrashWatchdog();
        return;
    }

    /*
     * ============================================================
     * USER AUTOMATION TOGGLES
     * ============================================================
     *
     * Edit these values in the userscript header area before loading
     * the game. This is intentionally independent from browser storage
     * so a refresh always follows the visible script configuration.
     */
    const AVA_AUTO_CLEAN_LOOP_ON = false;
    const AVA_AUTO_CLEAN_LOOP_FULL_THEN_YARD_MS = 40 * 60 * 1000;
    const AVA_AUTO_CLEAN_LOOP_YARD_THEN_FULL_MS = 30 * 60 * 1000;
    const SHIFT_READY_SAFETY_MS = 10 * 1000;
    const SHIFT_ALIGNMENT_MS = 30 * 1000;
    const SHIFT_COUNTDOWN_TIMEOUT_MS = 7500;
    const AVA_BUTTERFLY_MAX_ATTEMPTS = 3;
    const AVA_YARD_MAX_RETRIES_PER_OBJECT = 1;
    const AVA_YARD_INTERACTION_TIMEOUT_MS = 40000;
    const MIN_ENERGY_TO_ACT = 10;

    const w = unsafeWindow;

    const childHeartbeatInstanceId =
        `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const crashRecoveryState = {
        recoveryInProgress: false,
        checkpointFound: false,
        checkpointSavedAt: 0,
        targetMap: null,
        interruptedTargetId: null,
        phase: "idle",
        lastRecoveryError: null,
        lastCheckpointWriteAt: 0
    };
    const energyRecoveryState = {
        inProgress: false,
        phase: "idle",
        savedWork: null,
        requestedCount: 2,
        eatenCount: 0,
        retryAfter: 0,
        lastError: null
    };

    function serializableEntries(value) {
        try {
            return [...(value ?? [])].map(entry =>
                Array.isArray(entry) ? entry.slice(0, 2) : entry
            );
        } catch {
            return [];
        }
    }

    function buildRecoverySnapshot() {
        const cleaner = w.__AVA_MAP_CLEANER__;
        const autoLoop = w.__AVA_AUTO_CLEAN_LOOP__;
        const now = Date.now();
        return {
            schemaVersion: RECOVERY_SCHEMA_VERSION,
            savedAt: now,
            expiresAt: now + RECOVERY_TTL_MS,
            recoveryRequested: false,
            autoLoopEnabled: Boolean(autoLoop?.enabled),
            autoLoop: {
                running: Boolean(autoLoop?.running),
                phase: autoLoop?.phase ?? null,
                cycleMode: autoLoop?.cycleMode ?? null,
                nextCycleMode: autoLoop?.nextCycleMode ?? null,
                maps: Array.isArray(autoLoop?.maps) ? autoLoop.maps.slice() : [],
                mapIndex: Number(cleaner?._mapIndex ?? 0),
                nextReloadAt: Number(autoLoop?.nextReloadAt ?? 0),
                mapAvailability: autoLoop?.serializableMapAvailability?.() ?? {}
            },
            cleaner: {
                running: Boolean(cleaner?.running),
                paused: Boolean(cleaner?.paused),
                pauseReason: cleaner?.pauseReason ?? null,
                currentMap: cleaner?.currentMap ?? null,
                currentTargetId: cleaner?.currentTarget
                    ? stableObjectId(cleaner.currentTarget)
                    : null,
                completedObjectIds: serializableEntries(cleaner?._completedObjects),
                skippedObjectIds: serializableEntries(cleaner?._skippedObjects),
                inactiveObjectIds: serializableEntries(cleaner?._inactiveObjects),
                attemptEntries: serializableEntries(cleaner?._attempts)
            },
            energyRecovery: {
                inProgress: energyRecoveryState.inProgress,
                phase: energyRecoveryState.phase,
                savedWork: energyRecoveryState.savedWork
                    ? { ...energyRecoveryState.savedWork }
                    : null,
                requestedCount: energyRecoveryState.requestedCount,
                eatenCount: energyRecoveryState.eatenCount,
                retryAfter: energyRecoveryState.retryAfter,
                lastError: energyRecoveryState.lastError
            }
        };
    }

    function requestRecoveryCheckpointSave(reason = "state-change", force = false) {
        const now = Date.now();
        if (!force && now - crashRecoveryState.lastCheckpointWriteAt < 10000) {
            return Promise.resolve(false);
        }
        crashRecoveryState.lastCheckpointWriteAt = now;
        return gmWrite(RECOVERY_STORAGE_KEY, {
            ...buildRecoverySnapshot(),
            reason
        });
    }

    function parentVkOrigin() {
        try {
            const origin = new URL(document.referrer).origin;
            return origin === "https://vk.ru"
                ? origin
                : null;
        } catch {
            return null;
        }
    }

    function startChildHeartbeat() {
        const detectedOrigin = parentVkOrigin();
        const targetOrigins = detectedOrigin
            ? [detectedOrigin]
            : ["https://vk.ru"];
        const send = () => {
            try {
                const payload = {
                    type: "AVA_HEARTBEAT",
                    version: 1,
                    instanceId: childHeartbeatInstanceId,
                    sentAt: Date.now(),
                    playable: gameLooksPlayable(),
                    recoverySnapshot: buildRecoverySnapshot()
                };
                for (const targetOrigin of targetOrigins) {
                    window.parent.postMessage(payload, targetOrigin);
                }
                requestRecoveryCheckpointSave("periodic-heartbeat");
            } catch (error) {
                console.warn("[AVA HEARTBEAT] Child heartbeat failed", error);
            }
        };
        send();
        setInterval(send, HEARTBEAT_INTERVAL_MS);
        console.log("[AVA HEARTBEAT] Child heartbeat started");
        return true;
    }

    if (w.__AVA_V11_INSTALLED__) {
        console.warn("[AVA-V11] Déjà installé");
        return;
    }

    w.__AVA_V11_INSTALLED__ = true;
    w.__AVA_V12_INSTALLED__ = true;

    const state = {
        /*
         * WebSocket
         */
        sockets: [],
        wsFrames: [],

        /*
         * Traces réseau
         */
        netTraceActive: false,
        netTraceLabel: "",
        netTraceStartedAt: 0,
        netTraces: [],

        /*
         * Traces UI OpenFL
         */
        uiHookInstalled: false,
        uiHookAttempts: 0,
        uiTraceActive: false,
        uiTraceLabel: "",
        uiTraceStartedAt: 0,
        uiEvents: [],
        uiStopTimer: null,

        /*
         * WalkAction
         */
        lastWalk: null,
        walks: [],
        actor: null,
        walkConstructor: null,
        pointTemplate: null,
        walkOptions: {
            B3e: true
        },

        /*
         * Enregistrement des déplacements
         */
        moveRecording: false,
        moveRecordingStartedAt: 0,
        recordedMoves: [],
        replayTimers: [],
        replaying: false,

        /*
         * Découverte d’actions métier
         */
        actionCaptureActive: false,
        actionCaptureLabel: "",
        actionCaptureStartedAt: 0,
        actionCandidates: [],

        /*
         * Work destinations
         */
        destinationIds: [],
        destinationCommandsReady: false,
        destinationMenuReady: false,
        houseInfo: null,
        houseInfoLoaded: false,

        /*
         * Capture des objets métier SERVICE_OBJECT
         */
        serviceObjectCaptureActive: false,
        serviceObjectCaptureLabel: "",
        serviceObjectCaptureStartedAt: 0,
        serviceObjectCaptures: [],
        lastServiceObject: null,

        /*
         * Nettoyage automatique des maps
         */
        mapCleanerLogs: [],

        /*
         * Diagnostics
         */
        callerErrors: []
    };

    w.__AVA_V11 = state;

    const seenWalkActions = new WeakSet();
    let seenServiceObjects = new WeakSet();
    const cleanerObjectIds = new WeakMap();
    let cleanerObjectIdCounter = 0;
    const loggedExcludedCleanerObjects = new Set();

    /*
     * ============================================================
     * OUTILS
     * ============================================================
     */

    function copyText(text, label) {
        try {
            GM_setClipboard(text, "text");

            console.log(
                `[AVA-V11] ${label} copié dans le presse-papiers`
            );

            return true;
        } catch (error) {
            console.error(
                `[AVA-V11] Copie impossible : ${label}`,
                error
            );

            console.log(text);
            return false;
        }
    }

    function functionName(fn) {
        try {
            if (typeof fn !== "function") {
                return String(fn);
            }

            return fn.name || "(anonyme)";
        } catch {
            return "(illisible)";
        }
    }

    function functionSource(fn, maxLength = 700) {
        try {
            const source =
                Function.prototype.toString.call(fn);

            if (source.length <= maxLength) {
                return source;
            }

            return (
                source.slice(0, maxLength) +
                `…[${source.length} caractères]`
            );
        } catch {
            return "[source illisible]";
        }
    }

    function pointPreview(value) {
        if (!value || typeof value !== "object") {
            return null;
        }

        let x;
        let y;

        try {
            x = Number(value.x);
            y = Number(value.y);
        } catch {
            return null;
        }

        if (
            !Number.isFinite(x) ||
            !Number.isFinite(y)
        ) {
            return null;
        }

        return { x, y };
    }

    function sensitiveKey(key) {
        const normalized =
            String(key).toLowerCase();

        return (
            normalized.includes("token") ||
            normalized.includes("secret") ||
            normalized.includes("password") ||
            normalized.includes("auth") ||
            normalized.includes("session") ||
            normalized === "sid" ||
            normalized === "sign"
        );
    }

    function safePreview(
        value,
        depth = 0,
        seen = new WeakSet()
    ) {
        if (depth > 2) {
            return "[profondeur maximale]";
        }

        if (
            value === null ||
            value === undefined ||
            typeof value === "number" ||
            typeof value === "boolean"
        ) {
            return value;
        }

        if (typeof value === "string") {
            if (value.length <= 180) {
                return value;
            }

            return (
                value.slice(0, 100) +
                `…[${value.length}]`
            );
        }

        if (typeof value === "function") {
            return `[Function ${functionName(value)}]`;
        }

        if (typeof value !== "object") {
            return String(value);
        }

        if (seen.has(value)) {
            return "[circulaire]";
        }

        seen.add(value);

        const point = pointPreview(value);

        if (point) {
            return point;
        }

        if (value instanceof w.ArrayBuffer) {
            return {
                type: "ArrayBuffer",
                byteLength: value.byteLength
            };
        }

        if (w.ArrayBuffer.isView(value)) {
            return {
                type:
                    value.constructor?.name ??
                    "TypedArray",

                byteLength:
                    value.byteLength
            };
        }

        if (Array.isArray(value)) {
            return value
                .slice(0, 25)
                .map(item =>
                    safePreview(
                        item,
                        depth + 1,
                        seen
                    )
                );
        }

        const result = {
            type:
                value.constructor?.name ??
                Object.prototype.toString.call(value)
        };

        let keys = [];

        try {
            keys = Object.keys(value).slice(0, 25);
        } catch {
            return result;
        }

        for (const key of keys) {
            if (sensitiveKey(key)) {
                result[key] = "[masqué]";
                continue;
            }

            try {
                result[key] = safePreview(
                    value[key],
                    depth + 1,
                    seen
                );
            } catch {
                result[key] = "[illisible]";
            }
        }

        return result;
    }

    /*
     * ============================================================
     * SERVICE OBJECT CAPTURE
     * ============================================================
     * Workflow conseillé :
     * __AVA_GO_YARD__()
     * __AVA_SERVICE_START__("yard-object")
     * __AVA_ACTION_START__("yard-object")
     * __AVA_NET_START__("yard-object")
     * __AVA_UI_START__("yard-object", 8000)
     * // Cliquer exactement un objet de tâche puis attendre la fin.
     * __AVA_SERVICE_STOP__()
     * __AVA_ACTION_STOP__()
     * __AVA_NET_STOP__()
     * __AVA_UI_STOP__()
     * __AVA_SERVICE_LIST__()
     * const obj = __AVA_SERVICE_LAST__()
     * obj
     * obj.objectId
     * obj.shopItem
     * obj.shopItem.typeId
     * Object.getOwnPropertyNames(obj)
     * Object.getOwnPropertyNames(Object.getPrototypeOf(obj))
     */

    function safeReadProperty(object, key) {
        try {
            return object?.[key];
        } catch {
            return undefined;
        }
    }

    function safePropertyNames(object) {
        try {
            if (!object || typeof object !== "object") {
                return [];
            }

            return Object.getOwnPropertyNames(object);
        } catch {
            return [];
        }
    }

    function safePrototypePropertyNames(object) {
        try {
            const prototype =
                Object.getPrototypeOf(object);

            if (!prototype) {
                return [];
            }

            return Object.getOwnPropertyNames(prototype);
        } catch {
            return [];
        }
    }

    function safeObjectType(object) {
        try {
            const tag =
                Object.prototype.toString.call(object);

            const constructorName =
                object?.constructor?.name;

            if (constructorName) {
                return `${constructorName} ${tag}`;
            }

            return tag;
        } catch {
            return "[type illisible]";
        }
    }

    function simpleScalar(value) {
        return (
            value === null ||
            value === undefined ||
            typeof value === "string" ||
            typeof value === "number" ||
            typeof value === "boolean"
        );
    }

    function describeObjectShallow(object) {
        const description = {
            type: safeObjectType(object),
            ownPropertyNames: safePropertyNames(object),
            prototypePropertyNames: safePrototypePropertyNames(object),
            fields: {}
        };

        const scalarFields = [
            "objectId",
            "id",
            "typeId",
            "state",
            "serviced",
            "enabled",
            "active",
            "x",
            "y"
        ];

        for (const field of scalarFields) {
            const value =
                safeReadProperty(object, field);

            if (simpleScalar(value)) {
                description.fields[field] = value;
            }
        }

        return description;
    }

    function serviceCandidateInfo(value) {
        if (!value || typeof value !== "object") {
            return null;
        }

        try {
            const objectId =
                safeReadProperty(value, "objectId");

            const shopItem =
                safeReadProperty(value, "shopItem");

            const shopItemTypeId =
                safeReadProperty(shopItem, "typeId");

            if (
                objectId === undefined ||
                !shopItem ||
                shopItemTypeId === undefined
            ) {
                return null;
            }

            return {
                objectId,
                shopItem,
                shopItemTypeId
            };
        } catch {
            return null;
        }
    }

    function collectServiceCandidates(
        value,
        depth = 0,
        seen = new WeakSet(),
        candidates = []
    ) {
        if (
            depth > 3 ||
            !value ||
            typeof value !== "object"
        ) {
            return candidates;
        }

        if (seen.has(value)) {
            return candidates;
        }

        seen.add(value);

        const info =
            serviceCandidateInfo(value);

        if (info) {
            candidates.push({
                object: value,
                info
            });
        }

        const keys =
            Array.from(
                new Set([
                    ...safePropertyNames(value),
                    "object",
                    "data",
                    "target",
                    "currentTarget",
                    "shopItem",
                    "event",
                    "value"
                ])
            ).slice(0, 40);

        for (const key of keys) {
            const child =
                safeReadProperty(value, key);

            if (child && typeof child === "object") {
                collectServiceCandidates(
                    child,
                    depth + 1,
                    seen,
                    candidates
                );
            }
        }

        if (Array.isArray(value)) {
            for (const child of value.slice(0, 20)) {
                collectServiceCandidates(
                    child,
                    depth + 1,
                    seen,
                    candidates
                );
            }
        }

        return candidates;
    }

    function serviceCaptureSummary(entry) {
        return {
            index:
                entry.index,

            label:
                entry.label,

            elapsedMs:
                entry.elapsedMs,

            objectId:
                entry.objectId,

            shopItemTypeId:
                entry.shopItemTypeId,

            objectType:
                entry.objectType,

            shopItemType:
                entry.shopItemType,

            sourceMethod:
                entry.sourceMethod,

            eventType:
                entry.eventType ??
                null
        };
    }

    function serviceCaptureSummaries() {
        return state.serviceObjectCaptures.map(
            serviceCaptureSummary
        );
    }

    function captureServiceCandidate(candidate, origin = {}) {
        if (!state.serviceObjectCaptureActive) {
            return false;
        }

        const info =
            candidate?.info ??
            serviceCandidateInfo(candidate?.object);

        const object =
            candidate?.object;

        if (!object || !info) {
            return false;
        }

        if (seenServiceObjects.has(object)) {
            return false;
        }

        seenServiceObjects.add(object);
        state.lastServiceObject = object;

        const entry = {
            index:
                state.serviceObjectCaptures.length,

            label:
                state.serviceObjectCaptureLabel,

            time:
                new Date().toISOString(),

            elapsedMs:
                Math.round(
                    performance.now() -
                    state.serviceObjectCaptureStartedAt
                ),

            objectId:
                info.objectId,

            shopItemTypeId:
                info.shopItemTypeId,

            rawObject:
                object,

            rawShopItem:
                info.shopItem,

            objectType:
                safeObjectType(object),

            shopItemType:
                safeObjectType(info.shopItem),

            objectDescription:
                describeObjectShallow(object),

            shopItemDescription:
                describeObjectShallow(info.shopItem),

            sourceMethod:
                origin.sourceMethod ??
                null,

            functionSource:
                origin.functionSource ??
                null,

            rawArguments:
                origin.rawArguments ??
                null,

            rawThis:
                origin.rawThis ??
                null,

            stack:
                origin.stack ??
                null,

            eventType:
                origin.eventType ??
                null,

            rawEvent:
                origin.rawEvent ??
                null,

            rawDispatcher:
                origin.rawDispatcher ??
                null,

            eventTarget:
                origin.eventTarget ??
                null,

            eventCurrentTarget:
                origin.eventCurrentTarget ??
                null
        };

        state.serviceObjectCaptures.push(entry);

        console.log(
            `[AVA-V12 SERVICE] Objet capturé : objectId=${String(info.objectId)}, typeId=${String(info.shopItemTypeId)}`
        );

        return true;
    }

    function inspectServiceObjects(values, origin = {}) {
        if (!state.serviceObjectCaptureActive) {
            return false;
        }

        let captured = false;

        try {
            for (const value of values) {
                const candidates =
                    collectServiceCandidates(value);

                for (const candidate of candidates) {
                    captured =
                        captureServiceCandidate(
                            candidate,
                            origin
                        ) ||
                        captured;
                }
            }
        } catch (error) {
            console.warn(
                "[AVA-V12 SERVICE] Inspection impossible",
                error
            );
        }

        return captured;
    }

    w.__AVA_SERVICE_START__ = function (label = "service-object") {
        state.serviceObjectCaptures.length = 0;
        state.lastServiceObject = null;
        state.serviceObjectCaptureLabel = String(label);
        state.serviceObjectCaptureStartedAt = performance.now();
        state.serviceObjectCaptureActive = true;
        seenServiceObjects = new WeakSet();

        console.log(
            `[AVA-V12 SERVICE] Capture démarrée : ${label}`
        );

        return true;
    };

    w.__AVA_SERVICE_STOP__ = function () {
        state.serviceObjectCaptureActive = false;

        const summaries =
            serviceCaptureSummaries();

        console.log(
            `[AVA-V12 SERVICE] Capture arrêtée : ${summaries.length} objet(s)`
        );

        return summaries;
    };

    w.__AVA_SERVICE_LIST__ = function () {
        const summaries =
            serviceCaptureSummaries();

        if (summaries.length === 0) {
            console.warn("[AVA-V12 SERVICE] Aucun objet capturé");
        }

        console.table(summaries);

        return summaries;
    };

    w.__AVA_SERVICE_SHOW__ = function (index) {
        const entry =
            state.serviceObjectCaptures[
                Number(index)
            ];

        if (!entry) {
            console.warn("[AVA-V12 SERVICE] Aucun objet capturé");
            return null;
        }

        console.log(entry);
        return entry;
    };

    w.__AVA_SERVICE_LAST__ = function () {
        if (!state.lastServiceObject) {
            console.warn("[AVA-V12 SERVICE] Aucun objet capturé");
            return null;
        }

        console.log(state.lastServiceObject);
        return state.lastServiceObject;
    };

    w.__AVA_SERVICE_CLEAR__ = function () {
        state.serviceObjectCaptures.length = 0;
        state.lastServiceObject = null;
        seenServiceObjects = new WeakSet();

        return true;
    };

    /*
     * ============================================================
     * WORK DESTINATIONS
     * ============================================================
     */

    function getWorkManager() {
        try {
            return (
                w.penzville
                    ?.city
                    ?.Context
                    ?.workManager ??
                null
            );
        } catch {
            return null;
        }
    }

    function getWorkLocationClass() {
        try {
            const WorkLocation =
                w.penzville
                    ?.city
                    ?.work
                    ?.WorkLocation;

            if (typeof WorkLocation !== "function") {
                return null;
            }

            return WorkLocation;
        } catch {
            return null;
        }
    }

    function getHouseLocationClass() {
        try {
            const city =
                w.penzville?.city ??
                null;

            if (!city) {
                return null;
            }

            const currentLocation =
                safeReadProperty(
                    safeReadProperty(city, "Context"),
                    "currentLocation"
                );
            const currentOwnerId =
                safeReadProperty(currentLocation, "_gl");
            const currentSwitchRoom =
                safeReadProperty(currentLocation, "switchRoom");
            const currentConstructor =
                safeReadProperty(currentLocation, "constructor");

            if (
                currentOwnerId != null &&
                typeof currentSwitchRoom === "function" &&
                typeof currentConstructor === "function"
            ) {
                return currentConstructor;
            }

            const readPath = path => {
                let value = city;
                for (const name of path) {
                    value = safeReadProperty(value, name);
                    if (value == null) {
                        return null;
                    }
                }
                return value;
            };

            const directCandidates = [
                readPath(["HouseLocation"]),
                readPath(["location", "HouseLocation"]),
                readPath(["locations", "HouseLocation"]),
                readPath(["house", "HouseLocation"]),
                readPath(["model", "HouseLocation"])
            ];

            for (const candidate of directCandidates) {
                if (typeof candidate === "function") {
                    return candidate;
                }
            }

            const queue = [{ value: city, depth: 0 }];
            const seen = new WeakSet();
            let inspected = 0;

            while (queue.length > 0 && inspected < 1000) {
                const { value, depth } = queue.shift();
                if (
                    !value ||
                    (typeof value !== "object" && typeof value !== "function") ||
                    seen.has(value)
                ) {
                    continue;
                }

                seen.add(value);
                inspected++;

                let names = [];
                try {
                    names = Object.getOwnPropertyNames(value).slice(0, 150);
                } catch {}

                for (const name of names) {
                    const child = safeReadProperty(value, name);

                    if (name === "HouseLocation" && typeof child === "function") {
                        return child;
                    }

                    if (
                        depth < 3 &&
                        child &&
                        (typeof child === "object" || typeof child === "function")
                    ) {
                        queue.push({ value: child, depth: depth + 1 });
                    }
                }
            }

            return null;
        } catch {
            return null;
        }
    }

    function normalizeHouseInfo(value) {
        if (!value || value.ownerId == null || value.ownerId === "") {
            return null;
        }

        return {
            ownerId: value.ownerId,
            roomId: value.roomId ?? null,
            roomKey: value.roomKey ?? null
        };
    }

    function currentHouseInfo() {
        try {
            const location =
                w.penzville?.city?.Context?.currentLocation ??
                null;

            if (
                !location ||
                location._gl == null ||
                location.Lmc == null ||
                typeof location.switchRoom !== "function"
            ) {
                return null;
            }

            return normalizeHouseInfo({
                ownerId: location._gl,
                roomId: location.Lmc ?? null,
                roomKey: location.qmc ?? null
            });
        } catch {
            return null;
        }
    }

    function saveCurrentHouseInfo() {
        if (state.houseInfo) {
            return state.houseInfo;
        }

        const info =
            currentHouseInfo();

        if (!info) {
            return null;
        }

        state.houseInfo = info;
        gmWrite(HOUSE_STORAGE_KEY, info);
        console.log("[AVA HOUSE] Player house saved", info);
        return info;
    }

    function waitForHouseState(predicate, timeoutMs = 30000, pollMs = 250) {
        const startedAt =
            performance.now();

        return new Promise(resolve => {
            const check = () => {
                try {
                    const result = predicate();
                    if (result) {
                        resolve(result);
                        return;
                    }
                } catch {}

                if (performance.now() - startedAt >= timeoutMs) {
                    resolve(null);
                    return;
                }

                setTimeout(check, pollMs);
            };

            check();
        });
    }

    function houseLocationIsActive(location, ownerId) {
        try {
            const current =
                w.penzville?.city?.Context?.currentLocation ??
                null;

            return Boolean(
                current &&
                (
                    current === location ||
                    (
                        current._gl != null &&
                        String(current._gl) === String(ownerId)
                    )
                )
            );
        } catch {
            return false;
        }
    }

    /*
     * Some HouseLocation builds leave Lmc and qmc unset after switchRoom().
     * Loaded room models are a stronger functional signal for the configured
     * refrigerator room than those optional obfuscated metadata fields.
     */
    function houseRoomContentIsReady(ownerId, roomId) {
        const current =
            w.penzville?.city?.Context?.currentLocation ??
            null;

        if (!current) {
            return null;
        }

        if (String(current._gl ?? "") !== String(ownerId)) {
            return null;
        }

        const roomIdMatches =
            String(current.Lmc ?? "") === String(roomId);
        const roomKeyMatches =
            String(current.qmc ?? "") === `house_${ownerId}_${roomId}`;
        let fridges = [];

        try {
            fridges = findFridgesInCurrentRoom();
        } catch {}

        const expectedContentLoaded =
            String(roomId) === String(HOME_ROOM_ID) &&
            fridges.length > 0;

        if (!roomIdMatches && !roomKeyMatches && !expectedContentLoaded) {
            return null;
        }

        return {
            location: current,
            fridges,
            confirmedBy: roomIdMatches
                ? "Lmc"
                : roomKeyMatches
                    ? "qmc"
                    : "room-content"
        };
    }

    async function goHouse(ownerId, roomId = null) {
        if (ownerId == null || ownerId === "") {
            console.error("[AVA HOUSE] Invalid ownerId");
            return false;
        }

        saveCurrentHouseInfo();

        const HouseLocation =
            getHouseLocationClass();

        if (!HouseLocation) {
            console.error("[AVA HOUSE] HouseLocation unavailable");
            return false;
        }

        let location = null;

        try {
            location = new HouseLocation(ownerId, null);
            w.penzville.city.Context.currentLocation = location;
            console.log(`[AVA HOUSE] Teleporting to house ${String(ownerId)}`);
        } catch (error) {
            console.error("[AVA HOUSE] House teleport failed", error);
            return false;
        }

        let activeSince = 0;
        const activeLocation = await waitForHouseState(() => {
            if (!houseLocationIsActive(location, ownerId)) {
                activeSince = 0;
                return null;
            }

            if (!activeSince) {
                activeSince = performance.now();
                return null;
            }

            if (performance.now() - activeSince < 750) {
                return null;
            }

            return w.penzville?.city?.Context?.currentLocation ?? null;
        });

        if (!activeLocation) {
            console.error("[AVA HOUSE] House activation timeout");
            return false;
        }

        if (roomId == null || roomId === "") {
            return {
                success: true,
                ownerId,
                roomId: null,
                roomSwitched: false
            };
        }

        try {
            if (typeof activeLocation.switchRoom !== "function") {
                console.error("[AVA HOUSE] switchRoom unavailable; remaining in house");
                return {
                    success: true,
                    ownerId,
                    roomId,
                    roomSwitched: false
                };
            }

            activeLocation.switchRoom(roomId);
            console.log(`[AVA HOUSE] Switching to room ${String(roomId)}`);
        } catch (error) {
            console.error("[AVA HOUSE] Room switch failed; remaining in house", error);
            return {
                success: true,
                ownerId,
                roomId,
                roomSwitched: false
            };
        }

        const roomReady = await waitForHouseState(
            () => houseRoomContentIsReady(ownerId, roomId),
            30000,
            250
        );

        if (!roomReady) {
            console.error(
                `[AVA HOUSE] Room ${String(roomId)} load timeout; remaining in house`
            );
            return {
                success: true,
                ownerId,
                roomId,
                roomSwitched: false
            };
        }

        console.log(
            `[AVA HOUSE] Room ${String(roomId)} ready via ${roomReady.confirmedBy}`
        );
        console.log(`[AVA HOUSE] Found ${roomReady.fridges.length} refrigerators`);
        return {
            success: true,
            ownerId,
            roomId,
            roomSwitched: true,
            confirmedBy: roomReady.confirmedBy,
            fridgeCount: roomReady.fridges.length
        };
    }

    function fridgeRow(model) {
        try {
            if (String(model?.shopItem?.typeId ?? "") !== "refrigerator3") {
                return null;
            }

            const objectId =
                model.objectId ??
                null;

            if (objectId == null) {
                return null;
            }

            const now =
                Math.floor(Date.now() / 1000);
            const lastProductionTime =
                Number(model.lastProductionTime ?? 0);
            const elapsed =
                Math.max(0, now - lastProductionTime);
            const remainingSeconds =
                Math.max(0, FRIDGE_COOLDOWN_SECONDS - elapsed);

            return {
                objectId: String(objectId),
                typeId: "refrigerator3",
                model,
                lastProductionTime,
                eaterId: model.eaterId ?? null,
                ready: remainingSeconds === 0,
                remainingSeconds
            };
        } catch {
            return null;
        }
    }

    function findFridgesInCurrentRoom() {
        const location =
            w.penzville?.city?.Context?.currentLocation ??
            null;

        if (!location) {
            return [];
        }

        const roots = [
            location,
            safeReadProperty(location, "_h"),
            safeReadProperty(safeReadProperty(location, "_h"), "Jql"),
            safeReadProperty(location, "roomLayout"),
            safeReadProperty(location, "world")
        ].filter(Boolean);
        const queue = roots.map(value => ({ value, depth: 0 }));
        const seen = new WeakSet();
        const byObjectId = new Map();
        let inspected = 0;

        while (queue.length > 0 && inspected < 10000) {
            const { value, depth } = queue.shift();
            if (
                !value ||
                (typeof value !== "object" && typeof value !== "function") ||
                seen.has(value)
            ) {
                continue;
            }

            seen.add(value);
            inspected++;

            const row = fridgeRow(value);
            if (row && !byObjectId.has(row.objectId)) {
                byObjectId.set(row.objectId, row);
            }

            if (depth >= 7) {
                continue;
            }

            if (Array.isArray(value)) {
                for (const child of value.slice(0, 500)) {
                    if (child && typeof child === "object") {
                        queue.push({ value: child, depth: depth + 1 });
                    }
                }
                continue;
            }

            let names = [];
            try {
                names = Object.getOwnPropertyNames(value).slice(0, 120);
            } catch {}

            for (const name of names) {
                if (["parent", "stage", "graphics"].includes(name)) {
                    continue;
                }
                const child = safeReadProperty(value, name);
                if (child && typeof child === "object") {
                    queue.push({ value: child, depth: depth + 1 });
                }
            }
        }

        return [...byObjectId.values()].sort((left, right) =>
            Number(right.ready) - Number(left.ready) ||
            left.remainingSeconds - right.remainingSeconds
        );
    }

    function findRoomActionManager() {
        const location =
            w.penzville?.city?.Context?.currentLocation ??
            null;

        if (!location) {
            return null;
        }

        const context =
            w.penzville?.city?.Context ??
            null;
        const roots = [
            location,
            safeReadProperty(location, "_h"),
            safeReadProperty(location, "roomLayout"),
            safeReadProperty(context, "roomActionNetManager"),
            safeReadProperty(context, "J")
        ].filter(Boolean);
        const queue = roots.map(value => ({ value, depth: 0 }));
        const seen = new WeakSet();
        let inspected = 0;

        while (queue.length > 0 && inspected < 3000) {
            const { value, depth } = queue.shift();
            if (!value || typeof value !== "object" || seen.has(value)) {
                continue;
            }
            seen.add(value);
            inspected++;

            if (
                typeof value.startAction === "function" &&
                typeof value.finishAction === "function"
            ) {
                return value;
            }

            if (depth >= 5) {
                continue;
            }

            let names = [];
            try {
                names = Object.getOwnPropertyNames(value).slice(0, 120);
            } catch {}

            for (const name of names) {
                if (["parent", "stage", "graphics"].includes(name)) {
                    continue;
                }
                const child = safeReadProperty(value, name);
                if (child && typeof child === "object") {
                    queue.push({ value: child, depth: depth + 1 });
                }
            }
        }

        return null;
    }

    function roomActionEventMatches(event, objectId) {
        try {
            const values = [
                event?.objectId,
                event?.data?.objectId,
                event?.params?.objectId,
                event?.targetObjectId
            ].filter(value => value != null).map(String);
            const actions = [
                event?.action,
                event?.data?.action,
                event?.params?.action,
                event?.actionId
            ].filter(value => value != null).map(String);

            return (
                (values.length === 0 || values.includes(String(objectId))) &&
                (actions.length === 0 || actions.includes("use"))
            );
        } catch {
            return false;
        }
    }

    function watchRoomActionEvents(manager, objectId) {
        let started = false;
        let finished = false;
        const removers = [];
        const targets = [
            manager,
            w.penzville?.city?.Context?.currentLocation
        ].filter(Boolean);
        const eventTypes = new Set([
            "roomActionStarted",
            "ROOM_ACTION_STARTED",
            "roomActionFinished",
            "ROOM_ACTION_FINISHED"
        ]);

        for (const source of [manager, manager?.constructor]) {
            let names = [];
            try {
                names = Object.getOwnPropertyNames(source ?? {});
            } catch {}
            for (const name of names) {
                if (!/(start|finish)/i.test(name)) {
                    continue;
                }
                const value = safeReadProperty(source, name);
                if (typeof value === "string" && /action/i.test(value)) {
                    eventTypes.add(value);
                }
            }
        }

        for (const target of targets) {
            if (typeof target.addEventListener !== "function") {
                continue;
            }
            for (const type of eventTypes) {
                const listener = event => {
                    if (!roomActionEventMatches(event, objectId)) {
                        return;
                    }
                    if (/finished/i.test(type)) {
                        finished = true;
                    } else {
                        started = true;
                    }
                };
                try {
                    target.addEventListener(type, listener);
                    removers.push(() => {
                        try {
                            target.removeEventListener(type, listener);
                        } catch {}
                    });
                } catch {}
            }
        }

        return {
            get started() { return started; },
            get finished() { return finished; },
            cleanup() {
                for (const remove of removers) {
                    remove();
                }
            }
        };
    }

    async function eatFromFridge(objectId) {
        const row =
            findFridgesInCurrentRoom()
                .find(item => item.objectId === String(objectId));

        if (!row) {
            return { success: false, objectId: String(objectId), reason: "fridge not found" };
        }
        if (!row.ready) {
            return { success: false, objectId: row.objectId, reason: "fridge cooldown active" };
        }

        const manager =
            findRoomActionManager();
        if (!manager) {
            return { success: false, objectId: row.objectId, reason: "RoomActionNetManager unavailable" };
        }

        const avatarId =
            HOME_OWNER_ID;
        const previousTimestamp =
            Number(row.model.lastProductionTime ?? 0);
        const events =
            watchRoomActionEvents(manager, row.objectId);

        try {
            try {
                if (typeof row.model.select === "function") {
                    row.model.select();
                }
            } catch {}

            const point = getObjectPoint(row.model);
            if (point && typeof w.__AVA_WALK_TO__ === "function") {
                w.__AVA_WALK_TO__(point.x, point.y);
                await new Promise(resolve => setTimeout(resolve, 750));
            }

            const refreshed = fridgeRow(row.model);
            if (!refreshed?.ready) {
                return { success: false, objectId: row.objectId, reason: "fridge became unavailable" };
            }

            console.log(`[AVA FRIDGE] Using ${row.objectId}`);
            const startResult = manager.startAction(
                row.objectId,
                "use",
                avatarId,
                null
            );
            if (startResult === false) {
                return { success: false, objectId: row.objectId, reason: "start action rejected" };
            }

            const started = await waitForHouseState(() =>
                events.started ||
                Number(row.model.lastProductionTime ?? 0) > previousTimestamp,
                8000,
                100
            );
            if (!started) {
                return { success: false, objectId: row.objectId, reason: "roomActionStarted timeout" };
            }

            const finishResult = manager.finishAction(
                row.objectId,
                "use",
                avatarId,
                null
            );
            if (finishResult === false) {
                return { success: false, objectId: row.objectId, reason: "finish action rejected" };
            }

            const completed = await waitForHouseState(() =>
                Number(row.model.lastProductionTime ?? 0) > previousTimestamp ||
                events.finished,
                15000,
                100
            );

            if (!completed) {
                return { success: false, objectId: row.objectId, reason: "roomActionFinished timeout" };
            }

            console.log("[AVA FRIDGE] Use succeeded; lastProductionTime updated");
            return {
                success: true,
                objectId: row.objectId,
                previousTimestamp,
                lastProductionTime: Number(row.model.lastProductionTime ?? previousTimestamp),
                confirmedBy: Number(row.model.lastProductionTime ?? 0) > previousTimestamp
                    ? "lastProductionTime"
                    : "roomActionFinished"
            };
        } catch (error) {
            return {
                success: false,
                objectId: row.objectId,
                reason: String(error)
            };
        } finally {
            events.cleanup();
            try {
                if (typeof row.model.deselect === "function") {
                    row.model.deselect();
                }
            } catch {}
        }
    }

    async function eatAvailable(count = 1) {
        const requested =
            Math.max(0, Math.floor(Number(count) || 0));
        const rows =
            findFridgesInCurrentRoom();
        const ready =
            rows.filter(row => row.ready);
        const result = {
            requested,
            eaten: 0,
            attemptedObjectIds: [],
            successfulObjectIds: [],
            failures: [],
            readyFound: ready.length,
            nextReadyInSeconds: rows.length
                ? Math.min(...rows.map(row => row.remainingSeconds))
                : null
        };

        console.log(`[AVA FRIDGE] Found ${rows.length} refrigerators, ${ready.length} ready`);

        for (const row of ready.slice(0, requested)) {
            result.attemptedObjectIds.push(row.objectId);
            const attempt = await eatFromFridge(row.objectId);
            if (attempt.success) {
                result.eaten++;
                result.successfulObjectIds.push(row.objectId);
            } else {
                result.failures.push(attempt);
            }
        }

        if (result.eaten < requested) {
            result.failures.push({
                reason: `only ${result.eaten}/${requested} refrigerator uses succeeded`
            });
        }

        return result;
    }

    function getDestinationRegistry() {
        try {
            return getWorkManager()?.FYl ?? null;
        } catch {
            return null;
        }
    }

    function getWorkLocationModel(id) {
        try {
            const manager =
                getWorkManager();

            if (
                !manager ||
                typeof manager.getWorkLocationModel !==
                    "function"
            ) {
                return null;
            }

            return (
                manager.getWorkLocationModel(String(id)) ??
                null
            );
        } catch {
            return null;
        }
    }

    function getDestinationIds() {
        try {
            const registry =
                getDestinationRegistry();

            if (!registry || typeof registry !== "object") {
                return null;
            }

            return Object.keys(registry);
        } catch {
            return null;
        }
    }

    function destinationFriendlyName(id) {
        try {
            return String(id)
                .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
                .replace(/[^a-zA-Z0-9]+/g, "_")
                .replace(/^_+|_+$/g, "")
                .toUpperCase();
        } catch {
            return null;
        }
    }

    function destinationTableRow(id) {
        const model =
            getWorkLocationModel(id);

        return {
            id,
            loadingContent:
                model?.loadingContent ??
                null,
            rooms:
                model?.rooms ??
                null,
            jobs:
                model?.jobs ??
                null
        };
    }

    function createDestinationCommand(id, commandName) {
        try {
            if (!commandName) {
                return false;
            }

            w[commandName] = function () {
                return w.__AVA_GO_WORK__(id);
            };

            return true;
        } catch {
            return false;
        }
    }

    function createDestinationCommands(ids) {
        const friendlyAliases = {
            YARD: "garbage",
            GARDEN: "garden",
            RESTAURANT: "restaurant",
            SCULPT: "sculpt",
            SCHOOL: "schoolAvataria",
            NPC_HOUSE: "npcHouse",
            FORTUNE: "fortune",
            FORTUNE2: "fortune2",
            FORTUNE3: "fortune3"
        };

        for (const id of ids) {
            const friendlyName =
                destinationFriendlyName(id);

            createDestinationCommand(
                id,
                `__AVA_GO_${friendlyName}__`
            );
        }

        for (const [alias, id] of Object.entries(friendlyAliases)) {
            createDestinationCommand(
                id,
                `__AVA_GO_${alias}__`
            );
        }

        state.destinationCommandsReady = true;
    }

    function registerDestinationMenu(ids) {
        try {
            if (typeof GM_registerMenuCommand !== "function") {
                return false;
            }

            for (const id of ids) {
                GM_registerMenuCommand(
                    `AVA Go ${destinationFriendlyName(id)}`,
                    () => w.__AVA_GO_WORK__(id)
                );
            }

            state.destinationMenuReady = true;
            return true;
        } catch (error) {
            console.warn(
                "[AVA-V12] Enregistrement du menu impossible",
                error
            );

            return false;
        }
    }

    w.__AVA_GO_WORK__ = function (id) {
        const manager =
            getWorkManager();

        if (!manager) {
            console.error("[AVA-V12] WorkManager indisponible");
            return false;
        }

        const WorkLocation =
            getWorkLocationClass();

        if (!WorkLocation) {
            console.error("[AVA-V12] WorkLocation indisponible");
            return false;
        }

        const stringId =
            String(id);

        const model =
            getWorkLocationModel(stringId);

        if (!model) {
            console.error(
                `[AVA-V12] Destination inconnue : ${stringId}`
            );

            return false;
        }

        try {
            saveCurrentHouseInfo();
            w.penzville.city.Context.currentLocation =
                new WorkLocation(stringId);

            return true;
        } catch (error) {
            console.error(
                `[AVA-V12] Téléportation impossible : ${stringId}`,
                error
            );

            return false;
        }
    };

    w.__AVA_GO_HOUSE__ = function (ownerId, roomId = null) {
        return goHouse(ownerId, roomId);
    };

    w.__AVA_RETURN_HOME__ = async function () {
        let currentInfo =
            saveCurrentHouseInfo();

        if (!currentInfo && !state.houseInfoLoaded) {
            await waitForHouseState(
                () => state.houseInfoLoaded || null,
                5000,
                100
            );
            currentInfo = saveCurrentHouseInfo();
        }

        const info = currentInfo ?? state.houseInfo;

        if (!info) {
            console.error(
                "[AVA HOUSE] Player house is not saved yet; visit the house once before using __AVA_RETURN_HOME__()"
            );
            return false;
        }

        return goHouse(info.ownerId, info.roomId);
    };

    w.__AVA_LIST_FRIDGES__ = function () {
        const rows = findFridgesInCurrentRoom();
        const displayRows = rows.map(row => ({
            objectId: row.objectId,
            ready: row.ready,
            lastUse: row.lastProductionTime,
            remainingMinutes: Math.ceil(row.remainingSeconds / 60)
        }));
        console.table(displayRows);
        return rows;
    };

    w.__AVA_EAT_FROM_FRIDGE__ = function (objectId) {
        return eatFromFridge(objectId);
    };

    w.__AVA_EAT_AVAILABLE__ = function (count = 1) {
        return eatAvailable(count);
    };

    w.__AVA_LIST_DESTINATIONS__ = function () {
        const ids =
            getDestinationIds() ??
            [];

        const rows =
            ids.map(destinationTableRow);

        console.table(rows);

        return rows;
    };

    function initializeDestinationSystem() {
        const timer =
            setInterval(() => {
                const manager =
                    getWorkManager();

                if (!manager) {
                    return;
                }

                const ids =
                    getDestinationIds();

                if (!ids) {
                    return;
                }

                clearInterval(timer);

                state.destinationIds =
                    ids.slice();

                createDestinationCommands(ids);
                registerDestinationMenu(ids);

                console.log(
                    "[AVA-V12] Destination system ready"
                );
            }, 500);
    }

    async function initializeHouseSystem() {
        const current =
            saveCurrentHouseInfo();

        if (!current) {
            const stored =
                normalizeHouseInfo(
                    await gmRead(HOUSE_STORAGE_KEY, null)
                );

            if (stored && !state.houseInfo) {
                state.houseInfo = stored;
                console.log("[AVA HOUSE] Saved house restored", stored);
            }
        }

        state.houseInfoLoaded = true;

        if (state.houseInfo) {
            return state.houseInfo;
        }

        const timer = setInterval(() => {
            if (saveCurrentHouseInfo()) {
                clearInterval(timer);
            }
        }, 500);

        return null;
    }

    function serializableInterruptedWork(cleaner) {
        const autoLoop =
            w.__AVA_AUTO_CLEAN_LOOP__;

        return {
            currentMap: cleaner.currentMap ?? null,
            mapIndex: Number(cleaner._mapIndex ?? 0),
            cycleMode: autoLoop?.cycleMode ?? null,
            nextCycleMode: autoLoop?.nextCycleMode ?? null,
            interruptedTargetId: cleaner.currentTarget
                ? stableObjectId(cleaner.currentTarget)
                : (cleaner._energyInterruptedTargetId ?? null)
        };
    }

    function markEnergyRecoveryFailed(cleaner, reason, retryAfter = 0) {
        energyRecoveryState.inProgress = false;
        energyRecoveryState.phase = "paused";
        energyRecoveryState.lastError = reason;
        energyRecoveryState.retryAfter = retryAfter;
        cleaner.paused = true;
        cleaner.pauseReason = reason;

        const autoLoop =
            w.__AVA_AUTO_CLEAN_LOOP__;
        if (autoLoop) {
            autoLoop.running = false;
            autoLoop.phase = reason;
            autoLoop.energyRecoveryInProgress = false;
        }

        console.error(`[AVA ENERGY] Recovery paused: ${reason}`);
        requestRecoveryCheckpointSave("energy-recovery-paused", true);
        return false;
    }

    async function waitForWorkReturn(mapId, cleaner) {
        return waitForHouseState(() => {
            if (!gameLooksPlayable()) {
                return null;
            }

            const id =
                currentMapId();
            if (id != null && String(id) === String(mapId)) {
                return true;
            }

            try {
                if (discoverCleanableObjects(cleaner.config).length > 0) {
                    return true;
                }
            } catch {}

            return null;
        }, cleaner.config.mapLoadTimeout ?? 30000, 500);
    }

    async function startEnergyRecovery(cleaner, energy = null, restoredState = null) {
        if (energyRecoveryState.inProgress) {
            return false;
        }

        const savedWork =
            restoredState?.savedWork ??
            serializableInterruptedWork(cleaner);

        if (!savedWork.currentMap) {
            return markEnergyRecoveryFailed(cleaner, "energy-recovery-missing-work-map");
        }

        energyRecoveryState.inProgress = true;
        energyRecoveryState.phase = "going-home";
        energyRecoveryState.savedWork = { ...savedWork };
        energyRecoveryState.requestedCount = Number(restoredState?.requestedCount ?? 2);
        energyRecoveryState.eatenCount = Number(restoredState?.eatenCount ?? 0);
        energyRecoveryState.retryAfter = 0;
        energyRecoveryState.lastError = null;

        cleaner.paused = true;
        cleaner.pauseReason = "energy-recovery";
        cleaner._clearTimers();
        cleaner.busy = false;
        cleaner.currentTarget = null;
        cleaner._activeAction = null;
        cleaner._lastScanTargets = [];
        cleaner._recoveryTargetId = savedWork.interruptedTargetId ?? null;
        cleaner._energyInterruptedTargetId = null;

        const autoLoop =
            w.__AVA_AUTO_CLEAN_LOOP__;
        if (autoLoop) {
            autoLoop.phase = "energy-recovery";
            autoLoop.energyRecoveryInProgress = true;
        }

        console.warn(`[AVA ENERGY] Energy below threshold: ${formatEnergy(energy)}`);
        console.log(`[AVA ENERGY] Saving interrupted work: ${savedWork.currentMap}`);
        requestRecoveryCheckpointSave("energy-recovery-start", true);

        console.log(`[AVA HOUSE] Going home: ${HOME_OWNER_ID}`);
        const homeResult =
            await goHouse(HOME_OWNER_ID, HOME_ROOM_ID);

        let loadedFridges = [];
        try {
            loadedFridges = findFridgesInCurrentRoom();
        } catch {}
        const houseContentReady =
            loadedFridges.length > 0 &&
            String(
                w.penzville?.city?.Context?.currentLocation?._gl ?? ""
            ) === String(HOME_OWNER_ID);

        if (
            (!homeResult || homeResult.roomSwitched !== true) &&
            !houseContentReady
        ) {
            return markEnergyRecoveryFailed(cleaner, "house-or-room-timeout");
        }

        if (houseContentReady && homeResult?.roomSwitched !== true) {
            console.log(
                `[AVA HOUSE] Continuing recovery with ${loadedFridges.length} loaded refrigerators`
            );
        }

        energyRecoveryState.phase = "eating";
        const remainingCount = Math.max(
            0,
            energyRecoveryState.requestedCount - energyRecoveryState.eatenCount
        );
        const eatResult =
            await eatAvailable(remainingCount);
        energyRecoveryState.eatenCount += eatResult.eaten;

        console.log(
            `[AVA ENERGY] Ate successfully ${energyRecoveryState.eatenCount}/${energyRecoveryState.requestedCount} times`
        );

        try {
            cleaner.refreshEnergyField();
        } catch {}
        const currentEnergy =
            cleaner.getEnergy();
        if (currentEnergy) {
            console.log(`[AVA ENERGY] Current energy: ${formatEnergy(currentEnergy)}`);
        }

        if (
            energyRecoveryState.eatenCount < energyRecoveryState.requestedCount &&
            (!currentEnergy || currentEnergy.current < MIN_ENERGY_TO_ACT)
        ) {
            const fallbackSeconds = 30 * 60;
            const waitSeconds = Math.max(
                60,
                Number(eatResult.nextReadyInSeconds ?? fallbackSeconds)
            );
            return markEnergyRecoveryFailed(
                cleaner,
                "insufficient-ready-fridges",
                Date.now() + waitSeconds * 1000
            );
        }

        if (currentEnergy && currentEnergy.current < MIN_ENERGY_TO_ACT) {
            return markEnergyRecoveryFailed(
                cleaner,
                "energy-still-low-after-eating",
                Date.now() + 30 * 60 * 1000
            );
        }

        energyRecoveryState.phase = "returning-to-work";
        console.log(`[AVA ENERGY] Returning to ${savedWork.currentMap}`);

        const teleported =
            w.__AVA_GO_WORK__(savedWork.currentMap);
        if (!teleported) {
            return markEnergyRecoveryFailed(cleaner, "work-return-teleport-failed");
        }

        const returned =
            await waitForWorkReturn(savedWork.currentMap, cleaner);
        if (!returned) {
            return markEnergyRecoveryFailed(cleaner, "work-return-timeout");
        }

        cleaner.currentMap = savedWork.currentMap;
        cleaner._mapIndex = savedWork.mapIndex;
        cleaner.busy = false;
        cleaner.currentTarget = null;
        cleaner._activeAction = null;
        cleaner.paused = false;
        cleaner.pauseReason = null;
        cleaner._emptyScans = 0;

        if (autoLoop) {
            autoLoop.cycleMode = savedWork.cycleMode ?? autoLoop.cycleMode;
            autoLoop.nextCycleMode = savedWork.nextCycleMode ?? autoLoop.nextCycleMode;
            autoLoop.running = true;
            autoLoop.phase = "cleaning";
            autoLoop.energyRecoveryInProgress = false;
        }

        energyRecoveryState.inProgress = false;
        energyRecoveryState.phase = "complete";
        energyRecoveryState.retryAfter = 0;
        requestRecoveryCheckpointSave("energy-recovery-complete", true);

        if (isCurrentWorkFinished()) {
            cleaner._skipCurrentWorkArea(
                savedWork.currentMap,
                `[WORK] Zone already completed, skipping: ${savedWork.currentMap}`
            );
        } else {
            cleaner._scheduleScan(0);
        }

        console.log("[AVA ENERGY] Cleaner resumed");
        return true;
    }

    function launchEnergyRecovery(cleaner, energy = null, restoredState = null) {
        return Promise.resolve()
            .then(() => startEnergyRecovery(cleaner, energy, restoredState))
            .catch(error => {
                console.error("[AVA ENERGY] Unexpected recovery error", error);
                return markEnergyRecoveryFailed(
                    cleaner,
                    `energy-recovery-error: ${String(error)}`
                );
            });
    }

    /*
     * ============================================================
     * MAP CLEANER
     * ============================================================
     */

    function cleanerLog(message, data = null) {
        const entry = { time: new Date().toISOString(), message, data };
        state.mapCleanerLogs.push(entry);
        if (state.mapCleanerLogs.length > 300) {
            state.mapCleanerLogs.splice(0, state.mapCleanerLogs.length - 300);
        }
        if (data !== null) {
            console.log(`[AVA CLEANER] ${message}`, data);
        } else {
            console.log(`[AVA CLEANER] ${message}`);
        }
    }

    function cleanerWarn(message, data = null) {
        const entry = { time: new Date().toISOString(), warning: true, message, data };
        state.mapCleanerLogs.push(entry);
        if (state.mapCleanerLogs.length > 300) {
            state.mapCleanerLogs.splice(0, state.mapCleanerLogs.length - 300);
        }
        if (data !== null) {
            console.warn(`[AVA CLEANER] ${message}`, data);
        } else {
            console.warn(`[AVA CLEANER] ${message}`);
        }
    }

    let cachedEnergyRoots = [];
    let cachedEnergyField = null;
    let cachedPickWorkScreen = null;

    function energyDebug(message, data = null) {
        if (data !== null) {
            console.log(`[Energy] ${message}`, data);
        } else {
            console.log(`[Energy] ${message}`);
        }
    }

    function addEnergyRootCandidate(list, value) {
        if (!value || (typeof value !== "object" && typeof value !== "function")) {
            return;
        }

        let root = value;

        try {
            let cursor = value;
            let guard = 0;

            while (
                cursor?.parent &&
                cursor.parent !== cursor &&
                guard < 50
            ) {
                cursor = cursor.parent;
                guard++;
            }

            if (cursor && (typeof cursor === "object" || typeof cursor === "function")) {
                root = cursor;
            }
        } catch {}

        for (const candidate of [root, value]) {
            if (
                candidate &&
                (typeof candidate === "object" || typeof candidate === "function") &&
                !list.includes(candidate)
            ) {
                list.push(candidate);
            }
        }
    }

    function energyRoots() {
        const roots = [];

        try {
            const context =
                w.penzville?.city?.Context ??
                null;

            const hud =
                context?.J ??
                null;

            addEnergyRootCandidate(roots, hud);
            addEnergyRootCandidate(roots, hud?.stage);
            addEnergyRootCandidate(roots, hud?.root);
            addEnergyRootCandidate(roots, hud?.Ele);
            addEnergyRootCandidate(roots, hud?.Ele?.Ey);
            addEnergyRootCandidate(roots, context?.currentLocation?.display);
            addEnergyRootCandidate(roots, context?.currentLocation?.view);
            addEnergyRootCandidate(roots, w.openfl?.Lib?.current?.stage);
            addEnergyRootCandidate(roots, w.openfl?.Lib?.current);
        } catch {}

        return roots;
    }

    function energyTextFormat(text) {
        const value =
            String(text ?? "")
                .trim();

        if (/^\d+\s*\/\s*100$/.test(value)) {
            return "fraction";
        }

        return null;
    }

    function readEnergyText(field) {
        if (!field) {
            return null;
        }

        try {
            const text =
                String(field.text ?? field.__text ?? "")
                    .trim();

            return energyTextFormat(text)
                ? text
                : null;
        } catch {
            return null;
        }
    }

    function logDetectedEnergyFormat(text) {
        if (energyTextFormat(text) === "fraction") {
            energyDebug(`Detected "${text}" format`);
        }
    }

    function parseEnergyText(text) {
        const value =
            String(text ?? "")
                .trim();

        if (energyTextFormat(value) !== "fraction") {
            return null;
        }

        const match =
            value.match(/^(\d+)\s*\/\s*(\d+)$/);

        if (!match) {
            return null;
        }

        const current =
            Number(match[1]);

        const max =
            Number(match[2]);

        if (
            !Number.isFinite(current) ||
            !Number.isFinite(max) ||
            max !== 100 ||
            current < 0 ||
            current > max
        ) {
            return null;
        }

        return {
            current,
            max,
            percent:
                Math.round((current / max) * 100)
        };
    }

    function energyFromField(field) {
        return parseEnergyText(
            readEnergyText(field)
        );
    }

    function energyFieldLooksAttached(field) {
        if (!field || (typeof field !== "object" && typeof field !== "function")) {
            return false;
        }

        if (!readEnergyText(field)) {
            return false;
        }

        try {
            if (field.visible === false) {
                return false;
            }
        } catch {}

        const roots =
            energyRoots();

        if (roots.includes(field)) {
            return true;
        }

        let cursor = field;
        let guard = 0;

        while (cursor && guard < 80) {
            let parent = null;

            try {
                parent =
                    cursor.parent ??
                    cursor.__parent ??
                    null;
            } catch {
                parent = null;
            }

            if (!parent || parent === cursor) {
                break;
            }


            if (roots.includes(parent)) {
                return true;
            }

            cursor = parent;
            guard++;
        }

        return false;
    }

    function pushDisplayChildren(stack, object) {
        let children = null;

        try {
            children =
                object?.__children ??
                object?.children ??
                null;
        } catch {
            children = null;
        }

        if (children && typeof children.length === "number") {
            for (let index = children.length - 1; index >= 0; index--) {
                try {
                    const child =
                        children[index];

                    if (child) {
                        stack.push(child);
                    }
                } catch {}
            }
        }

        try {
            if (
                typeof object?.numChildren === "number" &&
                typeof object?.getChildAt === "function"
            ) {
                for (let index = object.numChildren - 1; index >= 0; index--) {
                    try {
                        const child =
                            object.getChildAt(index);

                        if (child) {
                            stack.push(child);
                        }
                    } catch {}
                }
            }
        } catch {}
    }

    function findEnergyField() {
        if (
            energyFieldLooksAttached(cachedEnergyField) &&
            energyFromField(cachedEnergyField)
        ) {
            return cachedEnergyField;
        }

        if (cachedEnergyField) {
            energyDebug("Cached field detached or invalid, refreshing...");
        }

        cachedEnergyField = null;
        cachedEnergyRoots = energyRoots();

        if (cachedEnergyRoots.length === 0) {
            return null;
        }

        energyDebug("Searching field...");

        const stack =
            cachedEnergyRoots.slice();
        const seen = new WeakSet();
        const maxNodes = 10000;
        let inspected = 0;

        while (stack.length > 0 && inspected < maxNodes) {
            const value =
                stack.pop();

            if (
                !value ||
                (typeof value !== "object" && typeof value !== "function") ||
                seen.has(value)
            ) {
                continue;
            }

            seen.add(value);
            inspected++;

            const text =
                readEnergyText(value);

            if (text) {
                cachedEnergyField = value;
                energyDebug("Field found");
                logDetectedEnergyFormat(text);
                return value;
            }

            pushDisplayChildren(stack, value);
        }

        energyDebug("No X/100 field found; energy check ignored");
        return null;
    }

    function refreshEnergyField() {
        cachedEnergyField = null;
        return findEnergyField();
    }

    function getEnergy() {
        let field =
            cachedEnergyField;

        if (field && !energyFieldLooksAttached(field)) {
            energyDebug("Cached field detached, refreshing...");
            cachedEnergyField = null;
            field = null;
        }

        let energy =
            energyFromField(field);

        if (!energy) {
            field =
                findEnergyField();

            energy =
                energyFromField(field);
        }

        if (energy) {
            energyDebug(`Current: ${energy.current}/${energy.max}`);
        }

        return energy;
    }

    function formatEnergy(energy) {
        if (!energy) {
            return "unknown";
        }

        return `${energy.current}/${energy.max}`;
    }

    function getLocationAvatarClass() {
        try {
            const LocationAvatar = w.penzville?.city?.avatar?.world?.object?.LocationAvatar;
            return typeof LocationAvatar === "function" ? LocationAvatar : null;
        } catch {
            return null;
        }
    }

    function getInteractActionClass() {
        try {
            const InteractAction = w.penzville?.city?.avatar?.world?.action?.InteractAction;
            return typeof InteractAction === "function" ? InteractAction : null;
        } catch {
            return null;
        }
    }

    function createWalkActionToPoint(avatar, point) {
        if (
            !avatar ||
            typeof avatar.addAction !== "function" ||
            typeof state.walkConstructor !== "function"
        ) {
            return null;
        }

        try {
            const destination =
                clonePoint(
                    state.pointTemplate,
                    point.x,
                    point.y
                );

            const action =
                new state.walkConstructor(
                    avatar,
                    state.walkOptions.B3e ??
                        true,
                    null,
                    null
                );

            try {
                action.dest =
                    destination;
            } catch {
                action.y3e =
                    destination;
            }

            return action;
        } catch {
            return null;
        }
    }

    function rememberCurrentAvatar(avatar) {
        try {
            if (!avatar || typeof avatar.addAction !== "function") {
                return false;
            }
            w.__AVA_CURRENT_AVATAR__ = avatar;
            return true;
        } catch {
            return false;
        }
    }

    function installAvatarCapture() {
        const LocationAvatar = getLocationAvatarClass();
        if (!LocationAvatar?.prototype) {
            return false;
        }
        const original = LocationAvatar.prototype.addAction;
        if (typeof original !== "function") {
            return false;
        }
        if (original.__AVA_CLEANER_HOOKED__) {
            return true;
        }
        function wrappedAddAction(action) {
            rememberCurrentAvatar(this);
            return original.apply(this, arguments);
        }
        wrappedAddAction.__AVA_CLEANER_HOOKED__ = true;
        wrappedAddAction.__AVA_ORIGINAL__ = original;
        LocationAvatar.prototype.addAction = wrappedAddAction;
        cleanerLog("LocationAvatar.addAction hook installed");
        return true;
    }

    function uninstallAvatarCapture() {
        const LocationAvatar = getLocationAvatarClass();
        try {
            const addAction = LocationAvatar?.prototype?.addAction;
            if (addAction?.__AVA_ORIGINAL__) {
                LocationAvatar.prototype.addAction = addAction.__AVA_ORIGINAL__;
                return true;
            }
        } catch {}
        return false;
    }

    function objectClassName(object) {
        try {
            return object?.constructor?.name ?? "";
        } catch {
            return "";
        }
    }

    function objectTypeId(object) {
        try {
            return object?.shopItem?.typeId ?? object?.typeId ?? object?.id ?? null;
        } catch {
            return null;
        }
    }

    function isButterflyTarget(object) {
        try {
            return (
                String(objectTypeId(object) ?? "") === "gdBtf" ||
                objectClassName(object) === "WorkFlyObject"
            );
        } catch {
            return false;
        }
    }

    function objectPositionKey(object) {
        const point =
            getObjectPoint(object);

        if (!point) {
            return null;
        }

        return `${String(point.x)},${String(point.y)}`;
    }

    function getObjectPoint(object) {
        try {
            const value =
                object?.position ??
                object?.pos ??
                object?.fe ??
                object;

            const x = Number(
                value?.x ??
                object?.x
            );

            const y = Number(
                value?.y ??
                object?.y
            );

            if (
                !Number.isFinite(x) ||
                !Number.isFinite(y)
            ) {
                return null;
            }

            return { x, y };
        } catch {
            return null;
        }
    }

    function getAvatarPoint() {
        const avatar =
            w.__AVA_CURRENT_AVATAR__;

        const directPoint =
            getObjectPoint(avatar);

        if (directPoint) {
            return directPoint;
        }

        const fallbacks = [
            "position",
            "pos",
            "fe",
            "actor",
            "Eo"
        ];

        for (const key of fallbacks) {
            try {
                const point =
                    getObjectPoint(avatar?.[key]);

                if (point) {
                    return point;
                }
            } catch {}
        }

        return null;
    }

    function distanceSquared(a, b) {
        if (!a || !b) {
            return Infinity;
        }

        const dx = a.x - b.x;
        const dy = a.y - b.y;

        return dx * dx + dy * dy;
    }

    function getRawTargetInteractionPoint(target, avatar) {
        if (typeof target?.getInteractPoint === "function") {
            const expectsArgument =
                target.getInteractPoint.length > 0;

            try {
                return expectsArgument && avatar
                    ? target.getInteractPoint(avatar)
                    : target.getInteractPoint();
            } catch {}
        }

        return null;
    }

    function getTargetInteractionPoint(target, avatar) {
        const rawPoint =
            getRawTargetInteractionPoint(
                target,
                avatar
            );

        const normalized =
            getObjectPoint(rawPoint);

        if (normalized) {
            return normalized;
        }

        return getObjectPoint(target);
    }

    function formatPoint(point) {
        if (!point) {
            return "unknown";
        }

        return `${point.x},${point.y}`;
    }

    function formatDistance(distance) {
        if (!Number.isFinite(distance)) {
            return "Infinity";
        }

        return String(Math.round(distance));
    }

    function stableObjectId(object) {
        const parts = [];
        let hasObjectId = false;
        try {
            if (object?.objectId !== undefined) {
                parts.push(String(object.objectId));
                hasObjectId = true;
            }
        } catch {}
        const typeId = objectTypeId(object);
        if (typeId !== null && typeId !== undefined) {
            parts.push(String(typeId));
        }
        if (hasObjectId) {
            return parts.join("|");
        }

        const position = objectPositionKey(object);
        const className = objectClassName(object);
        if (position) {
            parts.push(position);
        }
        if (className) {
            parts.push(className);
        }
        if (parts.length > 0) {
            return parts.join("|");
        }

        try {
            if (!cleanerObjectIds.has(object)) {
                cleanerObjectIds.set(
                    object,
                    `object:${++cleanerObjectIdCounter}`
                );
            }

            return cleanerObjectIds.get(object);
        } catch {
            return "object:unknown";
        }
    }

    function getCurrentLocation() {
        try {
            return w.penzville?.city?.Context?.currentLocation ?? null;
        } catch {
            return null;
        }
    }

    function currentMapId() {
        try {
            const location = getCurrentLocation();
            return location?.id ?? location?.locationId ?? location?.workLocationId ?? location?.model?.id ?? location?.model?.key ?? null;
        } catch {
            return null;
        }
    }

    function getPickWorkScreenClass() {
        try {
            const PickWorkScreen =
                w.penzville?.city?.work?.ui?.screen?.PickWorkScreen;

            return typeof PickWorkScreen === "function"
                ? PickWorkScreen
                : null;
        } catch {
            return null;
        }
    }

    function pickWorkScreenText(screen) {
        try {
            const field =
                screen?.qde ??
                null;

            if (!field) {
                return null;
            }

            return String(field.text ?? field.__text ?? "").trim();
        } catch {
            return null;
        }
    }

    function pickWorkScreenLooksValid(screen) {
        if (!screen || (typeof screen !== "object" && typeof screen !== "function")) {
            return false;
        }

        const PickWorkScreen =
            getPickWorkScreenClass();

        try {
            if (PickWorkScreen && screen instanceof PickWorkScreen) {
                return Boolean(screen.qde);
            }
        } catch {}

        return pickWorkScreenText(screen) !== null;
    }

    function resetPickWorkScreenCache() {
        cachedPickWorkScreen = null;
    }

    function findPickWorkScreen() {
        if (pickWorkScreenLooksValid(cachedPickWorkScreen)) {
            return cachedPickWorkScreen;
        }

        cachedPickWorkScreen = null;

        const roots =
            energyRoots();
        const stack =
            roots.slice();
        const seen =
            new WeakSet();
        const maxNodes =
            10000;
        let inspected =
            0;

        while (stack.length > 0 && inspected < maxNodes) {
            const value =
                stack.pop();

            if (
                !value ||
                (typeof value !== "object" && typeof value !== "function") ||
                seen.has(value)
            ) {
                continue;
            }

            seen.add(value);
            inspected++;

            if (pickWorkScreenLooksValid(value)) {
                cachedPickWorkScreen = value;
                return value;
            }

            pushDisplayChildren(stack, value);
        }

        return null;
    }

    function normalizeWorkDisplayText(value) {
        try {
            return String(value ?? "")
                .replace(/<[^>]*>/g, " ")
                .replace(/&nbsp;/gi, " ")
                .replace(/[\u00a0\u200b-\u200d\ufeff]/g, " ")
                .replace(/\s+/g, " ")
                .trim();
        } catch {
            return "";
        }
    }

    function workDisplayRoots() {
        const roots = [];

        try {
            roots.push({
                name: "openfl.Lib.current.stage",
                object: w.openfl?.Lib?.current?.stage ?? null
            });
            roots.push({
                name: "Context.J.Ele.Ey",
                object: w.penzville?.city?.Context?.J?.Ele?.Ey ?? null
            });
        } catch {}

        const seen = new WeakSet();
        return roots.filter(entry => {
            const object = entry.object;
            if (
                !object ||
                (typeof object !== "object" && typeof object !== "function") ||
                seen.has(object)
            ) {
                return false;
            }
            seen.add(object);
            return true;
        });
    }

    /*
     * Garden and Yard do not expose the completion message through the
     * same PickWorkScreen hierarchy. Walk the actual OpenFL display roots
     * instead, preserving paths so the runtime traversal can be compared
     * directly with console diagnostics after client updates.
     */
    function findVisibleFinishedWorkText(options = {}) {
        const expectedText = "All work here is finished";
        const debug = options.debug === true;
        const roots = workDisplayRoots();
        const stack = roots.map(entry => ({
            object: entry.object,
            path: entry.name,
            visible: true
        }));
        const visited = new WeakSet();
        const matches = [];
        const maxNodes = 10000;
        let visitedNodes = 0;
        let hiddenBranches = 0;
        let found = null;

        while (stack.length > 0 && visitedNodes < maxNodes) {
            const entry = stack.pop();
            const object = entry.object;

            if (
                !object ||
                (typeof object !== "object" && typeof object !== "function") ||
                visited.has(object)
            ) {
                continue;
            }

            visited.add(object);
            visitedNodes++;

            let visible = entry.visible;
            try {
                if (object.visible === false || Number(object.alpha) === 0) {
                    visible = false;
                }
            } catch {}

            if (!visible) {
                hiddenBranches++;
            }

            for (const property of ["text", "__text", "htmlText"]) {
                let text = "";
                try {
                    text = normalizeWorkDisplayText(object[property]);
                } catch {}

                if (!text) {
                    continue;
                }

                const relevant =
                    text.includes(expectedText) ||
                    /\b(work|finished)\b/i.test(text);

                if (relevant) {
                    const match = {
                        path: entry.path,
                        property,
                        text,
                        visible,
                        object
                    };
                    matches.push(match);

                    if (visible && text.includes(expectedText) && !found) {
                        found = match;
                    }
                }
            }

            let children = null;
            try {
                children = object.__children ?? object.children ?? null;
            } catch {}

            let childCount = 0;
            try {
                childCount = children && typeof children.length === "number"
                    ? children.length
                    : (
                        typeof object.getChildAt === "function"
                            ? Number(object.numChildren ?? 0)
                            : 0
                    );
            } catch {}

            if (!Number.isFinite(childCount) || childCount <= 0) {
                continue;
            }

            for (let index = childCount - 1; index >= 0; index--) {
                try {
                    const child = children && typeof children.length === "number"
                        ? children[index]
                        : object.getChildAt(index);
                    if (child) {
                        stack.push({
                            object: child,
                            path: `${entry.path}.children[${index}]`,
                            visible
                        });
                    }
                } catch {}
            }
        }

        const result = {
            found: Boolean(found),
            visitedNodes,
            hiddenBranches,
            rootNames: roots.map(entry => entry.name),
            match: found,
            matches
        };

        if (debug) {
            console.log(
                `[WORK DEBUG] findVisibleFinishedWorkText() => ${result.found ? "found" : "not found"}; ` +
                `${visitedNodes} nodes visited; ${hiddenBranches} hidden branches`
            );
            console.table(matches.map(match => ({
                path: match.path,
                property: match.property,
                text: match.text,
                visible: match.visible
            })));
        }

        return result;
    }

    function isCurrentWorkFinished() {
        const result = findVisibleFinishedWorkText();
        if (result.found) {
            cleanerLog("[WORK] Finished text found in display tree", {
                path: result.match?.path ?? null,
                property: result.match?.property ?? null,
                visitedNodes: result.visitedNodes
            });
        }
        return result.found;
    }

    function parseShiftCountdown(text) {
        const normalized = normalizeWorkDisplayText(text);
        const match = normalized.match(
            /(?:(\d+):)?(\d{1,2}):(\d{2}) left until the end of this shift/i
        );

        if (!match) {
            return null;
        }

        const hours = Number(match[1] ?? 0);
        const minutes = Number(match[2]);
        const seconds = Number(match[3]);
        if (
            !Number.isFinite(hours) ||
            !Number.isFinite(minutes) ||
            !Number.isFinite(seconds) ||
            minutes >= 60 ||
            seconds >= 60
        ) {
            return null;
        }

        return {
            text: match[0],
            totalSeconds: hours * 3600 + minutes * 60 + seconds
        };
    }

    /*
     * Shift counters are TextFields, but their private text property differs
     * between OpenFL builds. Traverse the same two proven display roots as the
     * work-finished detector and retain the path for runtime diagnostics.
     */
    function findVisibleShiftCountdown() {
        const roots = workDisplayRoots();
        const stack = roots.map(entry => ({
            object: entry.object,
            path: entry.name,
            visible: true
        }));
        const visited = new WeakSet();
        let visitedNodes = 0;

        while (stack.length > 0 && visitedNodes < 10000) {
            const entry = stack.pop();
            const object = entry.object;
            if (
                !object ||
                (typeof object !== "object" && typeof object !== "function") ||
                visited.has(object)
            ) {
                continue;
            }

            visited.add(object);
            visitedNodes++;
            let visible = entry.visible;
            try {
                if (object.visible === false || Number(object.alpha) === 0) {
                    visible = false;
                }
            } catch {}

            if (visible) {
                for (const property of ["text", "__text", "_text", "htmlText", "_htmlText"]) {
                    let parsed = null;
                    try {
                        parsed = parseShiftCountdown(object[property]);
                    } catch {}
                    if (parsed) {
                        const detectedAt = Date.now();
                        const rawReadyAt = detectedAt + parsed.totalSeconds * 1000;
                        const readyAt = Math.ceil(
                            (rawReadyAt + SHIFT_READY_SAFETY_MS) /
                            SHIFT_ALIGNMENT_MS
                        ) * SHIFT_ALIGNMENT_MS;
                        return {
                            ...parsed,
                            detectedAt,
                            rawReadyAt,
                            readyAt,
                            path: `${entry.path}.${property}`,
                            object,
                            visitedNodes
                        };
                    }
                }
            }

            let children = null;
            try {
                children = object.__children ?? object.children ?? null;
            } catch {}
            let childCount = 0;
            try {
                childCount = children && typeof children.length === "number"
                    ? children.length
                    : (
                        typeof object.getChildAt === "function"
                            ? Number(object.numChildren ?? 0)
                            : 0
                    );
            } catch {}
            if (!Number.isFinite(childCount) || childCount <= 0) {
                continue;
            }
            for (let index = childCount - 1; index >= 0; index--) {
                try {
                    const child = children && typeof children.length === "number"
                        ? children[index]
                        : object.getChildAt(index);
                    if (child) {
                        stack.push({
                            object: child,
                            path: `${entry.path}.children[${index}]`,
                            visible
                        });
                    }
                } catch {}
            }
        }

        return null;
    }

    function gameLooksPlayable() {
        try {
            const avatar =
                w.__AVA_CURRENT_AVATAR__;

            const location =
                w.penzville
                    ?.city
                    ?.Context
                    ?.currentLocation;

            return Boolean(
                avatar &&
                typeof avatar.addAction === "function" &&
                location
            );
        } catch {
            return false;
        }
    }

    function hasWorldReference(object) {
        try {
            if (!object || typeof object !== "object" || object.fe == null) {
                return false;
            }
            if (object.parent === null || object.stage === null) {
                return false;
            }
            return true;
        } catch {
            return false;
        }
    }

    function callBooleanMethod(object, methodName) {
        try {
            if (typeof object?.[methodName] !== "function") {
                return true;
            }
            return object[methodName]() !== false;
        } catch {
            return false;
        }
    }

    function hasInteractionBehaviour(object) {
        try {
            return (
                typeof object?.getInteractPoint === "function" &&
                typeof object?.startInteraction === "function" &&
                typeof object?.finishInteraction === "function"
            );
        } catch {
            return false;
        }
    }

    function hasPartialInteractionApi(object) {
        try {
            return (
                typeof object?.getInteractPoint === "function" ||
                typeof object?.startInteraction === "function" ||
                typeof object?.finishInteraction === "function" ||
                typeof object?.readyInteract === "function" ||
                typeof object?.canAddToQueue === "function"
            );
        } catch {
            return false;
        }
    }

    function exactClassOrTypeMatch(object, config) {
        const className = objectClassName(object);
        const typeId = String(objectTypeId(object) ?? "");
        const classes = config.allowedClasses ?? [];
        const typeIds = config.allowedTypeIds ?? [];

        return (
            classes.includes(className) ||
            typeIds.includes(typeId)
        );
    }

    function cleanerMetadataText(object) {
        let objectId = "";

        try {
            objectId = String(object?.objectId ?? "");
        } catch {}

        return [
            objectId,
            objectClassName(object),
            String(objectTypeId(object) ?? "")
        ]
            .map(value => String(value ?? "").toLowerCase())
            .join(" ");
    }

    function excludedKeywordForObject(object, config = w.__AVA_MAP_CLEANER__?.config ?? {}) {
        const keywords =
            config.excludedKeywords ??
            [];

        if (keywords.length === 0) {
            return null;
        }

        const haystack =
            cleanerMetadataText(object);

        for (const keyword of keywords) {
            const normalized =
                String(keyword).toLowerCase();

            if (normalized && haystack.includes(normalized)) {
                return keyword;
            }
        }

        return null;
    }

    function isExcludedObject(object, config = w.__AVA_MAP_CLEANER__?.config ?? {}) {
        try {
            if (excludedKeywordForObject(object, config)) {
                return true;
            }

            const className = objectClassName(object);
            const typeId = String(objectTypeId(object) ?? "");
            let objectId = "";

            try {
                objectId = String(object?.objectId ?? "");
            } catch {}

            return (
                (config.excludedClasses ?? []).includes(className) ||
                (config.excludedTypeIds ?? []).includes(typeId) ||
                (config.excludedObjectIds ?? []).includes(objectId)
            );
        } catch {
            return false;
        }
    }

    function logExcludedObject(object, config = w.__AVA_MAP_CLEANER__?.config ?? {}) {
        const keyword =
            excludedKeywordForObject(object, config);

        if (!keyword) {
            return;
        }

        const targetId =
            stableObjectId(object);

        const key =
            `${targetId}::${String(keyword).toLowerCase()}`;

        if (loggedExcludedCleanerObjects.has(key)) {
            return;
        }

        loggedExcludedCleanerObjects.add(key);

        cleanerLog(`Ignored ${targetId}`);
        cleanerLog(`Reason: excluded keyword "${keyword}"`);
    }

    function cleanerExcluded(object, config = w.__AVA_MAP_CLEANER__?.config ?? {}) {
        return isExcludedObject(object, config);
    }

    function garbageKeywordMatch(object, config) {
        const keywords =
            config.garbageKeywords ??
            [];

        if (keywords.length === 0) {
            return false;
        }

        const haystack = [
            objectClassName(object),
            objectTypeId(object),
            (() => {
                try {
                    return object?.objectId;
                } catch {
                    return "";
                }
            })()
        ]
            .map(value => String(value ?? "").toLowerCase())
            .join(" ");

        return keywords.some(keyword =>
            haystack.includes(String(keyword).toLowerCase())
        );
    }

    function classOrTypeAllowed(object, config) {
        const exactMatch =
            exactClassOrTypeMatch(object, config);

        const behaviourMatch =
            hasInteractionBehaviour(object);

        const mode =
            config.detectionMode ??
            "hybrid";

        if (mode === "strict") {
            return exactMatch;
        }

        if (mode === "behavior") {
            return behaviourMatch;
        }

        return exactMatch || behaviourMatch;
    }

    function candidateRejectionReason(object, config) {
        if (!object || typeof object !== "object") {
            return "not an object";
        }

        if (!hasPartialInteractionApi(object)) {
            return "no interaction API";
        }

        if (cleanerExcluded(object, config)) {
            const keyword = excludedKeywordForObject(object, config);
            return keyword
                ? `excluded keyword "${keyword}"`
                : "excluded by config";
        }

        if (!hasWorldReference(object)) {
            return "detached from world";
        }

        if (!classOrTypeAllowed(object, config)) {
            return "class/type/behaviour not allowed";
        }

        return null;
    }

    function isCleanableObject(object, config) {
        try {
            return candidateRejectionReason(object, config) === null;
        } catch {
            return false;
        }
    }

    function interactionAvailability(object) {
        const readyInteractResult =
            callBooleanMethod(object, "readyInteract");

        const canAddToQueueResult =
            callBooleanMethod(object, "canAddToQueue");

        return {
            readyInteractResult,
            canAddToQueueResult,
            available:
                readyInteractResult &&
                canAddToQueueResult
        };
    }

    function getBugCompletionState(target) {
        if (!target) {
            return {
                known: false,
                completed: false,
                reason: "missing target"
            };
        }

        const typeId =
            String(
                objectTypeId(target) ??
                ""
            );

        if (typeId !== "gdIns") {
            return {
                known: false,
                completed: false,
                reason: "not a gdIns target"
            };
        }

        try {
            if (target.serviced === true) {
                return {
                    known: true,
                    completed: true,
                    reason: "serviced=true"
                };
            }
        } catch {}

        try {
            if (target.She === true || target.She === 1) {
                return {
                    known: true,
                    completed: true,
                    reason: "She indicates serviced"
                };
            }
        } catch {}

        try {
            if (target.serviced === false) {
                return {
                    known: true,
                    completed: false,
                    reason: "serviced=false"
                };
            }
        } catch {}

        try {
            if (target.She === false || target.She === 0) {
                return {
                    known: true,
                    completed: false,
                    reason: "She indicates active"
                };
            }
        } catch {}

        return {
            known: false,
            completed: false,
            reason: "completion state unavailable"
        };
    }

    function inspectInteractionMethods(target) {
        for (const name of [
            "startInteraction",
            "finishInteraction",
            "readyInteract",
            "canAddToQueue"
        ]) {
            try {
                const fn = target?.[name];

                if (typeof fn === "function") {
                    cleanerLog(
                        `${name}:`,
                        fn.toString()
                    );
                }
            } catch {}
        }
    }

    function targetView(target) {
        try {
            return (
                target?.view ??
                target?._view ??
                target?.fe ??
                null
            );
        } catch {
            return null;
        }
    }

    function checkTargetAvailability(target) {
        if (!target) {
            return {
                available: false,
                reason: "missing target"
            };
        }

        const bugState =
            getBugCompletionState(target);

        if (
            bugState.known &&
            bugState.completed
        ) {
            return {
                available: false,
                permanent: true,
                reason:
                    `already squashed: ${bugState.reason}`
            };
        }

        try {
            if (
                typeof target.readyInteract === "function" &&
                target.readyInteract() !== true
            ) {
                return {
                    available: false,
                    reason: "readyInteract returned false"
                };
            }
        } catch {
            return {
                available: false,
                reason: "readyInteract threw an error"
            };
        }

        try {
            if (
                typeof target.canAddToQueue === "function" &&
                target.canAddToQueue() === false
            ) {
                return {
                    available: false,
                    reason: "canAddToQueue returned false"
                };
            }
        } catch {
            return {
                available: false,
                reason: "canAddToQueue threw an error"
            };
        }

        const view =
            targetView(target);

        if (view) {
            try {
                if (view.visible === false) {
                    return {
                        available: false,
                        reason: "target view is hidden"
                    };
                }
            } catch {}

            try {
                if (
                    "parent" in view &&
                    view.parent == null
                ) {
                    return {
                        available: false,
                        reason: "target view is detached"
                    };
                }
            } catch {}
        }

        try {
            if (
                target.disposed === true ||
                target.destroyed === true ||
                target.removed === true ||
                target.deleted === true ||
                target.active === false
            ) {
                return {
                    available: false,
                    reason: "target marked inactive"
                };
            }
        } catch {}

        return {
            available: true,
            reason: null
        };
    }

    function checkButterflyTargetAvailability(target) {
        if (!target) {
            return {
                available: false,
                reason: "missing target"
            };
        }

        const view =
            targetView(target);

        if (view) {
            try {
                if (view.visible === false) {
                    return {
                        available: false,
                        reason: "target view is hidden"
                    };
                }
            } catch {}

            try {
                if (
                    "parent" in view &&
                    view.parent == null
                ) {
                    return {
                        available: false,
                        reason: "target view is detached"
                    };
                }
            } catch {}
        }

        try {
            if (
                target.disposed === true ||
                target.destroyed === true ||
                target.removed === true ||
                target.deleted === true ||
                target.active === false
            ) {
                return {
                    available: false,
                    reason: "target marked inactive"
                };
            }
        } catch {}

        return {
            available: true,
            reason: null
        };
    }

    function cleanerCandidateRow(object, config) {
        const availability =
            interactionAvailability(object);

        const rejectionReason =
            candidateRejectionReason(object, config);

        return {
            objectId: (() => {
                try {
                    return object?.objectId ?? null;
                } catch {
                    return null;
                }
            })(),
            className: objectClassName(object),
            typeId: objectTypeId(object),
            position: objectPositionKey(object),
            hasGetInteractPoint:
                typeof object?.getInteractPoint === "function",
            hasStartInteraction:
                typeof object?.startInteraction === "function",
            hasFinishInteraction:
                typeof object?.finishInteraction === "function",
            hasReadyInteract:
                typeof object?.readyInteract === "function",
            hasCanAddToQueue:
                typeof object?.canAddToQueue === "function",
            readyInteractResult:
                availability.readyInteractResult,
            canAddToQueueResult:
                availability.canAddToQueueResult,
            garbageKeywordMatch:
                garbageKeywordMatch(object, config),
            accepted:
                rejectionReason === null,
            rejectionReason,
            rawObject:
                object
        };
    }

    function cleanerCandidatePriority(object, config) {
        if (isExcludedObject(object, config)) {
            return -Infinity;
        }

        let priority = 0;

        if (exactClassOrTypeMatch(object, config)) {
            priority += 20;
        }

        if (garbageKeywordMatch(object, config)) {
            priority += 10;
        }

        if (hasInteractionBehaviour(object)) {
            priority += 5;
        }

        return priority;
    }

    function collectWorldRoots() {
        const roots = [];
        const location = getCurrentLocation();
        try {
            roots.push(location, location?.world, location?.room, location?.tilespace, location?.display);
            roots.push(w.penzville?.city?.Context?.world, w.penzville?.city?.Context?.room);
        } catch {}
        return roots.filter(Boolean);
    }

    function collectObjectsFromRoot(root, config) {
        const found = [];
        const queue = [{ value: root, depth: 0 }];
        const seen = new WeakSet();
        let seenCount = 0;
        const maxDepth = config.worldScanDepth ?? 5;
        const maxObjects = config.maxWorldScanObjects ?? 6000;
        while (queue.length > 0 && seenCount < maxObjects) {
            const item = queue.shift();
            const value = item.value;
            if (!value || typeof value !== "object" || seen.has(value)) {
                continue;
            }
            seen.add(value);
            seenCount++;
            if (hasPartialInteractionApi(value) && isExcludedObject(value, config)) {
                logExcludedObject(value, config);
                continue;
            }
            if (isCleanableObject(value, config)) {
                found.push(value);
            }
            if (item.depth >= maxDepth) {
                continue;
            }
            if (Array.isArray(value)) {
                for (const child of value.slice(0, 300)) {
                    if (child && typeof child === "object") {
                        queue.push({ value: child, depth: item.depth + 1 });
                    }
                }
                continue;
            }
            let keys = [];
            try {
                keys = Object.getOwnPropertyNames(value).slice(0, 80);
            } catch {
                keys = [];
            }
            for (const key of keys) {
                if (["parent", "stage", "graphics"].includes(key)) {
                    continue;
                }
                try {
                    const child = value[key];
                    if (child && typeof child === "object") {
                        queue.push({ value: child, depth: item.depth + 1 });
                    }
                } catch {}
            }
        }
        return found;
    }

    function uniqueObjects(objects) {
        const seen = new WeakSet();
        const result = [];
        for (const object of objects) {
            if (object && typeof object === "object" && !seen.has(object)) {
                seen.add(object);
                result.push(object);
            }
        }
        return result;
    }

    function discoverCleanableObjects(config) {
        const objects = [];
        for (const root of collectWorldRoots()) {
            objects.push(...collectObjectsFromRoot(root, config));
        }
        return uniqueObjects(objects).sort((left, right) =>
            cleanerCandidatePriority(right, config) -
            cleanerCandidatePriority(left, config)
        );
    }

    function collectInteractionCandidatesFromRoot(root, config) {
        const found = [];
        const queue = [{ value: root, depth: 0 }];
        const seen = new WeakSet();
        let seenCount = 0;
        const maxDepth = config.worldScanDepth ?? 5;
        const maxObjects = config.maxWorldScanObjects ?? 6000;

        while (queue.length > 0 && seenCount < maxObjects) {
            const item = queue.shift();
            const value = item.value;

            if (!value || typeof value !== "object" || seen.has(value)) {
                continue;
            }

            seen.add(value);
            seenCount++;

            if (hasPartialInteractionApi(value)) {
                found.push(value);
            }

            if (item.depth >= maxDepth) {
                continue;
            }

            if (Array.isArray(value)) {
                for (const child of value.slice(0, 300)) {
                    if (child && typeof child === "object") {
                        queue.push({ value: child, depth: item.depth + 1 });
                    }
                }

                continue;
            }

            let keys = [];

            try {
                keys = Object.getOwnPropertyNames(value).slice(0, 80);
            } catch {
                keys = [];
            }

            for (const key of keys) {
                if (["parent", "stage", "graphics"].includes(key)) {
                    continue;
                }

                try {
                    const child = value[key];

                    if (child && typeof child === "object") {
                        queue.push({ value: child, depth: item.depth + 1 });
                    }
                } catch {}
            }
        }

        return found;
    }

    function inspectCleanerCandidates(config) {
        const objects = [];

        for (const root of collectWorldRoots()) {
            objects.push(...collectInteractionCandidatesFromRoot(root, config));
        }

        return uniqueObjects(objects).map(object =>
            cleanerCandidateRow(object, config)
        );
    }

    function avatarHasAction(avatar, action, depth = 0, seen = new WeakSet()) {
        if (!avatar || !action || depth > 3 || typeof avatar !== "object") {
            return false;
        }
        if (seen.has(avatar)) {
            return false;
        }
        seen.add(avatar);
        if (avatar === action) {
            return true;
        }
        let keys = [];
        try {
            keys = Object.getOwnPropertyNames(avatar).slice(0, 80);
        } catch {
            return false;
        }
        for (const key of keys) {
            try {
                const value = avatar[key];
                if (value === action) {
                    return true;
                }
                if (value && typeof value === "object" && avatarHasAction(value, action, depth + 1, seen)) {
                    return true;
                }
            } catch {}
        }
        return false;
    }

    function installFinishInteractionWatch(target, cleaner, token) {
        try {
            if (typeof target.finishInteraction !== "function") {
                return false;
            }
            if (target.finishInteraction.__AVA_CLEANER_WRAPPED__) {
                return true;
            }
            const original = target.finishInteraction;
            function wrappedFinishInteraction() {
                const result = original.apply(this, arguments);

                setTimeout(() => {
                    try {
                        cleaner._completeInteraction(
                            token,
                            "finishInteraction",
                            true
                        );
                    } catch {}
                }, 100);

                return result;
            }
            wrappedFinishInteraction.__AVA_CLEANER_WRAPPED__ = true;
            wrappedFinishInteraction.__AVA_ORIGINAL__ = original;
            target.finishInteraction = wrappedFinishInteraction;
            cleaner._wrappedTargets.push(target);
            return true;
        } catch {
            return false;
        }
    }

    function restoreFinishInteractionWatch(target) {
        try {
            if (target?.finishInteraction?.__AVA_ORIGINAL__) {
                target.finishInteraction = target.finishInteraction.__AVA_ORIGINAL__;
                return true;
            }
        } catch {}
        return false;
    }

    function initializeMapCleaner() {
        installAvatarCapture();

        const cleaner = {
            config: {
                maps: ["garbage"],
                detectionMode: "hybrid",
                allowedClasses: ["GarbageObject"],
                allowedTypeIds: ["gbTrashEnrg"],
                garbageKeywords: ["garbage", "trash", "rubbish", "waste", "gbtrash"],
                excludedClasses: [],
                excludedTypeIds: [],
                excludedObjectIds: [],
                excludedKeywords: ["sit", "exit"],
                temporaryUnavailableDelay: 1500,
                fullRescanInterval: 1000,
                maxUnavailableScans: 5,
                maxUnavailableDuration: 8000,
                targetSelectionMode: "nearest",
                interactionTimeout: 40000,
                scanDelay: 500,
                emptyScansRequired: 3,
                emptyScanInterval: 1000,
                mapLoadTimeout: 30000,
                mapStableMs: 2500,
                pickWorkScreenTimeout: 5000,
                pickWorkScreenPollMs: 250,
                pickWorkScreenTextStableMs: 750,
                maxRetriesPerObject: 3,
                butterflyMaxAttempts: AVA_BUTTERFLY_MAX_ATTEMPTS,
                yardMaxRetriesPerObject: AVA_YARD_MAX_RETRIES_PER_OBJECT,
                yardInteractionTimeout: AVA_YARD_INTERACTION_TIMEOUT_MS,
                yardSkippedReloads: 1,
                workAreaSkippedReloads: 1,
                worldScanDepth: 5,
                maxWorldScanObjects: 6000,
                debugInteractionMethods: false,
                butterflyReadyPollMs: 150,
                butterflyMoveRefreshMs: 800,
                butterflyAttemptWindowMs: 15000,
                butterflySwitchDelayMs: 750,
                butterflyFullCaptureTimeoutMs: 60000
            },
            running: false,
            paused: false,
            pauseReason: null,
            busy: false,
            currentMap: null,
            currentTarget: null,
            cleanedObjects: 0,
            failedObjects: 0,
            visitedMaps: [],
            interactionToken: 0,
            remainingTargets: 0,
            totalAttempts: 0,
            startedAt: 0,
            _mapIndex: 0,
            _emptyScans: 0,
            _timers: [],
            _attempts: new Map(),
            _skippedObjects: new Set(),
            _completedObjects: new Set(),
            _inactiveObjects: new Set(),
            _pendingObjects: new Map(),
            _loggedBugStates: new Set(),
            _debuggedInteractionMethods: new Set(),
            _wrappedTargets: [],
            _activeAction: null,
            _activeManualPromise: null,
            _lastScanTargets: [],
            _yardSkippedReloadCount: 0,
            _yardNeedsReloadForSkippedObjects: false,
            _workAreaReloadCounts: new Map(),
            _workAreaNeedsReloadForSkippedObjects: false,
            _recoveryTargetId: null,
            _restoredRecoveryState: null,
            _energyInterruptedTargetId: null,
            _shiftAdvancePending: false,

            start(options = {}) {
                if (this.running) {
                    cleanerWarn("Already running");
                    return false;
                }
                Object.assign(this.config, options ?? {});
                installAvatarCapture();
                this.running = true;
                this.paused = false;
                this.pauseReason = null;
                this.busy = false;
                this.currentTarget = null;
                this.cleanedObjects = 0;
                this.failedObjects = 0;
                this.visitedMaps = [];
                this.interactionToken = 0;
                this.remainingTargets = 0;
                this.totalAttempts = 0;
                this.startedAt = performance.now();
                this._mapIndex = 0;
                this._emptyScans = 0;
                this._attempts = new Map();
                this._skippedObjects = new Set();
                this._completedObjects = new Set();
                this._inactiveObjects = new Set();
                this._pendingObjects = new Map();
                this._loggedBugStates = new Set();
                this._debuggedInteractionMethods = new Set();
                this._activeManualPromise = null;
                this._lastScanTargets = [];
                this._yardSkippedReloadCount = 0;
                this._yardNeedsReloadForSkippedObjects = false;
                this._workAreaReloadCounts = new Map();
                this._workAreaNeedsReloadForSkippedObjects = false;
                this._energyInterruptedTargetId = null;
                this._shiftAdvancePending = false;
                cleanerLog("Started");
                requestRecoveryCheckpointSave("cleaner-start", true);
                this._moveToConfiguredMap();
                return true;
            },

            stop() {
                this.running = false;
                this.paused = false;
                this.pauseReason = null;
                this._clearTimers();
                this._restoreWrappedTargets();
                this._rejectManualInteraction("cleaner stopped");
                this.remainingTargets = 0;
                cleanerLog("Stopped", this._summary());
                requestRecoveryCheckpointSave("cleaner-stop", true);
                return this.status();
            },

            pause(reason = "manual") {
                this.paused = true;
                this.pauseReason = reason;
                cleanerLog(reason === "energy" ? "Paused: energy" : "Paused");
                requestRecoveryCheckpointSave("cleaner-pause", true);
                return this.status();
            },

            resume() {
                if (!this.running) {
                    return false;
                }

                const energy =
                    this.getEnergy();

                if (
                    energy &&
                    energy.current < MIN_ENERGY_TO_ACT
                ) {
                    cleanerWarn(`Cannot resume: energy is still ${formatEnergy(energy)}.`);
                    this.paused = true;
                    this.pauseReason = "energy";
                    return this.status();
                }

                if (!this.paused) {
                    return this.status();
                }

                this.paused = false;
                this.pauseReason = null;
                this._emptyScans = 0;
                cleanerLog(energy ? `Energy restored: ${formatEnergy(energy)}. Resuming.` : "Resumed");
                requestRecoveryCheckpointSave("cleaner-resume", true);
                this._scheduleScan(0);
                return this.status();
            },

            resumeFromRecovery(checkpoint) {
                const mapId = String(checkpoint?.cleaner?.currentMap ?? "");
                const maps = Array.isArray(checkpoint?.autoLoop?.maps)
                    ? checkpoint.autoLoop.maps.map(String)
                    : [];
                if (!mapId || !maps.includes(mapId)) {
                    cleanerWarn("Recovery checkpoint has no valid current map");
                    return false;
                }

                this._clearTimers();
                this._restoreWrappedTargets();
                this.config.maps = maps.slice();
                this._mapIndex = Number(checkpoint.autoLoop.mapIndex ?? maps.indexOf(mapId));
                if (!Number.isInteger(this._mapIndex) || maps[this._mapIndex] !== mapId) {
                    this._mapIndex = maps.indexOf(mapId);
                }
                this.visitedMaps = maps.slice(0, this._mapIndex);
                this.running = true;
                this.paused = false;
                this.pauseReason = null;
                this.busy = false;
                this.currentTarget = null;
                this.currentMap = mapId;
                this.startedAt = performance.now();
                this._activeAction = null;
                this._activeManualPromise = null;
                this._timers = [];
                this._wrappedTargets = [];
                this._recoveryTargetId = checkpoint.cleaner.currentTargetId ?? null;
                this._restoredRecoveryState = {
                    completed: new Set(checkpoint.cleaner.completedObjectIds ?? []),
                    skipped: new Set(checkpoint.cleaner.skippedObjectIds ?? []),
                    inactive: new Set(checkpoint.cleaner.inactiveObjectIds ?? []),
                    attempts: new Map(checkpoint.cleaner.attemptEntries ?? [])
                };
                cleanerLog(`[AVA RECOVERY] Teleporting back to ${mapId}`);
                this._moveToConfiguredMap();
                return true;
            },

            status() {
                const energy =
                    this.getEnergy();

                return {
                    running: this.running,
                    paused: this.paused,
                    pauseReason: this.pauseReason,
                    busy: this.busy,
                    currentMap: this.currentMap,
                    currentTarget: this.currentTarget ? stableObjectId(this.currentTarget) : null,
                    cleanedObjects: this.cleanedObjects,
                    failedObjects: this.failedObjects,
                    remainingTargets: this.remainingTargets,
                    queueLength: this.remainingTargets,
                    pendingTargets: this._pendingObjects.size,
                    inactiveTargets: this._inactiveObjects.size,
                    targetSelectionMode: this.config.targetSelectionMode,
                    avatarPoint: getAvatarPoint(),
                    visitedMaps: this.visitedMaps.slice(),
                    interactionToken: this.interactionToken,
                    totalAttempts: this.totalAttempts,
                    energy,
                    durationMs: this.startedAt ? Math.round(performance.now() - this.startedAt) : 0
                };
            },

            getStatus() {
                return this.status();
            },

            findEnergyField() {
                return findEnergyField();
            },

            refreshEnergyField() {
                const field =
                    refreshEnergyField();

                cleanerLog(
                    "Energy field refreshed",
                    {
                        field,
                        energy:
                            this.getEnergy()
                    }
                );

                return field;
            },

            getEnergy() {
                return getEnergy();
            },

            _isEnergyPaused() {
                return (
                    this.paused === true &&
                    this.pauseReason === "energy"
                );
            },

            inspectCandidates() {
                const rows = inspectCleanerCandidates(this.config);
                const accepted = rows.filter(row => row.accepted).length;

                console.log(
                    `[AVA CLEANER] ${rows.length} garbage candidates discovered`
                );
                console.log(`[AVA CLEANER] ${accepted} accepted`);
                console.log(
                    `[AVA CLEANER] ${rows.length - accepted} permanently rejected`
                );
                console.table(rows.map(row => ({
                    objectId: row.objectId,
                    className: row.className,
                    typeId: row.typeId,
                    position: row.position,
                    hasGetInteractPoint: row.hasGetInteractPoint,
                    hasStartInteraction: row.hasStartInteraction,
                    hasFinishInteraction: row.hasFinishInteraction,
                    hasReadyInteract: row.hasReadyInteract,
                    hasCanAddToQueue: row.hasCanAddToQueue,
                    readyInteractResult: row.readyInteractResult,
                    canAddToQueueResult: row.canAddToQueueResult,
                    accepted: row.accepted,
                    rejectionReason: row.rejectionReason,
                    rawObject: row.rawObject
                })));

                return rows;
            },

            listDetectedTypes() {
                const counts = new Map();
                const rows = inspectCleanerCandidates(this.config)
                    .filter(row => row.accepted);

                for (const row of rows) {
                    const key = `${row.className || "(unknown)"}::${String(row.typeId ?? "")}`;
                    const existing = counts.get(key) ?? {
                        className: row.className || "(unknown)",
                        typeId: row.typeId,
                        count: 0
                    };

                    existing.count++;
                    counts.set(key, existing);
                }

                const table = Array.from(counts.values());
                console.table(table);
                return table;
            },

            catchNearestButterfly(options = {}) {
                if (this.busy) {
                    return Promise.reject(
                        new Error("Interaction already running")
                    );
                }

                const target =
                    this._findNearestButterfly(options);

                if (!target) {
                    return Promise.reject(
                        new Error("No valid butterfly found")
                    );
                }

                return this._captureButterflyTarget(target);
            },

            _captureButterflyTarget(target) {
                return new Promise((resolve, reject) => {
                    const started =
                        this._startButterflyInteraction(
                            target,
                            {
                                manual: true,
                                resolve,
                                reject
                            }
                        );

                    if (!started) {
                        this._activeManualPromise = null;

                        if (this._isEnergyPaused()) {
                            reject(
                                new Error("Butterfly capture paused: not enough energy")
                            );
                            return;
                        }

                        reject(
                            new Error("Unable to start butterfly capture")
                        );
                    }
                });
            },

            testButterfly() {
                cleanerLog("Testing full butterfly capture");
                this._resetButterflyState();
                return this._captureAllButterflies();
            },

            inspectInteractionMethods(targetOrId) {
                let target =
                    targetOrId;

                if (typeof targetOrId === "string") {
                    const rows =
                        inspectCleanerCandidates(this.config);

                    const match =
                        rows.find(row =>
                            stableObjectId(row.rawObject) === targetOrId ||
                            String(row.objectId ?? "") === targetOrId
                        );

                    target =
                        match?.rawObject ??
                        null;
                }

                if (!target) {
                    cleanerWarn("No target found for inspectInteractionMethods");
                    return false;
                }

                inspectInteractionMethods(target);
                return true;
            },

            getRawCandidate(targetId) {
                const rows =
                    inspectCleanerCandidates(this.config);

                const match =
                    rows.find(row =>
                        stableObjectId(row.rawObject) === targetId ||
                        String(row.objectId ?? "") === String(targetId)
                    );

                return match?.rawObject ?? null;
            },

            uninstall() {
                this.stop();
                uninstallAvatarCapture();
                return true;
            },

            _summary() {
                return {
                    mapsCleaned: this.visitedMaps.slice(),
                    objectsSucceeded: this.cleanedObjects,
                    completedObjects: this._completedObjects.size,
                    objectsSkipped: this.failedObjects,
                    attempts: this.totalAttempts,
                    durationMs: this.startedAt ? Math.round(performance.now() - this.startedAt) : 0
                };
            },

            _logEnergyBeforeAction() {
                const energy =
                    this.getEnergy();

                if (energy) {
                    cleanerLog(`Energy: ${formatEnergy(energy)}`);
                }

                return energy;
            },

            _logEnergyAfterAction() {
                const energy =
                    this.getEnergy();

                if (energy) {
                    cleanerLog(`Energy after action: ${formatEnergy(energy)}`);
                }

                return energy;
            },

            _pauseForEnergy(energy = this.getEnergy(), target = null) {
                this.paused = true;
                this._energyInterruptedTargetId = target
                    ? stableObjectId(target)
                    : this._energyInterruptedTargetId;
                const autoLoop = w.__AVA_AUTO_CLEAN_LOOP__;

                if (autoLoop?.enabled) {
                    this.pauseReason = "energy-recovery";
                    cleanerWarn(`Not enough energy: ${formatEnergy(energy)}. Starting home recovery.`);
                    setTimeout(() => {
                        launchEnergyRecovery(this, energy);
                    }, 0);
                    return false;
                }

                this.pauseReason = "energy";
                cleanerWarn(`Not enough energy: ${formatEnergy(energy)}. Bot paused.`);
                return false;
            },

            _canStartEnergyAction(target = null) {
                const energy =
                    this._logEnergyBeforeAction();

                if (
                    energy &&
                    energy.current < MIN_ENERGY_TO_ACT
                ) {
                    return this._pauseForEnergy(energy, target);
                }

                return true;
            },

            _rejectManualInteraction(reason) {
                const manual =
                    this._activeManualPromise;

                if (!manual) {
                    return;
                }

                this._activeManualPromise = null;

                try {
                    manual.reject(
                        new Error(reason)
                    );
                } catch {}
            },

            _setTimer(callback, delay) {
                const timer = setTimeout(() => {
                    this._timers = this._timers.filter(item => item !== timer);
                    callback();
                }, delay);
                this._timers.push(timer);
                return timer;
            },

            _clearTimers() {
                for (const timer of this._timers) {
                    clearTimeout(timer);
                }
                this._timers.length = 0;
            },

            _restoreWrappedTargets() {
                for (const target of this._wrappedTargets.splice(0)) {
                    restoreFinishInteractionWatch(target);
                }
            },

            _moveToConfiguredMap() {
                if (!this.running) {
                    return;
                }
                if (this._mapIndex >= this.config.maps.length) {
                    this.running = false;
                    this.busy = false;
                    this.currentTarget = null;
                    cleanerLog("All maps completed", this._summary());
                    return;
                }
                const mapId = this.config.maps[this._mapIndex];
                const previousAvatar = w.__AVA_CURRENT_AVATAR__ ?? null;
                this.currentMap = mapId;
                this.currentTarget = null;
                this.busy = false;
                this._emptyScans = 0;
                this._attempts = new Map();
                this._skippedObjects = new Set();
                this._completedObjects = new Set();
                this._inactiveObjects = new Set();
                this._pendingObjects = new Map();
                this._loggedBugStates = new Set();
                this._debuggedInteractionMethods = new Set();
                this._activeManualPromise = null;
                this._lastScanTargets = [];
                this._yardNeedsReloadForSkippedObjects = false;
                this._workAreaNeedsReloadForSkippedObjects = false;
                if (this._restoredRecoveryState) {
                    this._completedObjects = this._restoredRecoveryState.completed;
                    this._skippedObjects = this._restoredRecoveryState.skipped;
                    this._inactiveObjects = this._restoredRecoveryState.inactive;
                    this._attempts = this._restoredRecoveryState.attempts;
                    this._restoredRecoveryState = null;
                }
                this._restoreWrappedTargets();
                resetPickWorkScreenCache();
                cleanerLog(`Moving to ${mapId}`);
                requestRecoveryCheckpointSave("cleaner-map-change", true);
                if (typeof w.__AVA_GO_WORK__ === "function") {
                    w.__AVA_GO_WORK__(mapId);
                }
                this._waitForMapLoad(mapId, previousAvatar, performance.now());
            },

            _waitForMapLoad(mapId, previousAvatar, startedAt) {
                if (!this.running) {
                    return;
                }
                installAvatarCapture();
                const avatar = w.__AVA_CURRENT_AVATAR__ ?? null;
                const targets = discoverCleanableObjects(this.config);
                const mapMatches = currentMapId() === null || currentMapId() === mapId;
                const avatarChanged = avatar && avatar !== previousAvatar;
                const hasObjects = targets.length > 0;
                if (mapMatches && (avatarChanged || hasObjects)) {
                    this._setTimer(() => {
                        const stableTargets = discoverCleanableObjects(this.config);
                        const stableAvatar = w.__AVA_CURRENT_AVATAR__ ?? null;
                        if (this.running && stableAvatar && (stableTargets.length > 0 || stableAvatar !== previousAvatar)) {
                            cleanerLog(`Map loaded: ${mapId}`);
                            this._waitForWorkFinishedOrScan(mapId, performance.now());
                        } else {
                            this._waitForMapLoad(mapId, previousAvatar, startedAt);
                        }
                    }, this.config.mapStableMs);
                    return;
                }
                if (performance.now() - startedAt > this.config.mapLoadTimeout) {
                    cleanerWarn(`Map load timeout: ${mapId}`);
                    this._waitForWorkFinishedOrScan(mapId, performance.now());
                    return;
                }
                this._setTimer(() => this._waitForMapLoad(mapId, previousAvatar, startedAt), 500);
            },

            _skipCurrentWorkArea(mapId, reason) {
                if (this._shiftAdvancePending) {
                    return;
                }
                const activeTarget = this.currentTarget;
                this.interactionToken++;
                this._clearTimers();
                if (activeTarget) {
                    restoreFinishInteractionWatch(activeTarget);
                }
                this._activeAction = null;
                this._rejectManualInteraction("work area already finished");
                this.busy = false;
                this.currentTarget = null;
                this._emptyScans = 0;
                cleanerLog(reason || `[WORK] Zone already completed, skipping: ${mapId}`);
                cleanerLog(`[AVA SHIFT] ${mapId} already finished`);
                this._recordShiftAndAdvance(mapId);
            },

            _recordShiftAndAdvance(mapId) {
                if (this._shiftAdvancePending) {
                    return;
                }
                this._shiftAdvancePending = true;
                this.busy = true;
                const autoLoop = w.__AVA_AUTO_CLEAN_LOOP__;
                const capture = autoLoop?.captureMapAvailability
                    ? autoLoop.captureMapAvailability(mapId, {
                        timeoutMs: SHIFT_COUNTDOWN_TIMEOUT_MS
                    })
                    : Promise.resolve(null);

                Promise.resolve(capture).finally(() => {
                    if (!this.running) {
                        this._shiftAdvancePending = false;
                        this.busy = false;
                        return;
                    }
                    if (!this.visitedMaps.includes(mapId)) {
                        this.visitedMaps.push(mapId);
                    }
                    this._shiftAdvancePending = false;
                    this.busy = false;
                    this._mapIndex++;
                    this._moveToConfiguredMap();
                });
            },

            _waitForWorkFinishedOrScan(mapId) {
                if (!this.running) {
                    return;
                }

                if (isCurrentWorkFinished()) {
                    if (crashRecoveryState.recoveryInProgress) {
                        cleanerLog(`[AVA RECOVERY] Recovered zone ${mapId} is already finished; skipping`);
                        finishCrashRecovery();
                    }
                    this._skipCurrentWorkArea(
                        mapId,
                        `[WORK] Zone already completed, skipping: ${mapId}`
                    );
                    return;
                }

                if (crashRecoveryState.recoveryInProgress) {
                    cleanerLog("[AVA RECOVERY] Rescanning interrupted zone");
                    finishCrashRecovery();
                }

                w.__AVA_AUTO_CLEAN_LOOP__?.captureMapAvailability?.(mapId, {
                    timeoutMs: 0,
                    useFallback: false
                });

                this._scheduleScan(0);
            },

            _scheduleScan(delay = this.config.scanDelay) {
                if (!this.running) {
                    return;
                }
                this._setTimer(() => this._scanAndRun(), delay);
            },

            _skipIfCurrentWorkFinished(source) {
                if (!isCurrentWorkFinished()) {
                    return false;
                }
                const mapId =
                    this.currentMap ??
                    this.config.maps[this._mapIndex];
                cleanerLog(
                    `[WORK] ${mapId} finished during ${source}; cancelling active target`
                );
                this._skipCurrentWorkArea(
                    mapId,
                    `[WORK] Zone already completed, skipping: ${mapId}`
                );
                return true;
            },

            _rankAvailableTargets(targets) {
                const avatar =
                    w.__AVA_CURRENT_AVATAR__ ??
                    null;

                const avatarPoint =
                    getAvatarPoint();

                const rankedTargets = targets.map(target => {
                    const point =
                        getTargetInteractionPoint(
                            target,
                            avatar
                        );

                    return {
                        target,
                        point,
                        distance:
                            distanceSquared(
                                avatarPoint,
                                point
                            )
                    };
                });

                if (this.config.targetSelectionMode === "discovery-order") {
                    return this._prioritizeRecoveryTarget(rankedTargets);
                }

                return this._prioritizeRecoveryTarget(rankedTargets.sort(
                    (left, right) =>
                        left.distance - right.distance
                ));
            },

            _prioritizeRecoveryTarget(rankedTargets) {
                if (!this._recoveryTargetId) return rankedTargets;
                return rankedTargets.sort((left, right) => {
                    const leftMatches = stableObjectId(left.target) === this._recoveryTargetId;
                    const rightMatches = stableObjectId(right.target) === this._recoveryTargetId;
                    return leftMatches === rightMatches ? 0 : (leftMatches ? -1 : 1);
                });
            },

            _resetButterflyState() {
                const targets =
                    discoverCleanableObjects(this.config)
                        .filter(isButterflyTarget);

                for (const target of targets) {
                    const targetId =
                        stableObjectId(target);

                    this._completedObjects.delete(targetId);
                    this._skippedObjects.delete(targetId);
                    this._inactiveObjects.delete(targetId);
                    this._pendingObjects.delete(targetId);
                    this._attempts.delete(targetId);
                }

                cleanerLog(`Butterfly test state reset: ${targets.length} candidate${targets.length === 1 ? "" : "s"}`);
            },

            _deferButterflyTarget(targetId, target, reason) {
                if (!targetId) {
                    return;
                }

                const now =
                    Date.now();

                const previous =
                    this._pendingObjects.get(targetId);

                this._pendingObjects.set(
                    targetId,
                    {
                        target,
                        reason:
                            reason || "butterfly temporarily unavailable",
                        firstSeenAt:
                            previous?.firstSeenAt ??
                            now,
                        lastSeenAt:
                            now,
                        unavailableCount:
                            (previous?.unavailableCount ?? 0) + 1,
                        retryAfter:
                            now + this.config.butterflySwitchDelayMs
                    }
                );

                cleanerLog(
                    `Butterfly deferred ${targetId}`,
                    reason || "temporarily unavailable"
                );
            },

            _captureAllButterflies() {
                const targets =
                    discoverCleanableObjects(this.config)
                        .filter(target =>
                            isButterflyTarget(target) &&
                            !isExcludedObject(target, this.config) &&
                            isCleanableObject(target, this.config) &&
                            checkButterflyTargetAvailability(target).available
                        );

                const targetIds =
                    Array.from(
                        new Set(
                            targets.map(stableObjectId)
                        )
                    );

                cleanerLog(`${targetIds.length} butterfly candidate${targetIds.length === 1 ? "" : "s"} found`);

                if (targetIds.length === 0) {
                    return Promise.reject(
                        new Error("No valid butterfly found")
                    );
                }

                const startedAt =
                    performance.now();

                const failedRound =
                    new Set();
                const butterflyAttempts =
                    new Map();

                const captureNext = () => {
                    if (this._isEnergyPaused()) {
                        return Promise.reject(
                            new Error("Butterfly capture paused: not enough energy")
                        );
                    }

                    const remainingIds =
                        targetIds.filter(targetId =>
                            !this._completedObjects.has(targetId)
                        );

                    if (remainingIds.length === 0) {
                        return Promise.resolve({
                            completed: targetIds.slice(),
                            count: targetIds.length
                        });
                    }

                    if (
                        performance.now() - startedAt >
                        this.config.butterflyFullCaptureTimeoutMs
                    ) {
                        return Promise.reject(
                            new Error("Butterfly full capture timeout")
                        );
                    }

                    let target =
                        this._findNearestButterfly({
                            targetIds: remainingIds,
                            excludeIds: failedRound
                        });

                    if (!target && failedRound.size > 0) {
                        failedRound.clear();
                        target =
                            this._findNearestButterfly({
                                targetIds: remainingIds
                            });
                    }

                    if (!target) {
                        cleanerLog("No retryable butterfly currently available; waiting before retry");

                        return new Promise((resolve, reject) => {
                            this._setTimer(
                                () => {
                                    captureNext()
                                        .then(resolve)
                                        .catch(reject);
                                },
                                this.config.butterflySwitchDelayMs
                            );
                        });
                    }

                    const targetId =
                        stableObjectId(target);
                    const attempt =
                        (butterflyAttempts.get(targetId) ?? 0) + 1;
                    const maxAttempts =
                        Math.max(
                            1,
                            Number(this.config.butterflyMaxAttempts ?? 3)
                        );

                    if (attempt > maxAttempts) {
                        cleanerWarn(
                            `Butterfly max attempts reached: ${targetId} (${maxAttempts})`
                        );
                        failedRound.add(targetId);

                        if (remainingIds.every(id => failedRound.has(id))) {
                            return Promise.reject(
                                new Error("Butterfly max attempts reached")
                            );
                        }

                        return new Promise((resolve, reject) => {
                            this._setTimer(
                                () => {
                                    captureNext()
                                        .then(resolve)
                                        .catch(reject);
                                },
                                this.config.butterflySwitchDelayMs
                            );
                        });
                    }

                    butterflyAttempts.set(targetId, attempt);

                    cleanerLog(
                        `Trying butterfly ${targetId} (${targetIds.length - remainingIds.length + 1}/${targetIds.length}, attempt ${attempt}/${maxAttempts})`
                    );

                    return this._captureButterflyTarget(target)
                        .then(result => {
                            if (this._isEnergyPaused()) {
                                return Promise.reject(
                                    new Error("Butterfly capture paused: not enough energy")
                                );
                            }

                            if (result?.completed === true) {
                                failedRound.delete(targetId);
                            } else {
                                failedRound.add(targetId);
                                this._deferButterflyTarget(
                                    targetId,
                                    target,
                                    result?.reason || "butterfly retry needed"
                                );
                            }

                            return new Promise(resolve => {
                                this._setTimer(
                                    () => resolve(captureNext()),
                                    this.config.butterflySwitchDelayMs
                                );
                            });
                        })
                        .catch(error => {
                            if (this._isEnergyPaused()) {
                                return Promise.reject(
                                    new Error("Butterfly capture paused: not enough energy")
                                );
                            }

                            cleanerWarn(`Butterfly attempt failed: ${targetId}`, error);
                            failedRound.add(targetId);
                            this._deferButterflyTarget(
                                targetId,
                                target,
                                error?.message || "butterfly attempt failed"
                            );

                            return new Promise((resolve, reject) => {
                                this._setTimer(
                                    () => {
                                        captureNext()
                                            .then(resolve)
                                            .catch(reject);
                                    },
                                    this.config.butterflySwitchDelayMs
                                );
                            });
                        });
                };

                return captureNext();
            },

            _findNearestButterfly(options = {}) {
                const ignoreCleanerState =
                    options.ignoreCleanerState === true;
                const targetIds =
                    options.targetIds instanceof Set
                        ? options.targetIds
                        : new Set(options.targetIds ?? []);
                const excludeIds =
                    options.excludeIds instanceof Set
                        ? options.excludeIds
                        : new Set(options.excludeIds ?? []);

                const targets =
                    discoverCleanableObjects(this.config)
                        .filter(target => {
                            const targetId =
                                stableObjectId(target);
                            const pending =
                                this._pendingObjects.get(targetId);
                            const pendingReady =
                                !pending ||
                                !pending.retryAfter ||
                                Date.now() >= pending.retryAfter;

                            return (
                                isButterflyTarget(target) &&
                                (
                                    targetIds.size === 0 ||
                                    targetIds.has(targetId)
                                ) &&
                                !excludeIds.has(targetId) &&
                                pendingReady &&
                                (
                                    ignoreCleanerState ||
                                    (
                                        !this._completedObjects.has(targetId) &&
                                        !this._skippedObjects.has(targetId) &&
                                        !this._inactiveObjects.has(targetId)
                                    )
                                ) &&
                                !isExcludedObject(target, this.config) &&
                                isCleanableObject(target, this.config) &&
                                checkButterflyTargetAvailability(target).available
                            );
                        });

                return this._rankAvailableTargets(targets)[0]?.target ?? null;
            },

            _inspectBugCompletionState(target) {
                const bugState =
                    getBugCompletionState(target);

                if (String(objectTypeId(target) ?? "") !== "gdIns") {
                    return bugState;
                }

                const targetId =
                    stableObjectId(target);

                if (!this._loggedBugStates.has(targetId)) {
                    this._loggedBugStates.add(targetId);

                    cleanerLog(
                        `gdIns state ${targetId}:`,
                        {
                            serviced: (() => {
                                try {
                                    return target?.serviced;
                                } catch {
                                    return undefined;
                                }
                            })(),
                            She: (() => {
                                try {
                                    return target?.She;
                                } catch {
                                    return undefined;
                                }
                            })(),
                            completionKnown:
                                bugState.known,
                            completed:
                                bugState.completed,
                            reason:
                                bugState.reason
                        }
                    );
                }

                if (
                    this.config.debugInteractionMethods &&
                    !this._debuggedInteractionMethods.has(targetId)
                ) {
                    this._debuggedInteractionMethods.add(targetId);
                    inspectInteractionMethods(target);
                }

                return bugState;
            },

            _scanAndRun() {
                if (!this.running || this.paused) {
                    return;
                }
                if (this._skipIfCurrentWorkFinished("scan")) {
                    return;
                }
                if (this.busy) {
                    cleanerWarn("Interaction already running");
                    return;
                }
                const now = Date.now();
                const discoveredTargets =
                    discoverCleanableObjects(this.config);

                if (this._recoveryTargetId) {
                    const interruptedStillExists = discoveredTargets.some(
                        target => stableObjectId(target) === this._recoveryTargetId
                    );
                    if (!interruptedStillExists) {
                        cleanerLog(
                            `[AVA RECOVERY] Previous target ${this._recoveryTargetId} no longer exists; continuing`
                        );
                        this._recoveryTargetId = null;
                    }
                }

                const activeTargets = [];
                const availableTargets = [];

                for (const target of discoveredTargets) {
                    const targetId = stableObjectId(target);

                    if (
                        this._completedObjects.has(targetId) ||
                        this._skippedObjects.has(targetId) ||
                        this._inactiveObjects.has(targetId)
                    ) {
                        continue;
                    }

                    const existingPending =
                        this._pendingObjects.get(targetId);

                    if (
                        existingPending &&
                        existingPending.retryAfter > now
                    ) {
                        activeTargets.push(target);
                        continue;
                    }

                    if (isExcludedObject(target, this.config)) {
                        logExcludedObject(target, this.config);
                        continue;
                    }

                    const bugState =
                        this._inspectBugCompletionState(target);

                    if (
                        bugState.known &&
                        bugState.completed
                    ) {
                        cleanerLog(`Skipping already-squashed target ${targetId}`);
                        this._markInactiveTarget(
                            targetId,
                            `already squashed: ${bugState.reason}`
                        );
                        continue;
                    }

                    if (isButterflyTarget(target)) {
                        const butterflyAvailability =
                            checkButterflyTargetAvailability(target);

                        if (!butterflyAvailability.available) {
                            this._markInactiveTarget(
                                targetId,
                                butterflyAvailability.reason
                            );
                            continue;
                        }

                        this._pendingObjects.delete(targetId);
                        activeTargets.push(target);
                        availableTargets.push(target);
                        continue;
                    }

                    const availability =
                        interactionAvailability(target);

                    if (availability.available) {
                        this._pendingObjects.delete(targetId);
                        activeTargets.push(target);
                        availableTargets.push(target);
                        continue;
                    }

                    const previous =
                        existingPending;

                    const pending = {
                        target,
                        reason: !availability.readyInteractResult
                            ? "not ready"
                            : "queue unavailable",
                        firstSeenAt:
                            previous?.firstSeenAt ??
                            now,
                        lastSeenAt:
                            now,
                        unavailableCount:
                            (previous?.unavailableCount ?? 0) + 1,
                        retryAfter:
                            now + this.config.temporaryUnavailableDelay
                    };

                    const permanentlyUnavailable =
                        pending.unavailableCount >= this.config.maxUnavailableScans ||
                        now - pending.firstSeenAt >= this.config.maxUnavailableDuration;

                    if (permanentlyUnavailable) {
                        this._markInactiveTarget(
                            targetId,
                            `${pending.reason} for ${pending.unavailableCount} scans`
                        );
                        continue;
                    }

                    this._pendingObjects.set(targetId, pending);
                    activeTargets.push(target);
                }

                this._lastScanTargets = activeTargets;
                this.remainingTargets = activeTargets.length;
                cleanerLog(
                    `${activeTargets.length} target${activeTargets.length === 1 ? "" : "s"} remaining: ` +
                    `${availableTargets.length} available, ` +
                    `${this._pendingObjects.size} pending`
                );

                if (activeTargets.length === 0) {
                    this._handleEmptyScan();
                    return;
                }

                if (availableTargets.length === 0) {
                    this._emptyScans++;

                    if (this._emptyScans >= this.config.emptyScansRequired) {
                        cleanerLog("No available targets remain; treating map as complete");

                        for (const [targetId] of this._pendingObjects) {
                            this._inactiveObjects.add(targetId);
                            this._skippedObjects.add(targetId);
                        }

                        this._pendingObjects.clear();
                        this._handleEmptyScan();
                        return;
                    }

                    this._setTimer(() => this._scanAndRun(), this.config.fullRescanInterval);
                    return;
                }

                const selectableTargets =
                    this.currentMap === "garden"
                        ? (
                            availableTargets.some(target => !isButterflyTarget(target))
                                ? availableTargets.filter(target => !isButterflyTarget(target))
                                : availableTargets
                        )
                        : availableTargets;

                if (selectableTargets.length !== availableTargets.length) {
                    cleanerLog("Garden static targets first; butterflies postponed");
                }

                const rankedTargets =
                    this._rankAvailableTargets(selectableTargets);

                const next =
                    rankedTargets[0];

                if (!next?.target) {
                    this._setTimer(() => this._scanAndRun(), this.config.fullRescanInterval);
                    return;
                }

                cleanerLog(
                    `Next target: ${stableObjectId(next.target)} at ${formatPoint(next.point)}, distance²=${formatDistance(next.distance)}`
                );

                this._emptyScans = 0;
                this._startInteraction(next.target);
            },

            _handleEmptyScan() {
                if (this.busy) {
                    return;
                }
                this._emptyScans++;
                if (this._emptyScans < this.config.emptyScansRequired) {
                    this._setTimer(() => this._scanAndRun(), this.config.emptyScanInterval);
                    return;
                }
                const mapId = this.currentMap ?? this.config.maps[this._mapIndex];

                const reloadCount =
                    this._workAreaReloadCounts.get(mapId) ?? 0;
                const maxReloads = Math.max(
                    0,
                    Number(
                        this.config.workAreaSkippedReloads ??
                        this.config.yardSkippedReloads ??
                        0
                    )
                );

                if (
                    !isCurrentWorkFinished() &&
                    this._workAreaNeedsReloadForSkippedObjects &&
                    reloadCount < maxReloads
                ) {
                    const nextReloadCount = reloadCount + 1;
                    this._workAreaReloadCounts.set(mapId, nextReloadCount);
                    this._yardSkippedReloadCount = nextReloadCount;
                    this._yardNeedsReloadForSkippedObjects = false;
                    this._workAreaNeedsReloadForSkippedObjects = false;
                    this._skippedObjects = new Set();
                    this._inactiveObjects = new Set();
                    this._pendingObjects = new Map();
                    this._attempts = new Map();
                    cleanerWarn(
                        `Reloading ${mapId} to retry skipped objects (${nextReloadCount}/${maxReloads})`
                    );
                    this._moveToConfiguredMap();
                    return;
                }

                cleanerLog(`Map complete: ${mapId}`);
                this._recordShiftAndAdvance(mapId);
            },

            _getMaxAttemptsForTarget(target, targetId = null) {
                const id =
                    targetId == null
                        ? ""
                        : String(targetId);

                if (
                    isButterflyTarget(target) ||
                    id.includes("|gdBtf")
                ) {
                    return Math.max(
                        1,
                        Number(
                            this.config.butterflyMaxAttempts ??
                            this.config.maxRetriesPerObject
                        )
                    );
                }

                if (this.currentMap === "garbage") {
                    return Math.max(
                        1,
                        Number(
                            this.config.yardMaxRetriesPerObject ??
                            this.config.maxRetriesPerObject
                        )
                    );
                }

                return Math.max(
                    1,
                    Number(this.config.maxRetriesPerObject ?? 3)
                );
            },

            _getInteractionTimeoutForTarget(target) {
                if (
                    this.currentMap === "garbage" &&
                    !isButterflyTarget(target)
                ) {
                    return Math.max(
                        1000,
                        Number(
                            this.config.yardInteractionTimeout ??
                            this.config.interactionTimeout
                        )
                    );
                }

                return Math.max(
                    1000,
                    Number(this.config.interactionTimeout ?? 40000)
                );
            },

            _startInteraction(target) {
                if (this.busy) {
                    cleanerWarn("Interaction already running");
                    return false;
                }
                if (this._skipIfCurrentWorkFinished("interaction start")) {
                    return false;
                }
                const avatar = w.__AVA_CURRENT_AVATAR__ ?? null;
                const InteractAction = getInteractActionClass();
                const targetId = stableObjectId(target);
                const butterflyTarget =
                    isButterflyTarget(target);

                if (
                    !avatar ||
                    typeof avatar.addAction !== "function" ||
                    (!butterflyTarget && !InteractAction)
                ) {
                    this._registerFailure(
                        targetId,
                        butterflyTarget
                            ? "missing avatar"
                            : "missing avatar or InteractAction",
                        target
                    );
                    this._scheduleScan(this.config.scanDelay);
                    return false;
                }
                if (isExcludedObject(target, this.config)) {
                    logExcludedObject(target, this.config);
                    this._scheduleScan(this.config.scanDelay);
                    return false;
                }
                if (!isCleanableObject(target, this.config)) {
                    this._registerFailure(targetId, "invalid target", target);
                    this._scheduleScan(this.config.scanDelay);
                    return false;
                }
                const bugState =
                    this._inspectBugCompletionState(target);

                if (
                    bugState.known &&
                    bugState.completed
                ) {
                    cleanerLog(`Skipping already-squashed target ${targetId}`);
                    this._markInactiveTarget(
                        targetId,
                        `already squashed: ${bugState.reason}`
                    );
                    this._scheduleScan(100);
                    return false;
                }
                const targetAvailability = butterflyTarget
                    ? checkButterflyTargetAvailability(target)
                    : checkTargetAvailability(target);

                if (!targetAvailability.available) {
                    this._markInactiveTarget(targetId, targetAvailability.reason);
                    this._scheduleScan(100);
                    return false;
                }

                if (!this._canStartEnergyAction(target)) {
                    return false;
                }

                const attempt = (this._attempts.get(targetId) ?? 0) + 1;
                const maxAttempts =
                    this._getMaxAttemptsForTarget(target, targetId);

                this._attempts.set(targetId, attempt);
                this.totalAttempts++;
                if (attempt > 1) {
                    cleanerLog(`Retrying ${targetId}, attempt ${attempt}/${maxAttempts}`);
                }
                if (attempt > maxAttempts) {
                    this._skipObject(targetId, maxAttempts);
                    this._scheduleScan(this.config.scanDelay);
                    return false;
                }

                if (butterflyTarget) {
                    const started =
                        this._startButterflyInteraction(target);

                    if (!started) {
                        this._scheduleScan(this.config.scanDelay);
                    }

                    return started;
                }

                if (this._skipIfCurrentWorkFinished("InteractAction creation")) {
                    return false;
                }

                this.busy = true;
                this.currentTarget = target;
                this.interactionToken++;
                const token = this.interactionToken;
                cleanerLog(`Cleaning ${targetId}`);
                requestRecoveryCheckpointSave("interaction-start", true);
                installFinishInteractionWatch(target, this, token);
                try {
                    const action = new InteractAction(target, null);
                    this._activeAction = action;
                    avatar.addAction(action);
                    this._watchInteraction(token, target, action, performance.now());
                    return true;
                } catch (error) {
                    cleanerWarn(`Interaction failed: ${targetId}`, error);

                    if (String(objectTypeId(target) ?? "") === "gdIns") {
                        this._markInactiveTarget(targetId, "stale gdIns target");
                        this._completeInteraction(token, "stale gdIns target", null);
                        return false;
                    }

                    this._completeInteraction(token, "exception", false);
                    return false;
                }
            },

            _startButterflyInteraction(target, manual = null) {
                if (this.busy) {
                    cleanerWarn("Interaction already running");
                    return false;
                }

                const avatar =
                    w.__AVA_CURRENT_AVATAR__ ??
                    null;

                const targetId =
                    stableObjectId(target);

                const availability =
                    checkButterflyTargetAvailability(target);

                const InteractAction =
                    getInteractActionClass();

                if (
                    !avatar ||
                    typeof avatar.addAction !== "function"
                ) {
                    this._registerFailure(targetId, "missing avatar");
                    return false;
                }

                if (!availability.available) {
                    this._deferButterflyTarget(
                        targetId,
                        target,
                        availability.reason
                    );
                    return false;
                }

                if (!InteractAction) {
                    this._registerFailure(targetId, "missing butterfly InteractAction");
                    return false;
                }

                if (!this._canStartEnergyAction(target)) {
                    return false;
                }

                this.busy = true;
                this.currentTarget = target;
                this.interactionToken++;

                const token =
                    this.interactionToken;

                if (manual) {
                    this._activeManualPromise = {
                        token,
                        resolve: manual.resolve,
                        reject: manual.reject
                    };
                }

                cleanerLog(`Catching butterfly ${targetId}`);
                requestRecoveryCheckpointSave("butterfly-interaction-start", true);
                installFinishInteractionWatch(target, this, token);

                let lastMoveAt = 0;
                let interactionStarted = false;
                const startedAt =
                    performance.now();
                const attemptWindow =
                    this.config.butterflyAttemptWindowMs ??
                    15000;

                const finishAttemptWithoutFailure = reason => {
                    if (
                        token !== this.interactionToken ||
                        !this.busy
                    ) {
                        return;
                    }

                    cleanerWarn(`${reason}: ${targetId}`);
                    this._deferButterflyTarget(
                        targetId,
                        target,
                        reason
                    );
                    this._completeInteraction(token, reason, null);
                };

                const requestWalk = () => {
                    const now =
                        performance.now();

                    if (
                        now - lastMoveAt <
                        this.config.butterflyMoveRefreshMs
                    ) {
                        return;
                    }

                    const point =
                        getTargetInteractionPoint(
                            target,
                            avatar
                        );

                    if (!point) {
                        return;
                    }

                    const action =
                        createWalkActionToPoint(
                            avatar,
                            point
                        );

                    if (!action) {
                        return;
                    }

                    lastMoveAt = now;
                    this._activeAction = action;
                    avatar.addAction(action);
                };

                const tick = () => {
                    if (
                        token !== this.interactionToken ||
                        !this.busy
                    ) {
                        return;
                    }

                    if (!hasWorldReference(target)) {
                        this._completeInteraction(token, "detached");
                        return;
                    }

                    if (
                        performance.now() - startedAt >
                        attemptWindow
                    ) {
                        finishAttemptWithoutFailure(
                            interactionStarted
                                ? "butterfly catch wait timeout"
                                : "butterfly ready timeout"
                        );
                        return;
                    }

                    try {
                        if (
                            !interactionStarted &&
                            typeof target.readyInteract === "function" &&
                            target.readyInteract() === true
                        ) {
                            if (this._skipIfCurrentWorkFinished("butterfly InteractAction creation")) {
                                return;
                            }
                            if (!this._canStartEnergyAction(target)) {
                                this._completeInteraction(token, "energy paused", null);
                                return;
                            }

                            interactionStarted = true;
                            cleanerLog(`Butterfly ready; adding InteractAction ${targetId}`);

                            const action =
                                new InteractAction(
                                    target,
                                    null
                                );

                            this._activeAction = action;
                            avatar.addAction(action);

                            this._setTimer(
                                () => finishAttemptWithoutFailure("butterfly finish timeout"),
                                attemptWindow
                            );
                            return;
                        }
                    } catch (error) {
                        cleanerWarn(`Butterfly InteractAction failed: ${targetId}`, error);
                        this._deferButterflyTarget(
                            targetId,
                            target,
                            "butterfly InteractAction exception"
                        );
                        this._completeInteraction(token, "butterfly InteractAction exception", null);
                        return;
                    }

                    requestWalk();
                    this._setTimer(tick, this.config.butterflyReadyPollMs);
                };

                requestWalk();
                this._setTimer(tick, this.config.butterflyReadyPollMs);
                return true;
            },

            _watchInteraction(token, target, action, startedAt) {
                const manual =
                    this._activeManualPromise?.token === token;

                if ((!this.running && !manual) || token !== this.interactionToken || !this.busy) {
                    return;
                }
                if (this._skipIfCurrentWorkFinished("active interaction")) {
                    return;
                }
                const targetId = stableObjectId(target);
                if (!hasWorldReference(target)) {
                    this._completeInteraction(token, "detached");
                    return;
                }
                if (
                    performance.now() - startedAt >
                    this._getInteractionTimeoutForTarget(target)
                ) {
                    const butterflyTarget =
                        isButterflyTarget(target);
                    const targetAvailability = butterflyTarget
                        ? checkButterflyTargetAvailability(target)
                        : checkTargetAvailability(target);

                    if (!targetAvailability.available) {
                        if (butterflyTarget) {
                            this._deferButterflyTarget(
                                targetId,
                                target,
                                targetAvailability.reason
                            );
                            cleanerLog(`Deferred butterfly after timeout: ${targetId}`);
                            this._completeInteraction(token, "timeout unavailable butterfly", null);
                            return;
                        }

                        this._markInactiveTarget(targetId, targetAvailability.reason);
                        cleanerLog(`Skipped inactive target after timeout: ${targetId}`);
                        this._completeInteraction(token, "timeout inactive target", null);
                        return;
                    }

                    const energy =
                        this.getEnergy();

                    if (
                        energy &&
                        energy.current < MIN_ENERGY_TO_ACT
                    ) {
                        this._pauseForEnergy(energy);
                        this._completeInteraction(token, "timeout with low energy", null);
                        return;
                    }

                    cleanerWarn(`Interaction timeout: ${targetId}`);

                    if (butterflyTarget) {
                        this._deferButterflyTarget(
                            targetId,
                            target,
                            "butterfly timeout"
                        );
                        this._completeInteraction(token, "butterfly timeout", null);
                        return;
                    }

                    this._completeInteraction(token, "timeout", false);
                    return;
                }
                this._setTimer(() => this._watchInteraction(token, target, action, startedAt), 500);
            },

            _completeInteraction(token, reason, success = true) {
                if (token !== this.interactionToken) {
                    return false;
                }
                const target = this.currentTarget;
                const targetId = target ? stableObjectId(target) : null;
                this.busy = false;
                this.currentTarget = null;
                this._activeAction = null;
                if (target) {
                    restoreFinishInteractionWatch(target);
                }
                if (success === true) {
                    if (targetId) {
                        this._completedObjects.add(targetId);
                        this._pendingObjects.delete(targetId);
                    }
                    this.cleanedObjects++;
                    cleanerLog(`Completed ${targetId ?? "object"}`);
                } else if (success === false && targetId) {
                    this._registerFailure(targetId, reason, target);
                }

                if (targetId) {
                    this._logEnergyAfterAction();
                }

                const manual =
                    this._activeManualPromise;

                if (manual?.token === token) {
                    this._activeManualPromise = null;

                    try {
                        if (success === false) {
                            manual.reject(
                                new Error(reason)
                            );
                        } else {
                            manual.resolve({
                                targetId,
                                reason,
                                completed:
                                    success === true
                            });
                        }
                    } catch {}
                }

                if (this.running && !this.paused) {
                    this._scheduleScan(this.config.scanDelay);
                }
                requestRecoveryCheckpointSave(
                    success === true ? "interaction-complete" : "interaction-failed",
                    true
                );
                return true;
            },

            _markInactiveTarget(targetId, reason) {
                if (!targetId || this._inactiveObjects.has(targetId)) {
                    return;
                }

                this._inactiveObjects.add(targetId);
                this._pendingObjects.delete(targetId);
                this._skippedObjects.add(targetId);

                if (this.currentMap === "garbage") {
                    this._yardNeedsReloadForSkippedObjects = true;
                }
                this._workAreaNeedsReloadForSkippedObjects = true;

                cleanerLog(`Ignored inactive target ${targetId}`);

                if (reason) {
                    cleanerLog(`Reason: ${reason}`);
                }
                requestRecoveryCheckpointSave("target-inactive", true);
            },

            _registerFailure(targetId, reason, target = null) {
                const attempts = this._attempts.get(targetId) ?? 1;
                const maxAttempts =
                    this._getMaxAttemptsForTarget(target, targetId);

                cleanerWarn(`${targetId} failed: ${reason}`);
                requestRecoveryCheckpointSave("interaction-failed", true);
                if (attempts >= maxAttempts) {
                    this._skipObject(targetId, maxAttempts);
                }
            },

            _skipObject(targetId, maxAttempts = this.config.maxRetriesPerObject) {
                if (this._skippedObjects.has(targetId)) {
                    return;
                }
                this._skippedObjects.add(targetId);
                this._pendingObjects.delete(targetId);
                this.failedObjects++;

                if (this.currentMap === "garbage") {
                    this._yardNeedsReloadForSkippedObjects = true;
                }
                this._workAreaNeedsReloadForSkippedObjects = true;

                cleanerWarn(`Object skipped after ${maxAttempts} failures`, targetId);
                requestRecoveryCheckpointSave("target-skipped", true);
            }
        };

        w.__AVA_MAP_CLEANER__ = cleaner;
        return cleaner;
    }

    function installMapCleanerWhenReady() {
        const timer = setInterval(() => {
            if (installAvatarCapture()) {
                clearInterval(timer);
            }
        }, 500);
    }

    /*
     * ============================================================
     * AUTO CLEAN LOOP
     * ============================================================
     */

    function initializeAutoCleanLoop() {
        const storageKey = "__AVA_AUTO_CLEAN_LOOP_ENABLED__";
        const modeStorageKey = "__AVA_AUTO_CLEAN_LOOP_MODE__";
        const availabilityStorageKey = "__AVA_SHIFT_AVAILABILITY_V1__";

        const loop = {
            enabled: false,
            running: false,
            phase: "off",
            startedAt: 0,
            completedAt: 0,
            nextReloadAt: 0,
            waitingStartedAt: 0,
            cycleMode: "full",
            nextCycleMode: "yard",
            fullMaps: ["garbage", "garden"],
            yardMaps: ["garbage"],
            maps: ["garbage", "garden"],
            fullThenYardMs: AVA_AUTO_CLEAN_LOOP_FULL_THEN_YARD_MS,
            yardThenFullMs: AVA_AUTO_CLEAN_LOOP_YARD_THEN_FULL_MS,
            idleMs: AVA_AUTO_CLEAN_LOOP_FULL_THEN_YARD_MS,
            startDelayMs: 3000,
            pollMs: 2000,
            recoveryInProgress: false,
            energyRecoveryInProgress: false,
            mapAvailability: {
                garbage: {
                    lastCountdownSeconds: null,
                    detectedAt: 0,
                    readyAt: 0,
                    source: null
                },
                garden: {
                    lastCountdownSeconds: null,
                    detectedAt: 0,
                    readyAt: 0,
                    source: null
                }
            },
            _timers: [],

            on() {
                this.enabled = true;
                this._loadCycleMode();
                try {
                    localStorage.setItem(storageKey, "1");
                } catch {}
                console.log("[AVA AUTO LOOP] ON");
                this._startCycleWhenReady();
                return this.status();
            },

            off() {
                this.enabled = false;
                this.running = false;
                this.phase = "off";
                this.nextReloadAt = 0;
                this.waitingStartedAt = 0;
                try {
                    localStorage.setItem(storageKey, "0");
                } catch {}
                this._clearTimers();

                try {
                    if (w.__AVA_MAP_CLEANER__?.running) {
                        w.__AVA_MAP_CLEANER__.stop();
                    }
                } catch {}

                console.log("[AVA AUTO LOOP] OFF");
                return this.status();
            },

            toggle(value) {
                if (typeof value === "boolean") {
                    return value ? this.on() : this.off();
                }

                return this.enabled ? this.off() : this.on();
            },

            status() {
                return {
                    enabled: this.enabled,
                    running: this.running,
                    phase: this.phase,
                    cycleMode: this.cycleMode,
                    nextCycleMode: this.nextCycleMode,
                    maps: this.maps.slice(),
                    idleMs: this.idleMs,
                    fullThenYardMs: this.fullThenYardMs,
                    yardThenFullMs: this.yardThenFullMs,
                    waitingStartedAt: this.waitingStartedAt,
                    waitingForGameMs: this.waitingStartedAt
                        ? Date.now() - this.waitingStartedAt
                        : null,
                    startedAt: this.startedAt,
                    completedAt: this.completedAt,
                    nextReloadAt: this.nextReloadAt,
                    nextReloadInMs: this.nextReloadAt
                        ? Math.max(0, this.nextReloadAt - Date.now())
                        : null,
                    recoveryInProgress: this.recoveryInProgress,
                    energyRecoveryInProgress: this.energyRecoveryInProgress,
                    mapAvailability: this.shiftStatus().maps
                };
            },

            serializableMapAvailability() {
                const result = {};
                for (const mapId of ["garbage", "garden"]) {
                    const entry = this.mapAvailability[mapId] ?? {};
                    result[mapId] = {
                        readyAt: Number(entry.readyAt ?? 0),
                        detectedAt: Number(entry.detectedAt ?? 0),
                        lastCountdownSeconds: entry.lastCountdownSeconds != null &&
                            Number.isFinite(Number(entry.lastCountdownSeconds))
                            ? Number(entry.lastCountdownSeconds)
                            : null,
                        source: typeof entry.source === "string" ? entry.source : null
                    };
                }
                return result;
            },

            restoreMapAvailability(value) {
                const now = Date.now();
                const oldestAllowed = now - 24 * 60 * 60 * 1000;
                const newestAllowed = now + 24 * 60 * 60 * 1000;
                for (const mapId of ["garbage", "garden"]) {
                    const entry = value?.[mapId];
                    const readyAt = Number(entry?.readyAt ?? 0);
                    const detectedAt = Number(entry?.detectedAt ?? 0);
                    if (
                        !Number.isFinite(readyAt) ||
                        !Number.isFinite(detectedAt) ||
                        detectedAt < oldestAllowed ||
                        readyAt > newestAllowed
                    ) {
                        continue;
                    }
                    this.mapAvailability[mapId] = {
                        readyAt,
                        detectedAt,
                        lastCountdownSeconds: entry.lastCountdownSeconds != null &&
                            Number.isFinite(Number(entry.lastCountdownSeconds))
                            ? Number(entry.lastCountdownSeconds)
                            : null,
                        source: typeof entry.source === "string" ? entry.source : null
                    };
                }
            },

            _storeMapAvailability() {
                try {
                    localStorage.setItem(
                        availabilityStorageKey,
                        JSON.stringify(this.serializableMapAvailability())
                    );
                } catch {}
                requestRecoveryCheckpointSave("shift-availability", true);
            },

            _fallbackDelayForMap(mapId) {
                if (mapId === "garden") {
                    return this.fullThenYardMs + this.yardThenFullMs;
                }
                return this.cycleMode === "yard"
                    ? this.yardThenFullMs
                    : this.fullThenYardMs;
            },

            async captureMapAvailability(mapId, options = {}) {
                if (!["garbage", "garden"].includes(mapId)) {
                    return null;
                }
                const timeoutMs = Math.max(0, Number(
                    options.timeoutMs ?? SHIFT_COUNTDOWN_TIMEOUT_MS
                ));
                const useFallback = options.useFallback !== false;
                const startedAt = performance.now();
                let countdown = null;

                do {
                    countdown = findVisibleShiftCountdown();
                    if (countdown || performance.now() - startedAt >= timeoutMs) {
                        break;
                    }
                    await new Promise(resolve => setTimeout(resolve, 250));
                } while (true);

                if (countdown) {
                    this.mapAvailability[mapId] = {
                        lastCountdownSeconds: countdown.totalSeconds,
                        detectedAt: countdown.detectedAt,
                        readyAt: countdown.readyAt,
                        source: "display-countdown"
                    };
                    console.log(`[AVA SHIFT] Countdown: ${countdown.text}`);
                    console.log(
                        `[AVA SHIFT] ${mapId} ready at ${new Date(countdown.readyAt).toLocaleTimeString()}`
                    );
                    this._storeMapAvailability();
                    return countdown;
                }

                if (!useFallback) {
                    return null;
                }
                const detectedAt = Date.now();
                const readyAt = detectedAt + this._fallbackDelayForMap(mapId);
                this.mapAvailability[mapId] = {
                    lastCountdownSeconds: null,
                    detectedAt,
                    readyAt,
                    source: "fallback-fixed-delay"
                };
                console.warn(`[AVA SHIFT] No countdown found for ${mapId}; using fallback delay`);
                this._storeMapAvailability();
                return null;
            },

            _nextReloadFromAvailability() {
                const garbageReadyAt = Number(this.mapAvailability.garbage.readyAt ?? 0);
                const gardenReadyAt = Number(this.mapAvailability.garden.readyAt ?? 0);
                const validGarbage = garbageReadyAt > 0;
                const validGarden = gardenReadyAt > 0;

                if (this.cycleMode === "yard") {
                    if (validGarbage && validGarden) {
                        return Math.max(garbageReadyAt, gardenReadyAt);
                    }
                    return validGarbage
                        ? garbageReadyAt
                        : Date.now() + this.yardThenFullMs;
                }

                if (validGarbage && validGarden) {
                    return Math.min(garbageReadyAt, gardenReadyAt);
                }
                if (validGarbage || validGarden) {
                    return validGarbage ? garbageReadyAt : gardenReadyAt;
                }
                return Date.now() + this.fullThenYardMs;
            },

            shiftStatus() {
                const now = Date.now();
                const maps = {};
                for (const mapId of ["garbage", "garden"]) {
                    const entry = this.mapAvailability[mapId];
                    maps[mapId] = {
                        ...entry,
                        readyInMs: entry.readyAt
                            ? Math.max(0, entry.readyAt - now)
                            : null
                    };
                }
                return {
                    maps,
                    garbage: maps.garbage,
                    garden: maps.garden,
                    nextCycleMode: this.nextCycleMode,
                    nextReloadAt: this.nextReloadAt
                };
            },

            _setTimer(callback, delay) {
                const timer = setTimeout(() => {
                    this._timers = this._timers.filter(item => item !== timer);
                    callback();
                }, delay);

                this._timers.push(timer);
                return timer;
            },

            _clearTimers() {
                for (const timer of this._timers) {
                    clearTimeout(timer);
                }

                this._timers.length = 0;
            },

            _loadCycleMode() {
                try {
                    const stored =
                        localStorage.getItem(modeStorageKey);

                    if (stored === "yard" || stored === "full") {
                        this.cycleMode = stored;
                    }
                } catch {}

                try {
                    const storedAvailability = JSON.parse(
                        localStorage.getItem(availabilityStorageKey) ?? "null"
                    );
                    this.restoreMapAvailability(storedAvailability);
                } catch {}

                this._refreshCycleConfig();
            },

            _storeCycleMode(mode) {
                try {
                    localStorage.setItem(modeStorageKey, mode);
                } catch {}
            },

            _refreshCycleConfig() {
                if (this.cycleMode === "yard") {
                    this.maps = this.yardMaps.slice();
                    this.nextCycleMode = "full";
                    this.idleMs = this.yardThenFullMs;
                    return;
                }

                this.cycleMode = "full";
                this.maps = this.fullMaps.slice();
                this.nextCycleMode = "yard";
                this.idleMs = this.fullThenYardMs;
            },

            _markWaitingForGame() {
                if (
                    this.phase !== "waiting-for-game" ||
                    !this.waitingStartedAt
                ) {
                    this.waitingStartedAt =
                        Date.now();
                }

                this.phase = "waiting-for-game";
            },

            _startCycleWhenReady() {
                this._clearTimers();

                if (!this.enabled) {
                    return;
                }

                if (this.recoveryInProgress) {
                    return;
                }

                this._loadCycleMode();
                this._markWaitingForGame();

                this._setTimer(() => {
                    if (!this.enabled) {
                        return;
                    }
                    if (this.recoveryInProgress) {
                        return;
                    }

                    if (!w.__AVA_MAP_CLEANER__) {
                        this._startCycleWhenReady();
                        return;
                    }

                    if (!gameLooksPlayable()) {
                        this._markWaitingForGame();

                        this._setTimer(
                            () => this._startCycleWhenReady(),
                            this.pollMs
                        );
                        return;
                    }

                    this.waitingStartedAt = 0;

                    this._startCleaningCycle();
                }, this.startDelayMs);
            },

            _startCleaningCycle() {
                if (!this.enabled) {
                    return;
                }

                this._refreshCycleConfig();

                if (w.__AVA_MAP_CLEANER__?.running) {
                    this._setTimer(() => this._watchCleaner(), this.pollMs);
                    return;
                }

                this.running = true;
                this.phase = "cleaning";
                this.startedAt = Date.now();
                this.completedAt = 0;
                this.nextReloadAt = 0;
                this.waitingStartedAt = 0;

                console.log(
                    `[AVA AUTO LOOP] Cleaning ${this.maps.join(" then ")} (${this.cycleMode})`
                );
                requestRecoveryCheckpointSave("auto-cycle-start", true);

                try {
                    w.__AVA_MAP_CLEANER__.start({
                        maps: this.maps.slice(),
                        detectionMode: "hybrid",
                        targetSelectionMode: "nearest",
                        excludedKeywords: ["sit", "exit"]
                    });
                } catch (error) {
                    console.error("[AVA AUTO LOOP] Cleaner start failed", error);
                    this._scheduleIdleReload();
                    return;
                }

                this._setTimer(() => this._watchCleaner(), this.pollMs);
            },

            _watchCleaner() {
                if (!this.enabled) {
                    return;
                }

                const cleaner =
                    w.__AVA_MAP_CLEANER__;

                if (!cleaner) {
                    this._startCycleWhenReady();
                    return;
                }

                if (
                    cleaner.paused &&
                    [
                        "insufficient-ready-fridges",
                        "energy-still-low-after-eating",
                        "house-or-room-timeout",
                        "work-return-teleport-failed",
                        "work-return-timeout"
                    ].includes(cleaner.pauseReason)
                ) {
                    return;
                }

                if (cleaner.running || cleaner.busy) {
                    this._setTimer(() => this._watchCleaner(), this.pollMs);
                    return;
                }

                const visited =
                    cleaner.visitedMaps ??
                    [];

                const finishedAllMaps =
                    this.maps.every(map => visited.includes(map));

                if (!finishedAllMaps) {
                    this._setTimer(() => this._watchCleaner(), this.pollMs);
                    return;
                }

                this._scheduleIdleReload();
            },

            _scheduleIdleReload() {
                if (!this.enabled) {
                    return;
                }

                this.running = false;
                this.phase = "idle";
                this.completedAt = Date.now();
                this._refreshCycleConfig();
                this._storeCycleMode(this.nextCycleMode);
                this.nextReloadAt = this._nextReloadFromAvailability();
                const waitMs = Math.max(0, this.nextReloadAt - Date.now());
                requestRecoveryCheckpointSave("auto-cycle-idle", true);

                console.log(
                    `[AVA AUTO LOOP] Idle for ${Math.ceil(waitMs / 60000)} minutes before reload; next cycle: ${this.nextCycleMode}`
                );

                this._setTimer(() => this._reload(), waitMs);
            },

            _reload() {
                if (!this.enabled) {
                    return;
                }

                this.phase = "reloading";
                console.log("[AVA AUTO LOOP] Reloading page");
                gmWrite(RECOVERY_STORAGE_KEY, {
                    ...buildRecoverySnapshot(),
                    reason: "scheduled-cycle-reload",
                    recoveryRequested: false
                }).finally(() => w.location.reload());
            }
        };

        loop.enabled =
            Boolean(AVA_AUTO_CLEAN_LOOP_ON);
        loop._loadCycleMode();

        try {
            localStorage.setItem(
                storageKey,
                loop.enabled ? "1" : "0"
            );
        } catch {}

        w.__AVA_AUTO_CLEAN_LOOP__ = loop;
        w.__AVA_FIND_SHIFT_COUNTDOWN__ = function () {
            const result = findVisibleShiftCountdown();
            if (result) {
                console.log("[AVA SHIFT] Visible countdown", {
                    text: result.text,
                    totalSeconds: result.totalSeconds,
                    readyAt: result.readyAt,
                    path: result.path
                });
            } else {
                console.warn("[AVA SHIFT] No visible shift countdown found");
            }
            return result;
        };
        w.__AVA_SHIFT_STATUS__ = function () {
            const status = loop.shiftStatus();
            console.table({
                garbage: status.garbage,
                garden: status.garden
            });
            return status;
        };

        if (loop.enabled) {
            console.log("[AVA AUTO LOOP] Script toggle is ON");
        }

        return loop;
    }

    function recoverySystemsReady() {
        try {
            return Boolean(
                gameLooksPlayable() &&
                getWorkManager() &&
                getWorkLocationClass() &&
                w.__AVA_MAP_CLEANER__ &&
                w.__AVA_AUTO_CLEAN_LOOP__ &&
                state.destinationCommandsReady
            );
        } catch {
            return false;
        }
    }

    function finishCrashRecovery() {
        const autoLoop = w.__AVA_AUTO_CLEAN_LOOP__;
        crashRecoveryState.phase = "resumed";
        crashRecoveryState.recoveryInProgress = false;
        if (autoLoop) {
            autoLoop.phase = "cleaning";
            autoLoop.recoveryInProgress = false;
            autoLoop._setTimer(() => autoLoop._watchCleaner(), autoLoop.pollMs);
        }
        cleanerLog("[AVA RECOVERY] Cleaner resumed");
        gmDelete(RECOVERY_STORAGE_KEY);
    }

    async function startCrashRecoveryIfNeeded() {
        const checkpoint = await gmRead(RECOVERY_STORAGE_KEY, null);
        crashRecoveryState.checkpointFound = Boolean(checkpoint);
        crashRecoveryState.checkpointSavedAt = Number(checkpoint?.savedAt ?? 0);

        if (!checkpointCanRecover(checkpoint)) {
            if (checkpoint?.recoveryRequested === true || Number(checkpoint?.expiresAt) <= Date.now()) {
                await gmDelete(RECOVERY_STORAGE_KEY);
            }
            return false;
        }

        const autoLoop = w.__AVA_AUTO_CLEAN_LOOP__;
        crashRecoveryState.recoveryInProgress = true;
        crashRecoveryState.targetMap = checkpoint.cleaner.currentMap;
        crashRecoveryState.interruptedTargetId = checkpoint.cleaner.currentTargetId ?? null;
        crashRecoveryState.phase = "waiting-for-game";
        autoLoop.recoveryInProgress = true;
        autoLoop.phase = "recovering";
        autoLoop.enabled = true;
        autoLoop.running = true;
        autoLoop._clearTimers();
        console.log("[AVA RECOVERY] Recovery checkpoint found");
        console.log("[AVA RECOVERY] Waiting for game readiness");

        const startedAt = performance.now();
        return new Promise(resolve => {
            const check = () => {
                if (!crashRecoveryState.recoveryInProgress) {
                    resolve(false);
                    return;
                }
                if (recoverySystemsReady()) {
                    autoLoop.cycleMode = checkpoint.autoLoop.cycleMode === "yard" ? "yard" : "full";
                    autoLoop.nextCycleMode = checkpoint.autoLoop.nextCycleMode === "full" ? "full" : "yard";
                    autoLoop.maps = checkpoint.autoLoop.maps.slice();
                    autoLoop.restoreMapAvailability(checkpoint.autoLoop.mapAvailability);
                    autoLoop.phase = "recovering";
                    crashRecoveryState.phase = "teleporting";

                    if (checkpoint.energyRecovery?.inProgress) {
                        const cleaner = w.__AVA_MAP_CLEANER__;
                        cleaner.running = true;
                        cleaner.paused = true;
                        cleaner.pauseReason = "energy-recovery";
                        cleaner.config.maps = checkpoint.autoLoop.maps.slice();
                        cleaner._mapIndex = Number(checkpoint.autoLoop.mapIndex ?? 0);
                        cleaner.currentMap = checkpoint.energyRecovery.savedWork?.currentMap ?? checkpoint.cleaner.currentMap;
                        autoLoop.recoveryInProgress = false;
                        autoLoop.energyRecoveryInProgress = true;
                        crashRecoveryState.recoveryInProgress = false;
                        crashRecoveryState.phase = "energy-recovery";
                        launchEnergyRecovery(
                            cleaner,
                            null,
                            checkpoint.energyRecovery
                        );
                        resolve(true);
                        return;
                    }

                    const resumed = w.__AVA_MAP_CLEANER__.resumeFromRecovery(checkpoint);
                    if (!resumed) {
                        crashRecoveryState.lastRecoveryError = "cleaner refused recovery checkpoint";
                        crashRecoveryState.recoveryInProgress = false;
                        autoLoop.recoveryInProgress = false;
                        autoLoop._startCycleWhenReady();
                        resolve(false);
                        return;
                    }
                    autoLoop._setTimer(() => autoLoop._watchCleaner(), autoLoop.pollMs);
                    resolve(true);
                    return;
                }
                if (performance.now() - startedAt >= 60000) {
                    crashRecoveryState.lastRecoveryError = "game readiness timeout";
                    crashRecoveryState.phase = "failed";
                    crashRecoveryState.recoveryInProgress = false;
                    autoLoop.recoveryInProgress = false;
                    console.error("[AVA RECOVERY] Game readiness timeout");
                    autoLoop._startCycleWhenReady();
                    resolve(false);
                    return;
                }
                setTimeout(check, 1000);
            };
            check();
        });
    }

    /*
     * ============================================================
     * FUNCTION.CALLER / ARGUMENTS
     * ============================================================
     */

    function readCaller(fn) {
        try {
            return fn.caller ?? null;
        } catch (error) {
            state.callerErrors.push({
                time: new Date().toISOString(),
                operation: "caller",
                name: functionName(fn),
                error: String(error)
            });

            return null;
        }
    }

    function readFunctionArguments(fn) {
        try {
            if (!fn.arguments) {
                return [];
            }

            return Array.from(fn.arguments);
        } catch (error) {
            state.callerErrors.push({
                time: new Date().toISOString(),
                operation: "arguments",
                name: functionName(fn),
                error: String(error)
            });

            return [];
        }
    }

    function captureCallerChain(
        startFunction,
        maxDepth = 35
    ) {
        const calls = [];
        const visited = new Set();

        let fn = startFunction;
        let depth = 0;

        while (
            typeof fn === "function" &&
            depth < maxDepth &&
            !visited.has(fn)
        ) {
            visited.add(fn);

            const args =
                readFunctionArguments(fn);

            const call = {
                depth,
                name:
                    functionName(fn),

                source:
                    functionSource(fn),

                argumentTypes:
                    args.map(value => {
                        try {
                            return (
                                value?.constructor?.name ??
                                typeof value
                            );
                        } catch {
                            return "[illisible]";
                        }
                    }),

                arguments:
                    args.map(value =>
                        safePreview(value)
                    ),

                /*
                 * Ces références ne doivent pas être sérialisées.
                 */
                rawFunction:
                    fn,

                rawArguments:
                    args
            };

            calls.push(call);

            inspectServiceObjects(
                args,
                {
                    sourceMethod:
                        call.name,

                    functionSource:
                        call.source,

                    rawArguments:
                        args,

                    rawThis:
                        null,

                    stack:
                        new Error("Service object inspection").stack ??
                        null
                }
            );

            const walkAction =
                args.find(isWalkAction);

            if (walkAction) {
                captureWalkAction(
                    walkAction,
                    `caller:${depth}`
                );
            }

            if (state.actionCaptureActive) {
                captureActionCandidate(
                    call
                );
            }

            fn = readCaller(fn);
            depth++;
        }

        return calls;
    }

    /*
     * ============================================================
     * CAPTURE GÉNÉRIQUE D’ACTIONS MÉTIER
     * ============================================================
     */

    function candidateKey(call) {
        return [
            call.name,
            call.depth,
            call.argumentTypes.join("|"),
            JSON.stringify(call.arguments)
        ].join("::");
    }

    function captureActionCandidate(call) {
        /*
         * On écarte les couches techniques les plus évidentes.
         */
        const lowerName =
            String(call.name).toLowerCase();

        if (
            lowerName === "flush" ||
            lowerName === "send" ||
            lowerName === "socket.send"
        ) {
            return;
        }

        const key =
            candidateKey(call);

        const existing =
            state.actionCandidates.find(
                candidate =>
                    candidate.key === key
            );

        if (existing) {
            existing.count++;
            return;
        }

        state.actionCandidates.push({
            index:
                state.actionCandidates.length,

            key,

            label:
                state.actionCaptureLabel,

            elapsedMs:
                Math.round(
                    performance.now() -
                    state.actionCaptureStartedAt
                ),

            depth:
                call.depth,

            name:
                call.name,

            source:
                call.source,

            argumentTypes:
                call.argumentTypes,

            arguments:
                call.arguments,

            rawFunction:
                call.rawFunction,

            rawArguments:
                call.rawArguments,

            count: 1
        });
    }

    /*
     * ============================================================
     * WALKACTION
     * ============================================================
     */

    function isWalkAction(value) {
        if (!value || typeof value !== "object") {
            return false;
        }

        try {
            return (
                typeof value.doInit === "function" &&
                typeof value.nextStep === "function" &&
                typeof value.getOrFindPath ===
                    "function" &&
                "dest" in value
            );
        } catch {
            return false;
        }
    }

    function getWalkActor(action) {
        try {
            return (
                action.actor ??
                action.Eo ??
                null
            );
        } catch {
            return action?.Eo ?? null;
        }
    }

    function getWalkDestination(action) {
        try {
            return (
                action.dest ??
                action.y3e ??
                action.h3e ??
                null
            );
        } catch {
            return (
                action?.y3e ??
                action?.h3e ??
                null
            );
        }
    }

    function captureWalkAction(
        action,
        source
    ) {
        if (!isWalkAction(action)) {
            return false;
        }

        state.lastWalk = action;

        const actor =
            getWalkActor(action);

        const destination =
            getWalkDestination(action);

        if (actor) {
            state.actor = actor;
        }

        if (
            typeof action.constructor ===
            "function"
        ) {
            state.walkConstructor =
                action.constructor;
        }

        if (destination) {
            state.pointTemplate =
                destination;
        }

        state.walkOptions.B3e =
            action.B3e ??
            state.walkOptions.B3e ??
            true;

        if (!seenWalkActions.has(action)) {
            seenWalkActions.add(action);
            state.walks.push(action);

            if (
                state.moveRecording &&
                !state.replaying
            ) {
                const point =
                    pointPreview(destination);

                if (point) {
                    state.recordedMoves.push({
                        index:
                            state.recordedMoves.length,

                        time:
                            new Date().toISOString(),

                        elapsedMs:
                            Math.round(
                                performance.now() -
                                state.moveRecordingStartedAt
                            ),

                        source,

                        destination:
                            point
                    });
                }
            }
        }

        return true;
    }

    function clonePoint(template, x, y) {
        const nx = Number(x);
        const ny = Number(y);

        if (
            !Number.isFinite(nx) ||
            !Number.isFinite(ny)
        ) {
            throw new TypeError(
                "Coordonnées invalides"
            );
        }

        try {
            const Constructor =
                template?.constructor;

            if (
                typeof Constructor ===
                    "function" &&
                Constructor !== Object
            ) {
                return new Constructor(nx, ny);
            }
        } catch {}

        try {
            const point =
                Object.create(
                    Object.getPrototypeOf(
                        template
                    )
                );

            point.x = nx;
            point.y = ny;

            return point;
        } catch {
            return {
                x: nx,
                y: ny
            };
        }
    }

    /*
     * ============================================================
     * WEBSOCKET
     * ============================================================
     */

    const NativeWebSocket =
        w.WebSocket;

    function bytesToBase64(bytes) {
        let binary = "";

        for (
            let offset = 0;
            offset < bytes.length;
            offset += 0x8000
        ) {
            const chunk =
                bytes.subarray(
                    offset,
                    offset + 0x8000
                );

            for (
                let index = 0;
                index < chunk.length;
                index++
            ) {
                binary +=
                    String.fromCharCode(
                        chunk[index]
                    );
            }
        }

        return btoa(binary);
    }

    async function toBytes(data) {
        if (data instanceof w.ArrayBuffer) {
            return new Uint8Array(data);
        }

        if (w.ArrayBuffer.isView(data)) {
            return new Uint8Array(
                data.buffer,
                data.byteOffset,
                data.byteLength
            );
        }

        if (data instanceof w.Blob) {
            return new Uint8Array(
                await data.arrayBuffer()
            );
        }

        return null;
    }

    async function recordFrame(
        direction,
        socket,
        data,
        stack
    ) {
        try {
            const bytes =
                await toBytes(data);

            state.wsFrames.push({
                time:
                    new Date().toISOString(),

                direction,

                url:
                    socket.url,

                type:
                    data?.constructor?.name ??
                    typeof data,

                size:
                    bytes?.byteLength ??
                    data?.length ??
                    null,

                base64:
                    bytes
                        ? bytesToBase64(bytes)
                        : null,

                stack:
                    direction === "SEND"
                        ? stack
                        : null
            });

            /*
             * Limite mémoire.
             */
            if (state.wsFrames.length > 2000) {
                state.wsFrames.splice(
                    0,
                    state.wsFrames.length - 2000
                );
            }
        } catch (error) {
            console.warn(
                "[AVA-V11 WS] Lecture impossible",
                error
            );
        }
    }

    const WebSocketProxy =
        new Proxy(
            NativeWebSocket,
            {
                construct(
                    target,
                    args,
                    newTarget
                ) {
                    const socket =
                        Reflect.construct(
                            target,
                            args,
                            newTarget
                        );

                    state.sockets.push(socket);

                    const nativeSend =
                        socket.send;

                    socket.send =
                        function (data) {
                            const stack =
                                new Error(
                                    "WebSocket.send"
                                ).stack ?? "";

                            const calls =
                                captureCallerChain(
                                    socket.send
                                );

                            if (
                                state.netTraceActive
                            ) {
                                state.netTraces.push({
                                    index:
                                        state.netTraces.length,

                                    label:
                                        state.netTraceLabel,

                                    time:
                                        new Date()
                                            .toISOString(),

                                    elapsedMs:
                                        Math.round(
                                            performance.now() -
                                            state.netTraceStartedAt
                                        ),

                                    url:
                                        socket.url,

                                    payloadSize:
                                        data?.byteLength ??
                                        data?.length ??
                                        null,

                                    calls,

                                    stack
                                });
                            }

                            void recordFrame(
                                "SEND",
                                socket,
                                data,
                                stack
                            );

                            return nativeSend.call(
                                socket,
                                data
                            );
                        };

                    socket.addEventListener(
                        "message",
                        event => {
                            void recordFrame(
                                "RECV",
                                socket,
                                event.data,
                                null
                            );
                        }
                    );

                    return socket;
                }
            }
        );

    try {
        Object.setPrototypeOf(
            WebSocketProxy,
            NativeWebSocket
        );

        WebSocketProxy.prototype =
            NativeWebSocket.prototype;
    } catch {}

    w.WebSocket =
        WebSocketProxy;

    /*
     * ============================================================
     * OPENFL — HOOK FILTRÉ ET LÉGER
     * ============================================================
     */

    const ALLOWED_UI_EVENTS = new Set([
        "click",
        "mousedown",
        "mouseup",
        "mouse_down",
        "mouse_up",
        "touchbegin",
        "touchend",
        "pointerdown",
        "pointerup"
    ]);

    function findOpenFLPrototype() {
        const candidates = [];

        try {
            candidates.push(
                w.openfl?.events
                    ?.EventDispatcher
                    ?.prototype
            );
        } catch {}

        try {
            candidates.push(
                w.openfl_events_EventDispatcher
                    ?.prototype
            );
        } catch {}

        return (
            candidates.find(
                prototype =>
                    prototype &&
                    (
                        typeof prototype
                            .dispatchEvent ===
                            "function" ||
                        typeof prototype
                            .__dispatchEvent ===
                            "function"
                    )
            ) ??
            null
        );
    }

    function installUIHook() {
        if (state.uiHookInstalled) {
            return true;
        }

        state.uiHookAttempts++;

        const prototype =
            findOpenFLPrototype();

        if (!prototype) {
            return false;
        }

        function hookMethod(methodName) {
            const original =
                prototype[methodName];

            if (
                typeof original !== "function"
            ) {
                return false;
            }

            if (
                original.__AVA_V11_HOOKED__
            ) {
                return true;
            }

            function wrapped(event) {
                inspectServiceObjects(
                    [event],
                    {
                        sourceMethod:
                            methodName,

                        functionSource:
                            functionSource(original),

                        rawArguments:
                            Array.from(arguments),

                        rawThis:
                            this,

                        stack:
                            new Error("Service object event").stack ??
                            null,

                        eventType:
                            event?.type ??
                            null,

                        rawEvent:
                            event,

                        rawDispatcher:
                            this,

                        eventTarget:
                            event?.target ??
                            null,

                        eventCurrentTarget:
                            event?.currentTarget ??
                            null
                    }
                );

                if (!state.uiTraceActive) {
                    return original.apply(
                        this,
                        arguments
                    );
                }

                const eventType =
                    String(
                        event?.type ?? ""
                    ).toLowerCase();

                if (
                    !ALLOWED_UI_EVENTS.has(
                        eventType
                    )
                ) {
                    return original.apply(
                        this,
                        arguments
                    );
                }

                if (
                    state.uiEvents.length >=
                    80
                ) {
                    state.uiTraceActive =
                        false;

                    console.warn(
                        "[AVA-V11 UI] Limite atteinte, trace arrêtée"
                    );

                    return original.apply(
                        this,
                        arguments
                    );
                }

                /*
                 * Pas de stack, pas de safePreview profond et
                 * aucun console.log dans ce point très fréquent.
                 */
                state.uiEvents.push({
                    index:
                        state.uiEvents.length,

                    label:
                        state.uiTraceLabel,

                    elapsedMs:
                        Math.round(
                            performance.now() -
                            state.uiTraceStartedAt
                        ),

                    method:
                        methodName,

                    eventType,

                    dispatcherType:
                        (() => {
                            try {
                                return (
                                    this
                                        ?.constructor
                                        ?.name ??
                                    typeof this
                                );
                            } catch {
                                return "[illisible]";
                            }
                        })(),

                    targetType:
                        (() => {
                            try {
                                return (
                                    event?.target
                                        ?.constructor
                                        ?.name ??
                                    typeof event
                                        ?.target
                                );
                            } catch {
                                return "[illisible]";
                            }
                        })(),

                    rawEvent:
                        event,

                    rawDispatcher:
                        this
                });

                return original.apply(
                    this,
                    arguments
                );
            }

            wrapped.__AVA_V11_HOOKED__ =
                true;

            wrapped.__AVA_V11_ORIGINAL__ =
                original;

            prototype[methodName] =
                wrapped;

            return true;
        }

        const dispatch =
            hookMethod("dispatchEvent");

        const internal =
            hookMethod("__dispatchEvent");

        state.uiHookInstalled =
            dispatch || internal;

        if (state.uiHookInstalled) {
            console.log(
                "[AVA-V11 UI] Hook OpenFL filtré installé"
            );
        }

        return state.uiHookInstalled;
    }

    /*
     * Installation tardive pour ne pas perturber le démarrage.
     */
    w.addEventListener(
        "load",
        () => {
            setTimeout(() => {
                installUIHook();
            }, 8000);
        },
        { once: true }
    );

    w.__AVA_INSTALL_UI_HOOK__ =
        installUIHook;

    /*
     * ============================================================
     * COMMANDES DE TRACE UI
     * ============================================================
     */

    w.__AVA_UI_START__ = function (
        label = "ui-action",
        durationMs = 2500
    ) {
        if (!state.uiHookInstalled) {
            installUIHook();
        }

        if (!state.uiHookInstalled) {
            console.error(
                "[AVA-V11 UI] Hook OpenFL indisponible"
            );

            return false;
        }

        if (state.uiStopTimer) {
            clearTimeout(
                state.uiStopTimer
            );
        }

        state.uiEvents.length = 0;
        state.uiTraceLabel = String(label);
        state.uiTraceStartedAt =
            performance.now();

        state.uiTraceActive = true;

        const duration =
            Math.max(
                300,
                Math.min(
                    Number(durationMs) ||
                        2500,
                    10000
                )
            );

        state.uiStopTimer =
            setTimeout(() => {
                state.uiTraceActive =
                    false;

                state.uiStopTimer =
                    null;

                console.log(
                    `[AVA-V11 UI] Capture terminée : ${state.uiEvents.length} événement(s)`
                );
            }, duration);

        console.log(
            `[AVA-V11 UI] Capture "${label}" pendant ${duration} ms`
        );

        return true;
    };

    w.__AVA_UI_STOP__ =
        function () {
            state.uiTraceActive =
                false;

            if (state.uiStopTimer) {
                clearTimeout(
                    state.uiStopTimer
                );

                state.uiStopTimer =
                    null;
            }

            return state.uiEvents;
        };

    w.__AVA_UI_LIST__ =
        function () {
            console.table(
                state.uiEvents.map(
                    entry => ({
                        index:
                            entry.index,

                        elapsedMs:
                            entry.elapsedMs,

                        method:
                            entry.method,

                        eventType:
                            entry.eventType,

                        dispatcherType:
                            entry.dispatcherType,

                        targetType:
                            entry.targetType
                    })
                )
            );

            return state.uiEvents;
        };

    w.__AVA_UI_SHOW__ =
        function (index) {
            const entry =
                state.uiEvents[
                    Number(index)
                ];

            if (!entry) {
                return null;
            }

            console.log(entry);
            console.log(
                "Événement :",
                entry.rawEvent
            );
            console.log(
                "Dispatcher :",
                entry.rawDispatcher
            );

            return entry;
        };

    /*
     * ============================================================
     * COMMANDES DE TRACE RÉSEAU
     * ============================================================
     */

    w.__AVA_NET_START__ =
        function (
            label = "network",
            clear = true
        ) {
            if (clear) {
                state.netTraces.length =
                    0;
            }

            state.netTraceLabel =
                String(label);

            state.netTraceStartedAt =
                performance.now();

            state.netTraceActive =
                true;

            return true;
        };

    w.__AVA_NET_STOP__ =
        function () {
            state.netTraceActive =
                false;

            return state.netTraces;
        };

    w.__AVA_NET_LIST__ =
        function () {
            console.table(
                state.netTraces.map(
                    trace => ({
                        index:
                            trace.index,

                        label:
                            trace.label,

                        elapsedMs:
                            trace.elapsedMs,

                        payloadSize:
                            trace.payloadSize,

                        usefulCalls:
                            trace.calls
                                .filter(call =>
                                    ![
                                        "flush",
                                        "send",
                                        "socket.send"
                                    ].includes(
                                        call.name
                                    )
                                )
                                .slice(0, 12)
                                .map(
                                    call =>
                                        call.name
                                )
                                .join(" → ")
                    })
                )
            );

            return state.netTraces;
        };

    w.__AVA_NET_SHOW__ =
        function (index) {
            const trace =
                state.netTraces[
                    Number(index)
                ];

            if (!trace) {
                return null;
            }

            console.log(trace);

            console.table(
                trace.calls.map(
                    call => ({
                        depth:
                            call.depth,

                        name:
                            call.name,

                        argumentTypes:
                            call.argumentTypes
                                .join(", "),

                        arguments:
                            JSON.stringify(
                                call.arguments
                            ).slice(0, 300)
                    })
                )
            );

            return trace;
        };

    w.__AVA_NET_COPY__ =
        function () {
            const exportData =
                state.netTraces.map(
                    trace => ({
                        index:
                            trace.index,

                        label:
                            trace.label,

                        elapsedMs:
                            trace.elapsedMs,

                        url:
                            trace.url,

                        payloadSize:
                            trace.payloadSize,

                        calls:
                            trace.calls.map(
                                call => ({
                                    depth:
                                        call.depth,

                                    name:
                                        call.name,

                                    source:
                                        call.source,

                                    argumentTypes:
                                        call
                                            .argumentTypes,

                                    arguments:
                                        call.arguments
                                })
                            )
                    })
                );

            const json =
                JSON.stringify(
                    exportData,
                    null,
                    2
                );

            copyText(
                json,
                "trace réseau"
            );

            return json;
        };

    /*
     * ============================================================
     * CAPTURE D’ACTION MÉTIER
     * ============================================================
     */

    w.__AVA_ACTION_START__ =
        function (
            label = "action",
            clear = true
        ) {
            if (clear) {
                state.actionCandidates.length =
                    0;
            }

            state.actionCaptureLabel =
                String(label);

            state.actionCaptureStartedAt =
                performance.now();

            state.actionCaptureActive =
                true;

            console.log(
                `[AVA-V11 ACTION] Capture démarrée : ${label}`
            );

            return true;
        };

    w.__AVA_ACTION_STOP__ =
        function () {
            state.actionCaptureActive =
                false;

            return state.actionCandidates;
        };

    w.__AVA_ACTION_LIST__ =
        function () {
            console.table(
                state.actionCandidates.map(
                    candidate => ({
                        index:
                            candidate.index,

                        depth:
                            candidate.depth,

                        name:
                            candidate.name,

                        count:
                            candidate.count,

                        argumentTypes:
                            candidate.argumentTypes
                                .join(", "),

                        arguments:
                            JSON.stringify(
                                candidate.arguments
                            ).slice(0, 250)
                    })
                )
            );

            return state.actionCandidates;
        };

    w.__AVA_ACTION_SHOW__ =
        function (index) {
            const candidate =
                state.actionCandidates[
                    Number(index)
                ];

            if (!candidate) {
                return null;
            }

            console.log(candidate);
            console.log(
                "Fonction :",
                candidate.rawFunction
            );
            console.log(
                "Arguments :",
                candidate.rawArguments
            );
            console.log(
                "Code :",
                candidate.source
            );

            return candidate;
        };

    /*
     * Appel sans contexte, utile uniquement pour diagnostiquer.
     * Une erreur "this.xxx is not a function" indique qu’il faut
     * ensuite capturer l’instance this.
     */
    w.__AVA_ACTION_TEST__ =
        function (index) {
            const candidate =
                state.actionCandidates[
                    Number(index)
                ];

            if (!candidate) {
                return false;
            }

            try {
                return candidate.rawFunction.apply(
                    null,
                    candidate.rawArguments
                );
            } catch (error) {
                console.error(
                    "[AVA-V11 ACTION] Appel sans contexte échoué",
                    error
                );

                return false;
            }
        };

    /*
     * ============================================================
     * DÉPLACEMENTS
     * ============================================================
     */

    w.__AVA_WALK_TO__ =
        function (x, y) {
            if (
                !state.actor ||
                typeof state.actor.addAction !==
                    "function"
            ) {
                console.error(
                    "[AVA-V11 WALK] Avatar non capturé"
                );

                return false;
            }

            if (
                typeof state.walkConstructor !==
                "function"
            ) {
                console.error(
                    "[AVA-V11 WALK] Constructeur non capturé"
                );

                return false;
            }

            try {
                const destination =
                    clonePoint(
                        state.pointTemplate,
                        x,
                        y
                    );

                const action =
                    new state.walkConstructor(
                        state.actor,
                        state.walkOptions.B3e ??
                            true,
                        null,
                        null
                    );

                try {
                    action.dest =
                        destination;
                } catch {
                    action.y3e =
                        destination;
                }

                state.actor.addAction(
                    action
                );

                return action;
            } catch (error) {
                console.error(
                    "[AVA-V11 WALK] Échec",
                    error
                );

                return false;
            }
        };

    w.__AVA_RECORD_START__ =
        function (
            clear = true
        ) {
            if (clear) {
                state.recordedMoves.length =
                    0;
            }

            state.moveRecordingStartedAt =
                performance.now();

            state.moveRecording =
                true;

            return true;
        };

    w.__AVA_RECORD_STOP__ =
        function () {
            state.moveRecording =
                false;

            return state.recordedMoves;
        };

    w.__AVA_RECORD_LIST__ =
        function () {
            console.table(
                state.recordedMoves
            );

            return state.recordedMoves;
        };

    w.__AVA_REPLAY_SEQUENCE__ =
        function (speed = 1) {
            const multiplier =
                Number(speed);

            if (
                !Number.isFinite(multiplier) ||
                multiplier <= 0 ||
                state.recordedMoves.length === 0
            ) {
                return false;
            }

            for (
                const timer of
                state.replayTimers
            ) {
                clearTimeout(timer);
            }

            state.replayTimers.length =
                0;

            state.replaying = true;

            const firstElapsed =
                state.recordedMoves[0]
                    .elapsedMs;

            for (
                const move of
                state.recordedMoves
            ) {
                const delay =
                    (
                        move.elapsedMs -
                        firstElapsed
                    ) /
                    multiplier;

                const timer =
                    setTimeout(() => {
                        w.__AVA_WALK_TO__(
                            move.destination.x,
                            move.destination.y
                        );
                    }, delay);

                state.replayTimers.push(
                    timer
                );
            }

            const finalDelay =
                (
                    state.recordedMoves
                        .at(-1)
                        .elapsedMs -
                    firstElapsed
                ) /
                    multiplier +
                500;

            state.replayTimers.push(
                setTimeout(() => {
                    state.replaying =
                        false;
                }, finalDelay)
            );

            return true;
        };

    /*
     * ============================================================
     * AIDE
     * ============================================================
     */

    w.__AVA_IS_WORK_FINISHED__ =
        isCurrentWorkFinished;

    w.__AVA_DEBUG_WORK_FINISHED__ = function () {
        return findVisibleFinishedWorkText({ debug: true });
    };

    w.__AVA_HELP__ = function () {
        const commands = [
            {
                section: "Network",
                commands: "__AVA_NET_START__, __AVA_NET_STOP__, __AVA_NET_LIST__, __AVA_NET_SHOW__, __AVA_NET_COPY__"
            },
            {
                section: "UI",
                commands: "__AVA_INSTALL_UI_HOOK__, __AVA_UI_START__, __AVA_UI_STOP__, __AVA_UI_LIST__, __AVA_UI_SHOW__"
            },
            {
                section: "Walk",
                commands: "__AVA_WALK_TO__"
            },
            {
                section: "Recording",
                commands: "__AVA_RECORD_START__, __AVA_RECORD_STOP__, __AVA_RECORD_LIST__"
            },
            {
                section: "Replay",
                commands: "__AVA_REPLAY_SEQUENCE__"
            },
            {
                section: "Destination commands",
                commands: "__AVA_LIST_DESTINATIONS__, __AVA_GO_WORK__, __AVA_GO_HOUSE__, __AVA_RETURN_HOME__, __AVA_GO_<DESTINATION>__, __AVA_GO_YARD__, __AVA_GO_GARDEN__, __AVA_GO_RESTAURANT__, __AVA_GO_SCULPT__, __AVA_GO_SCHOOL__, __AVA_GO_NPC_HOUSE__, __AVA_GO_FORTUNE__, __AVA_GO_FORTUNE2__, __AVA_GO_FORTUNE3__"
            },
            {
                section: "Refrigerators",
                commands: "__AVA_LIST_FRIDGES__, __AVA_EAT_FROM_FRIDGE__, __AVA_EAT_AVAILABLE__"
            },
            {
                section: "Action capture",
                commands: "__AVA_ACTION_START__, __AVA_ACTION_STOP__, __AVA_ACTION_LIST__, __AVA_ACTION_SHOW__, __AVA_ACTION_TEST__"
            },
            {
                section: "Service object capture",
                commands: "__AVA_SERVICE_START__, __AVA_SERVICE_STOP__, __AVA_SERVICE_LIST__, __AVA_SERVICE_SHOW__, __AVA_SERVICE_LAST__, __AVA_SERVICE_CLEAR__"
            },
            {
                section: "Map cleaner",
                commands: "__AVA_MAP_CLEANER__.start(), __AVA_MAP_CLEANER__.stop(), __AVA_MAP_CLEANER__.pause(), __AVA_MAP_CLEANER__.resume(), __AVA_MAP_CLEANER__.status(), __AVA_MAP_CLEANER__.getStatus(), __AVA_MAP_CLEANER__.getEnergy(), __AVA_MAP_CLEANER__.refreshEnergyField(), __AVA_MAP_CLEANER__.testButterfly(), __AVA_MAP_CLEANER__.catchNearestButterfly(), __AVA_MAP_CLEANER__.inspectCandidates(), __AVA_MAP_CLEANER__.listDetectedTypes(), __AVA_MAP_CLEANER__.getRawCandidate(), __AVA_MAP_CLEANER__.inspectInteractionMethods(), __AVA_MAP_CLEANER__.uninstall()"
            },
            {
                section: "Auto clean loop",
                commands: "__AVA_AUTO_CLEAN_LOOP__.on(), __AVA_AUTO_CLEAN_LOOP__.off(), __AVA_AUTO_CLEAN_LOOP__.toggle(), __AVA_AUTO_CLEAN_LOOP__.status(), __AVA_FIND_SHIFT_COUNTDOWN__(), __AVA_SHIFT_STATUS__()"
            },
            {
                section: "Crash recovery",
                commands: "__AVA_RECOVERY_STATUS__(), __AVA_IS_WORK_FINISHED__(), __AVA_DEBUG_WORK_FINISHED__()"
            },
            {
                section: "Status",
                commands: "__AVA_STATUS__, __AVA_HELP__"
            }
        ];

        console.table(commands);
        return commands;
    };

    /*
     * ============================================================
     * STATUS
     * ============================================================
     */

    w.__AVA_STATUS__ =
        function () {
            const status = {
                installed:
                    w.__AVA_V11_INSTALLED__,

                sockets:
                    state.sockets.length,

                wsFrames:
                    state.wsFrames.length,

                uiHookInstalled:
                    state.uiHookInstalled,

                uiTraceActive:
                    state.uiTraceActive,

                uiEvents:
                    state.uiEvents.length,

                netTraceActive:
                    state.netTraceActive,

                netTraces:
                    state.netTraces.length,

                actionCaptureActive:
                    state.actionCaptureActive,

                actionCandidates:
                    state.actionCandidates.length,

                serviceObjectCaptureActive:
                    state.serviceObjectCaptureActive,

                serviceObjectCaptureLabel:
                    state.serviceObjectCaptureLabel,

                serviceObjectCaptures:
                    state.serviceObjectCaptures.length,

                lastServiceObjectId:
                    serviceCandidateInfo(state.lastServiceObject)?.objectId ??
                    null,

                lastServiceShopItemTypeId:
                    serviceCandidateInfo(state.lastServiceObject)?.shopItemTypeId ??
                    null,

                walksCaptured:
                    state.walks.length,

                actorSaved:
                    Boolean(state.actor),

                recordedMoves:
                    state.recordedMoves.length,

                destinationIds:
                    state.destinationIds.length,

                destinationCommandsReady:
                    state.destinationCommandsReady,

                destinationMenuReady:
                    state.destinationMenuReady,

                savedHouse:
                    state.houseInfo
                        ? { ...state.houseInfo }
                        : null,

                energyRecovery:
                    {
                        inProgress: energyRecoveryState.inProgress,
                        phase: energyRecoveryState.phase,
                        savedWork: energyRecoveryState.savedWork,
                        eatenCount: energyRecoveryState.eatenCount,
                        requestedCount: energyRecoveryState.requestedCount,
                        retryAfter: energyRecoveryState.retryAfter,
                        lastError: energyRecoveryState.lastError
                    },

                mapCleanerRunning:
                    w.__AVA_MAP_CLEANER__?.running ??
                    false,

                mapCleanerPaused:
                    w.__AVA_MAP_CLEANER__?.paused ??
                    false,

                mapCleanerPauseReason:
                    w.__AVA_MAP_CLEANER__?.pauseReason ??
                    null,

                mapCleanerBusy:
                    w.__AVA_MAP_CLEANER__?.busy ??
                    false,

                mapCleanerCurrentMap:
                    w.__AVA_MAP_CLEANER__?.currentMap ??
                    null,

                mapCleanerCleanedObjects:
                    w.__AVA_MAP_CLEANER__?.cleanedObjects ??
                    0,

                mapCleanerCompletedObjects:
                    w.__AVA_MAP_CLEANER__?._completedObjects?.size ??
                    0,

                mapCleanerPendingObjects:
                    w.__AVA_MAP_CLEANER__?._pendingObjects?.size ??
                    0,

                mapCleanerInactiveObjects:
                    w.__AVA_MAP_CLEANER__?._inactiveObjects?.size ??
                    0,

                mapCleanerTargetSelectionMode:
                    w.__AVA_MAP_CLEANER__?.config?.targetSelectionMode ??
                    null,

                mapCleanerEnergy:
                    w.__AVA_MAP_CLEANER__?.getEnergy?.() ??
                    null,

                autoCleanLoopEnabled:
                    w.__AVA_AUTO_CLEAN_LOOP__?.enabled ??
                    false,

                autoCleanLoopScriptToggle:
                    AVA_AUTO_CLEAN_LOOP_ON,

                autoCleanLoopIdleMs:
                    w.__AVA_AUTO_CLEAN_LOOP__?.idleMs ??
                    AVA_AUTO_CLEAN_LOOP_FULL_THEN_YARD_MS,

                autoCleanLoopCycleMode:
                    w.__AVA_AUTO_CLEAN_LOOP__?.cycleMode ??
                    null,

                autoCleanLoopNextCycleMode:
                    w.__AVA_AUTO_CLEAN_LOOP__?.nextCycleMode ??
                    null,

                autoCleanLoopPhase:
                    w.__AVA_AUTO_CLEAN_LOOP__?.phase ??
                    null,

                autoCleanLoopNextReloadInMs:
                    (
                        w.__AVA_AUTO_CLEAN_LOOP__?.status?.() ??
                        {}
                    ).nextReloadInMs ??
                    null,

                crashRecovery:
                    w.__AVA_RECOVERY_STATUS__?.() ??
                    null,

                currentAvatarCaptured:
                    Boolean(w.__AVA_CURRENT_AVATAR__),

                callerErrors:
                    state.callerErrors.length
            };

            console.table(status);

            return status;
        };

    initializeDestinationSystem();
    initializeHouseSystem();
    initializeMapCleaner();
    installMapCleanerWhenReady();
    initializeAutoCleanLoop();
    w.__AVA_RECOVERY_STATUS__ = function () {
        return {
            recoveryInProgress: crashRecoveryState.recoveryInProgress,
            checkpointFound: crashRecoveryState.checkpointFound,
            checkpointAgeMs: crashRecoveryState.checkpointSavedAt
                ? Date.now() - crashRecoveryState.checkpointSavedAt
                : null,
            targetMap: crashRecoveryState.targetMap,
            interruptedTargetId: crashRecoveryState.interruptedTargetId,
            phase: crashRecoveryState.phase,
            lastRecoveryError: crashRecoveryState.lastRecoveryError,
            energyRecovery: {
                inProgress: energyRecoveryState.inProgress,
                phase: energyRecoveryState.phase,
                savedWork: energyRecoveryState.savedWork,
                eatenCount: energyRecoveryState.eatenCount,
                requestedCount: energyRecoveryState.requestedCount,
                retryAfter: energyRecoveryState.retryAfter,
                lastError: energyRecoveryState.lastError
            }
        };
    };
    startCrashRecoveryIfNeeded().then(recovered => {
        if (!recovered && w.__AVA_AUTO_CLEAN_LOOP__?.enabled) {
            w.__AVA_AUTO_CLEAN_LOOP__._startCycleWhenReady();
        }
    });
    startChildHeartbeat();

    console.log(
        "%c[AVA-V12] Safe Inspector installé",
        "color:#9c27b0;font-weight:bold"
    );
})();

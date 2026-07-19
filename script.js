// ==UserScript==
// @name         Avataria Safe Inspector V11
// @namespace    local-debug
// @version      11.0
// @description  Inspection réseau, WalkAction et événements UI filtrés
// @match        https://cdn-sp.tortugasocial.com/avataria-vk/app/index_js.html*
// @run-at       document-start
// @grant        unsafeWindow
// @grant        GM_setClipboard
// ==/UserScript==

(function () {
    /*
     * Ne pas ajouter "use strict".
     *
     * La capture des fonctions métier utilise encore
     * Function.caller et Function.arguments.
     */

    const w = unsafeWindow;

    if (w.__AVA_V11_INSTALLED__) {
        console.warn("[AVA-V11] Déjà installé");
        return;
    }

    w.__AVA_V11_INSTALLED__ = true;

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
         * Diagnostics
         */
        callerErrors: []
    };

    w.__AVA_V11 = state;

    const seenWalkActions = new WeakSet();

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

                walksCaptured:
                    state.walks.length,

                actorSaved:
                    Boolean(state.actor),

                recordedMoves:
                    state.recordedMoves.length,

                callerErrors:
                    state.callerErrors.length
            };

            console.table(status);

            return status;
        };

    console.log(
        "%c[AVA-V11] Safe Inspector installé",
        "color:#9c27b0;font-weight:bold"
    );
})();
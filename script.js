// ==UserScript==
// @name         Avataria Safe Inspector V12
// @namespace    local-debug
// @version      12.0
// @description  Inspection réseau, WalkAction et événements UI filtrés
// @match        https://cdn-sp.tortugasocial.com/avataria-vk/app/index_js.html*
// @run-at       document-start
// @grant        unsafeWindow
// @grant        GM_setClipboard
// @grant        GM_registerMenuCommand
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

    function objectPositionKey(object) {
        try {
            const position = object?.position ?? object?.pos ?? object?.fe ?? null;
            const x = position?.x ?? object?.x;
            const y = position?.y ?? object?.y;
            return x === undefined && y === undefined ? null : `${String(x)},${String(y)}`;
        } catch {
            return null;
        }
    }

    function stableObjectId(object) {
        const parts = [];
        try {
            if (object?.objectId !== undefined) {
                parts.push(String(object.objectId));
            }
        } catch {}
        const typeId = objectTypeId(object);
        const position = objectPositionKey(object);
        const className = objectClassName(object);
        if (typeId !== null && typeId !== undefined) {
            parts.push(String(typeId));
        }
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

    function classOrTypeAllowed(object, config) {
        const className = objectClassName(object);
        const typeId = objectTypeId(object);
        const classes = config.allowedClasses ?? [];
        const typeIds = config.allowedTypeIds ?? [];
        if (typeId && typeIds.includes(String(typeId))) {
            return true;
        }
        if (className && classes.includes(className)) {
            return true;
        }
        return classes.length === 0 && typeIds.length === 0;
    }

    function isCleanableObject(object, config) {
        try {
            const hasInteractionApi = typeof object?.getInteractPoint === "function" && typeof object?.startInteraction === "function";
            const hasQueueApi = typeof object?.readyInteract === "function" && typeof object?.canAddToQueue === "function";
            if (!hasInteractionApi && !hasQueueApi) {
                return false;
            }
            if (!hasWorldReference(object)) {
                return false;
            }
            if (!callBooleanMethod(object, "readyInteract") || !callBooleanMethod(object, "canAddToQueue")) {
                return false;
            }
            return classOrTypeAllowed(object, config);
        } catch {
            return false;
        }
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
        return uniqueObjects(objects);
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
                        cleaner._completeInteraction(token, "finishInteraction");
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
                maps: ["garbage", "garden", "restaurant", "schoolAvataria", "sculpt"],
                allowedClasses: ["GarbageObject", "GardenObject", "RestaurantObject"],
                allowedTypeIds: ["gbTrashEnrg"],
                interactionTimeout: 40000,
                scanDelay: 500,
                emptyScansRequired: 3,
                emptyScanInterval: 1000,
                mapLoadTimeout: 30000,
                mapStableMs: 2500,
                maxRetriesPerObject: 3,
                worldScanDepth: 5,
                maxWorldScanObjects: 6000
            },
            running: false,
            paused: false,
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
            _wrappedTargets: [],
            _activeAction: null,
            _lastScanTargets: [],

            start(options = {}) {
                if (this.running) {
                    cleanerWarn("Already running");
                    return false;
                }
                Object.assign(this.config, options ?? {});
                installAvatarCapture();
                this.running = true;
                this.paused = false;
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
                this._lastScanTargets = [];
                cleanerLog("Started");
                this._moveToConfiguredMap();
                return true;
            },

            stop() {
                this.running = false;
                this.paused = false;
                this._clearTimers();
                this._restoreWrappedTargets();
                this.remainingTargets = 0;
                cleanerLog("Stopped", this._summary());
                return this.status();
            },

            pause() {
                this.paused = true;
                cleanerLog("Paused");
                return this.status();
            },

            resume() {
                if (!this.running) {
                    return false;
                }
                this.paused = false;
                this._emptyScans = 0;
                cleanerLog("Resumed");
                this._scheduleScan(0);
                return true;
            },

            status() {
                return {
                    running: this.running,
                    paused: this.paused,
                    busy: this.busy,
                    currentMap: this.currentMap,
                    currentTarget: this.currentTarget ? stableObjectId(this.currentTarget) : null,
                    cleanedObjects: this.cleanedObjects,
                    failedObjects: this.failedObjects,
                    remainingTargets: this.remainingTargets,
                    visitedMaps: this.visitedMaps.slice(),
                    interactionToken: this.interactionToken,
                    totalAttempts: this.totalAttempts,
                    durationMs: this.startedAt ? Math.round(performance.now() - this.startedAt) : 0
                };
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
                this._lastScanTargets = [];
                this._restoreWrappedTargets();
                cleanerLog(`Moving to ${mapId}`);
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
                            this._scheduleScan(0);
                        } else {
                            this._waitForMapLoad(mapId, previousAvatar, startedAt);
                        }
                    }, this.config.mapStableMs);
                    return;
                }
                if (performance.now() - startedAt > this.config.mapLoadTimeout) {
                    cleanerWarn(`Map load timeout: ${mapId}`);
                    this._scheduleScan(0);
                    return;
                }
                this._setTimer(() => this._waitForMapLoad(mapId, previousAvatar, startedAt), 500);
            },

            _scheduleScan(delay = this.config.scanDelay) {
                if (!this.running) {
                    return;
                }
                this._setTimer(() => this._scanAndRun(), delay);
            },

            _scanAndRun() {
                if (!this.running || this.paused) {
                    return;
                }
                if (this.busy) {
                    cleanerWarn("Interaction already running");
                    return;
                }
                const targets = discoverCleanableObjects(this.config).filter(target => {
                    const targetId = stableObjectId(target);
                    return (
                        !this._completedObjects.has(targetId) &&
                        !this._skippedObjects.has(targetId)
                    );
                });
                this._lastScanTargets = targets;
                this.remainingTargets = targets.length;
                cleanerLog(`${targets.length} target${targets.length === 1 ? "" : "s"} remaining`);
                if (targets.length === 0) {
                    this._handleEmptyScan();
                    return;
                }
                this._emptyScans = 0;
                this._startInteraction(targets[0]);
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
                this.visitedMaps.push(mapId);
                cleanerLog(`Map complete: ${mapId}`);
                this._mapIndex++;
                this._moveToConfiguredMap();
            },

            _startInteraction(target) {
                if (this.busy) {
                    cleanerWarn("Interaction already running");
                    return false;
                }
                const avatar = w.__AVA_CURRENT_AVATAR__ ?? null;
                const InteractAction = getInteractActionClass();
                const targetId = stableObjectId(target);
                if (!avatar || typeof avatar.addAction !== "function" || !InteractAction) {
                    this._registerFailure(targetId, "missing avatar or InteractAction");
                    this._scheduleScan(this.config.scanDelay);
                    return false;
                }
                if (!isCleanableObject(target, this.config)) {
                    this._registerFailure(targetId, "invalid target");
                    this._scheduleScan(this.config.scanDelay);
                    return false;
                }
                const attempt = (this._attempts.get(targetId) ?? 0) + 1;
                this._attempts.set(targetId, attempt);
                this.totalAttempts++;
                if (attempt > 1) {
                    cleanerLog(`Retrying ${targetId}, attempt ${attempt}/${this.config.maxRetriesPerObject}`);
                }
                if (attempt > this.config.maxRetriesPerObject) {
                    this._skipObject(targetId);
                    this._scheduleScan(this.config.scanDelay);
                    return false;
                }
                this.busy = true;
                this.currentTarget = target;
                this.interactionToken++;
                const token = this.interactionToken;
                cleanerLog(`Cleaning ${targetId}`);
                installFinishInteractionWatch(target, this, token);
                try {
                    const action = new InteractAction(target, null);
                    this._activeAction = action;
                    avatar.addAction(action);
                    this._watchInteraction(token, target, action, performance.now());
                    return true;
                } catch (error) {
                    cleanerWarn(`Interaction failed: ${targetId}`, error);
                    this._completeInteraction(token, "exception", false);
                    return false;
                }
            },

            _watchInteraction(token, target, action, startedAt) {
                if (!this.running || token !== this.interactionToken || !this.busy) {
                    return;
                }
                const targetId = stableObjectId(target);
                const avatar = w.__AVA_CURRENT_AVATAR__ ?? null;
                if (!hasWorldReference(target)) {
                    this._completeInteraction(token, "detached");
                    return;
                }
                if (performance.now() - startedAt > this.config.interactionTimeout) {
                    cleanerWarn(`Interaction timeout: ${targetId}`);
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
                if (success) {
                    if (targetId) {
                        this._completedObjects.add(targetId);
                    }
                    this.cleanedObjects++;
                    cleanerLog(`Completed ${targetId ?? "object"}`);
                } else if (targetId) {
                    this._registerFailure(targetId, reason);
                }
                if (this.running && !this.paused) {
                    this._scheduleScan(this.config.scanDelay);
                }
                return true;
            },

            _registerFailure(targetId, reason) {
                const attempts = this._attempts.get(targetId) ?? 1;
                cleanerWarn(`${targetId} failed: ${reason}`);
                if (attempts >= this.config.maxRetriesPerObject) {
                    this._skipObject(targetId);
                }
            },

            _skipObject(targetId) {
                if (this._skippedObjects.has(targetId)) {
                    return;
                }
                this._skippedObjects.add(targetId);
                this.failedObjects++;
                cleanerWarn(`Object skipped after ${this.config.maxRetriesPerObject} failures`, targetId);
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
                commands: "__AVA_LIST_DESTINATIONS__, __AVA_GO_WORK__, __AVA_GO_<DESTINATION>__, __AVA_GO_YARD__, __AVA_GO_GARDEN__, __AVA_GO_RESTAURANT__, __AVA_GO_SCULPT__, __AVA_GO_SCHOOL__, __AVA_GO_NPC_HOUSE__, __AVA_GO_FORTUNE__, __AVA_GO_FORTUNE2__, __AVA_GO_FORTUNE3__"
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
                commands: "__AVA_MAP_CLEANER__.start(), __AVA_MAP_CLEANER__.stop(), __AVA_MAP_CLEANER__.pause(), __AVA_MAP_CLEANER__.resume(), __AVA_MAP_CLEANER__.status(), __AVA_MAP_CLEANER__.uninstall()"
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

                mapCleanerRunning:
                    w.__AVA_MAP_CLEANER__?.running ??
                    false,

                mapCleanerPaused:
                    w.__AVA_MAP_CLEANER__?.paused ??
                    false,

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

                currentAvatarCaptured:
                    Boolean(w.__AVA_CURRENT_AVATAR__),

                callerErrors:
                    state.callerErrors.length
            };

            console.table(status);

            return status;
        };

    initializeDestinationSystem();
    initializeMapCleaner();
    installMapCleanerWhenReady();

    console.log(
        "%c[AVA-V12] Safe Inspector installé",
        "color:#9c27b0;font-weight:bold"
    );
})();
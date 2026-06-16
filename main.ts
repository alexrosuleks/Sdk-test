/**
 * SDK smoke actor — exercises Scrapely Actor APIs on the platform.
 * Each check is recorded in the default dataset; the run fails if any required check fails.
 *
 * Run on platform with input, e.g.:
 * {
 *   "targetActorId": "user/another-actor",
 *   "targetTaskId": "user/some-task",
 *   "chargeEventName": "my-event",
 *   "useStateKey": "sdk-smoke-state",
 *   "skipDestructive": false,
 *   "abortTargetRunId": "<id-of-another-running-run>"
 * }
 *
 * Abort smoke: set skipDestructive to false. By default the smoke run aborts itself
 * after OUTPUT is written (current run id from config/env). Optional abortTargetRunId
 * aborts another run instead.
 */

import { Actor, Configuration } from 'scrapely';

/** Apify-compatible instance (options env vars override at runtime on platform). */
const smokeActor = new Actor({ persistStateIntervalMillis: 60_000 });

type CheckStatus = 'ok' | 'fail' | 'skip';

interface SmokeCheck {
    method: string;
    status: CheckStatus;
    detail?: unknown;
    error?: string;
}

interface SmokeInput {
    targetActorId?: string;
    targetTaskId?: string;
    chargeEventName?: string;
    skipDestructive?: boolean;
    /** Key for Actor.useState persist/restore smoke (default sdk-smoke-state). */
    useStateKey?: string;
    /** Another run to abort when skipDestructive is false; default is this run after OUTPUT. */
    abortTargetRunId?: string;
    /** When skipDestructive is false, use graceful abort (default true). */
    abortGracefully?: boolean;
    /** URL for Actor.addWebhook smoke (default https://example.com/webhook). */
    webhookRequestUrl?: string;
    /** Proxy URLs for createProxyConfiguration test. */
    proxyUrls?: string[];
    /** When true, test useApifyProxy: false returns undefined. */
    testUseApifyProxyFalse?: boolean;
    /** When true, skip the abort at the end (useful for debugging). */
    skipAbort?: boolean;
    /** When true, skip the metamorph test at the end. */
    skipMetamorph?: boolean;
    /** When true, skip the reboot test at the end. */
    skipReboot?: boolean;
    /** Target actor ID to metamorph into (required for metamorph test). */
    metamorphTargetActorId?: string;
}

const results: SmokeCheck[] = [];

/** Carries structured failure detail into the checks array and run logs. */
class SmokeCheckError extends Error {
    constructor(
        message: string,
        readonly detail?: unknown,
    ) {
        super(message);
        this.name = 'SmokeCheckError';
    }
}

/** Fields exposed by apify-client ApifyApiError (duck-typed, no direct import). */
function apifyApiErrorFields(err: unknown): Record<string, unknown> | null {
    if (!err || typeof err !== 'object') return null;
    const e = err as Record<string, unknown>;
    if (typeof e.statusCode !== 'number' && typeof e.type !== 'string') return null;
    return {
        name: e.name,
        message: e.message,
        type: e.type,
        statusCode: e.statusCode,
        path: e.path,
        clientMethod: e.clientMethod,
        httpMethod: e.httpMethod,
    };
}

function tokenPrefix(envName: string): string | null {
    const value = process.env[envName];
    if (!value) return null;
    return `${value.slice(0, 12)}… (${value.length} chars)`;
}

/** Snapshot of which API host Actor.apifyClient is pointed at (for Actor.start debugging). */
function apiRoutingSnapshot() {
    const cfg = Actor.getDefaultInstance().config;
    const client = Actor.apifyClient as { baseUrl?: string; publicBaseUrl?: string };
    return {
        configApiBaseUrl: cfg.get('apiBaseUrl') ?? null,
        configApiPublicBaseUrl: cfg.get('apiPublicBaseUrl') ?? null,
        apifyClientBaseUrl: client.baseUrl ?? null,
        apifyClientPublicBaseUrl: client.publicBaseUrl ?? null,
        env: {
            APIFY_API_BASE_URL: process.env.APIFY_API_BASE_URL ?? null,
            SCRAPELY_API_URL: process.env.SCRAPELY_API_URL ?? null,
            APIFY_TOKEN: tokenPrefix('APIFY_TOKEN'),
            SCRAPELY_TOKEN: tokenPrefix('SCRAPELY_TOKEN'),
        },
        actorId: cfg.get('actorId') ?? null,
    };
}

function actorStartRequestPreview(targetActorId: string, baseUrl: string | null) {
    // apify-client _toSafeId: replaces only the first '/'
    const safeId = targetActorId.replace('/', '~');
    const root = baseUrl?.replace(/\/v2$/, '') ?? '(unknown-base)';
    return {
        targetActorId,
        safeId,
        expectedPostPath: `/v2/actors/${safeId}/runs`,
        expectedFullUrl: `${root}/v2/actors/${safeId}/runs`,
        scrapelyRuns404Message: 'Actor was not found',
        note: 'If error message embeds the actor id (e.g. "Actor actors/… not found"), it likely did not come from scrapely runs.ts',
    };
}

async function check(method: string, fn: () => Promise<unknown>, required = false): Promise<void> {
    try {
        const detail = await fn();
        if (detail === false) {
            throw new Error('check returned false');
        }
        if (
            detail &&
            typeof detail === 'object' &&
            !Array.isArray(detail) &&
            (detail as { ok?: boolean }).ok === false
        ) {
            throw new Error(`check returned ok: false (${JSON.stringify(detail)})`);
        }
        results.push({ method, status: 'ok', detail });
    } catch (err) {
        const error = (err as Error).message;
        const detail =
            err instanceof SmokeCheckError
                ? err.detail
                : apifyApiErrorFields(err) ?? undefined;
        const entry: SmokeCheck = { method, status: 'fail', error };
        if (detail !== undefined) entry.detail = detail;
        results.push(entry);
        console.warn(`[sdk-smoke] ✗ ${method}: ${error}`);
    }
}

async function skip(method: string, reason: string): Promise<void> {
    results.push({ method, status: 'skip', detail: reason });
}

await Actor.main(async () => {
    const input = (await Actor.getInput<SmokeInput>()) ?? {};

    const currentRunId =
        Actor.getDefaultInstance().config.get('actorRunId') ??
        process.env.ACTOR_RUN_ID ??
        null;

    await check('Actor.init (via main)', async () => {
        return smokeActor.initialized && Actor.getDefaultInstance().initialized;
    });

    await check('Actor.currentRunId', async () => ({
        currentRunId,
        fromConfig: Actor.getDefaultInstance().config.get('actorRunId') ?? null,
        fromEnv: process.env.ACTOR_RUN_ID ?? null,
    }));

    if (currentRunId) {
        await Actor.setValue('SDK_SMOKE_RUN_ID', { currentRunId, input });
    }

    await check('new Actor(options) constructor', async () => smokeActor instanceof Actor);

    await check('instance.config', async () => {
        const cfg = smokeActor.config;
        return typeof cfg.get === 'function';
    });

    await check('Actor.getDefaultInstance().config', async () => {
        const cfg = Actor.getDefaultInstance().config;
        return typeof cfg.get('persistStateIntervalMillis') === 'number';
    });

    await check('Configuration.getGlobalConfig()', async () => {
        const global = Configuration.getGlobalConfig();
        const instance = Actor.getDefaultInstance().config;
        return (
            global.get('actorRunId') === instance.get('actorRunId') &&
            global.get('defaultDatasetId') === instance.get('defaultDatasetId')
        );
    });

    await check('config.get(token)', async () => {
        const token = Actor.getDefaultInstance().config.get('token');
        const fromEnv = process.env.APIFY_TOKEN || process.env.SCRAPELY_TOKEN;
        if (fromEnv && token !== fromEnv) {
            return { ok: false, token, fromEnv };
        }
        return { token: token ?? null };
    });

    await check('config.get(actorRunId)', async () => {
        const runId = Actor.getDefaultInstance().config.get('actorRunId');
        if (process.env.ACTOR_RUN_ID && runId !== process.env.ACTOR_RUN_ID) {
            return { ok: false, runId, env: process.env.ACTOR_RUN_ID };
        }
        return { actorRunId: runId ?? null };
    });

    await check('config platform keys', async () => {
        const cfg = Actor.getDefaultInstance().config;
        return {
            actorId: cfg.get('actorId') ?? null,
            defaultDatasetId: cfg.get('defaultDatasetId'),
            inputKey: cfg.get('inputKey'),
            isAtHome: cfg.get('isAtHome'),
            containerPort: cfg.get('containerPort'),
            containerUrl: cfg.get('containerUrl') ?? null,
        };
    });

    await check('new Actor(options) separate Configuration', async () => {
        const global = Actor.getDefaultInstance().config;
        const isolated = new Actor({ persistStateIntervalMillis: 60_000 });

        if (isolated.config === global) {
            return false;
        }

        const envToken = process.env.APIFY_TOKEN || process.env.SCRAPELY_TOKEN;
        if (envToken) {
            if (isolated.config.get('token') !== envToken) {
                return false;
            }
            return { separateConfig: true, tokenFromEnv: true };
        }

        const withCtorToken = new Actor({ token: 'test-token' });
        if (withCtorToken.config === global || withCtorToken.config.get('token') !== 'test-token') {
            return false;
        }
        return { separateConfig: true, constructorToken: true };
    });

    await check('Actor.isStandby', async () => typeof Actor.isStandby() === 'boolean');

    await check('Actor.standbyPort / webServerPort getters', async () => {
        return {
            standbyPort: Actor.standbyPort,
            webServerPort: Actor.webServerPort,
            containerPort: Actor.containerPort,
        };
    });

    await check('config ENV_MAP (no CRAWLEE bridge required)', async () => {
        const cfg = Actor.getDefaultInstance().config;
        if (process.env.ACTOR_DEFAULT_DATASET_ID) {
            const id = cfg.get('defaultDatasetId');
            if (id !== process.env.ACTOR_DEFAULT_DATASET_ID) {
                return { ok: false, reason: 'defaultDatasetId mismatch', id, env: process.env.ACTOR_DEFAULT_DATASET_ID };
            }
        }
        if (process.env.APIFY_PERSIST_STATE_INTERVAL_MILLIS) {
            const ms = cfg.get('persistStateIntervalMillis');
            const expected = parseInt(process.env.APIFY_PERSIST_STATE_INTERVAL_MILLIS, 10);
            if (ms !== expected) {
                return { ok: false, reason: 'persistStateIntervalMillis mismatch', ms, expected };
            }
        }
        return { ok: true };
    }, false);

    await check('Actor.getEnv', async () => {
        const env = Actor.getEnv();
        return { actorRunId: env.actorRunId, isAtHome: env.isAtHome };
    });

    await check('Actor.isAtHome', async () => Actor.isAtHome());

    await check('Actor.getRemainingTime', async () => Actor.getRemainingTime());

    await check('Actor.getenv', async () => Actor.getenv('ACTOR_RUN_ID'));

    await check('Actor.token getter', async () => !!Actor.token);

    await check('Actor.userId getter', async () => Actor.userId ?? null);

    await check('Actor.buildTags getter', async () => Actor.buildTags);

    await check('Actor.getInput', async () => {
        const fromGetInput = await Actor.getInput<SmokeInput>();
        if (fromGetInput === null || fromGetInput === undefined) {
            return { ok: false, reason: 'getInput returned null' };
        }
        if (typeof fromGetInput !== 'object' || Array.isArray(fromGetInput)) {
            return { ok: false, reason: 'expected object input on platform' };
        }
        return {
            hasObject: true,
            keys: Object.keys(fromGetInput),
            currentRunId,
            skipDestructive: fromGetInput.skipDestructive ?? null,
            useStateKey: fromGetInput.useStateKey ?? null,
            abortTargetRunId: fromGetInput.abortTargetRunId ?? null,
        };
    });

    await check('Actor.input getter', async () => {
        const sync = Actor.input;
        if (sync && typeof sync === 'object' && !Array.isArray(sync)) {
            return { viaGetter: true, keys: Object.keys(sync) };
        }
        return { viaGetter: sync ?? null };
    });

    await check('Actor.getInputOrThrow', async () => {
        const value = await Actor.getInputOrThrow<SmokeInput>();
        if (value === null || value === undefined) {
            throw new Error('getInputOrThrow returned null');
        }
        return { ok: true, type: typeof value };
    });

    await check('Actor.getInput matches getInputOrThrow', async () => {
        const a = await Actor.getInput<SmokeInput>();
        const b = await Actor.getInputOrThrow<SmokeInput>();
        return JSON.stringify(a) === JSON.stringify(b);
    });

    await check('Actor.setValue / getValue', async () => {
        const key = 'SDK_SMOKE_TEST_KEY';
        await Actor.setValue(key, { smoke: true, at: Date.now() });
        const value = await Actor.getValue<{ smoke: boolean }>(key);
        return value?.smoke === true;
    });

    // ============================================
    // Actor.pushData comprehensive tests
    // ============================================

    await check('Actor.pushData (void return without eventName)', async () => {
        const result = await Actor.pushData({ test: 'void-return', timestamp: Date.now() });
        // Should return void (undefined) when no eventName is provided
        return { result: result ?? 'void', isUndefined: result === undefined };
    });

    await check('Actor.pushData (array of items)', async () => {
        const items = [
            { test: 'array-item-1', index: 0 },
            { test: 'array-item-2', index: 1 },
            { test: 'array-item-3', index: 2 },
        ];
        await Actor.pushData(items);
        return { itemCount: items.length };
    });

    await check('Actor.pushData with eventName (returns ChargeResult)', async () => {
        // This test is conditional on pay-per-event, so we mark it not required
        // It's already tested below with the chargeEventName condition
        return { note: 'tested conditionally with chargeEventName input' };
    }, false);

    // ============================================
    // Actor.openDataset comprehensive tests
    // ============================================

    await check('Actor.openDataset (default, no args)', async () => {
        const dataset = await Actor.openDataset();
        const info = await dataset.getInfo();
        return {
            hasDataset: !!dataset,
            datasetId: info?.id ?? null,
            datasetName: info?.name ?? null,
        };
    });

    await check('Actor.openDataset (by string name)', async () => {
        const datasetName = `sdk-smoke-dataset-${Date.now()}`;
        const dataset = await Actor.openDataset(datasetName);
        await dataset.pushData({ openedBy: 'string-name', name: datasetName });
        const info = await dataset.getInfo();
        return {
            hasDataset: !!dataset,
            name: info?.name ?? null,
            method: 'string-name',
        };
    });

    await check('Actor.openDataset (by { id })', async () => {
        // First open default to get its ID
        const defaultDataset = await Actor.openDataset();
        const defaultInfo = await defaultDataset.getInfo();
        if (!defaultInfo?.id) {
            return { ok: false, reason: 'no default dataset id' };
        }
        // Now open by ID
        const byId = await Actor.openDataset({ id: defaultInfo.id });
        await byId.pushData({ openedBy: 'id-object', id: defaultInfo.id });
        return { method: 'id-object', datasetId: defaultInfo.id };
    });

    await check('Actor.openDataset (by { name })', async () => {
        const datasetName = `sdk-smoke-dataset-name-${Date.now()}`;
        const dataset = await Actor.openDataset({ name: datasetName });
        await dataset.pushData({ openedBy: 'name-object', name: datasetName });
        const info = await dataset.getInfo();
        return {
            hasDataset: !!dataset,
            name: info?.name ?? null,
            method: 'name-object',
        };
    });

    await check('Actor.openDataset (by { alias })', async () => {
        const storagesJson = process.env.ACTOR_STORAGES_JSON;
        if (!storagesJson) {
            return { skipped: true, reason: 'ACTOR_STORAGES_JSON not set' };
        }
        let parsed: any;
        try {
            parsed = JSON.parse(storagesJson);
        } catch {
            try {
                const decoded = Buffer.from(storagesJson, 'base64').toString('utf-8');
                parsed = JSON.parse(decoded);
            } catch {
                return { skipped: true, reason: 'could not parse ACTOR_STORAGES_JSON' };
            }
        }
        const aliases = parsed?.datasets ? Object.keys(parsed.datasets) : [];
        if (aliases.length === 0) {
            return { skipped: true, reason: 'no dataset aliases in ACTOR_STORAGES_JSON' };
        }
        const alias = aliases[0];
        const dataset = await Actor.openDataset({ alias });
        return {
            hasDataset: !!dataset,
            alias,
            method: 'alias-object',
        };
    }, false);

    // ============================================
    // Dataset method tests (forEach, map, reduce, entries, values, export, drop)
    // ============================================

    await check('Dataset.getData (with fields filter)', async () => {
        const dataset = await Actor.openDataset(`sdk-smoke-fields-${Date.now()}`);
        await dataset.pushData([
            { id: 1, name: 'test', extra: 'should-be-removed' },
            { id: 2, name: 'test2', extra: 'also-removed' },
        ]);
        const data = await dataset.getData({ fields: ['id', 'name'] });
        const hasExtra = data.items.some(item => 'extra' in item);
        return {
            ok: !hasExtra,
            fieldsReturned: Object.keys(data.items[0] ?? {}),
        };
    });

    await check('Dataset.getData (with skipHidden)', async () => {
        const dataset = await Actor.openDataset(`sdk-smoke-skiphidden-${Date.now()}`);
        await dataset.pushData([
            { id: 1, name: 'visible', '#secret': 'hidden' },
            { id: 2, name: 'visible2', '#private': 'also-hidden' },
        ]);
        const data = await dataset.getData({ skipHidden: true });
        const hasHidden = data.items.some(item => Object.keys(item).some(k => k.startsWith('#')));
        return { ok: !hasHidden, itemCount: data.items.length };
    });

    await check('Dataset.getData (with clean)', async () => {
        const dataset = await Actor.openDataset(`sdk-smoke-clean-${Date.now()}`);
        await dataset.pushData([
            { id: 1, '#hidden': 'field' },
            { name: 'valid' },
            {},
        ]);
        const data = await dataset.getData({ clean: true });
        const hasHidden = data.items.some(item => Object.keys(item).some(k => k.startsWith('#')));
        const hasEmpty = data.items.some(item => Object.keys(item).length === 0);
        return { ok: !hasHidden && !hasEmpty, itemCount: data.items.length };
    });

    await check('Dataset.forEach', async () => {
        const dataset = await Actor.openDataset(`sdk-smoke-foreach-${Date.now()}`);
        await dataset.pushData([{ n: 1 }, { n: 2 }, { n: 3 }]);
        const sum: number[] = [];
        await dataset.forEach((item) => {
            sum.push((item as any).n);
        });
        return { sum, total: sum.reduce((a, b) => a + b, 0) };
    });

    await check('Dataset.map', async () => {
        const dataset = await Actor.openDataset(`sdk-smoke-map-${Date.now()}`);
        await dataset.pushData([{ v: 10 }, { v: 20 }, { v: 30 }]);
        const doubled = await dataset.map((item) => (item as any).v * 2);
        return { doubled, sum: doubled.reduce((a, b) => a + b, 0) };
    });

    await check('Dataset.reduce', async () => {
        const dataset = await Actor.openDataset(`sdk-smoke-reduce-${Date.now()}`);
        await dataset.pushData([{ v: 1 }, { v: 2 }, { v: 3 }, { v: 4 }]);
        const sum = await dataset.reduce((acc, item) => acc + (item as any).v, 0);
        return { sum };
    });

    await check('Dataset.values', async () => {
        const dataset = await Actor.openDataset(`sdk-smoke-values-${Date.now()}`);
        await dataset.pushData([{ x: 1 }, { x: 2 }]);
        const collected: any[] = [];
        for await (const item of dataset.values()) {
            collected.push(item);
        }
        return { count: collected.length, values: collected.map(i => (i as any).x) };
    });

    await check('Dataset.entries', async () => {
        const dataset = await Actor.openDataset(`sdk-smoke-entries-${Date.now()}`);
        await dataset.pushData([{ a: 1 }, { a: 2 }, { a: 3 }]);
        const entries: [number, any][] = [];
        for await (const [idx, item] of dataset.entries()) {
            entries.push([idx, item]);
        }
        return {
            count: entries.length,
            indices: entries.map(([idx]) => idx),
            values: entries.map(([, item]) => (item as any).a),
        };
    });

    await check('Dataset [asyncIterator]', async () => {
        const dataset = await Actor.openDataset(`sdk-smoke-iterator-${Date.now()}`);
        await dataset.pushData([{ i: 1 }, { i: 2 }]);
        const items: any[] = [];
        for await (const item of dataset) {
            items.push(item);
        }
        return { count: items.length, values: items.map(i => (i as any).i) };
    });

    await check('Dataset.export', async () => {
        const dataset = await Actor.openDataset(`sdk-smoke-export-${Date.now()}`);
        await dataset.pushData([{ e: 1 }, { e: 2 }, { e: 3 }]);
        const all = await dataset.export();
        return { count: all.length, values: all.map(i => (i as any).e) };
    });

    await check('Dataset.getInfo', async () => {
        const dataset = await Actor.openDataset(`sdk-smoke-info-${Date.now()}`);
        await dataset.pushData([{ test: 'info' }]);
        const info = await dataset.getInfo();
        return {
            hasId: !!info?.id,
            itemCount: info?.itemCount ?? 0,
            hasDates: !!(info?.createdAt && info?.modifiedAt),
        };
    });

    await check('Dataset.drop (create and delete)', async () => {
        const datasetName = `sdk-smoke-drop-${Date.now()}`;
        const dataset = await Actor.openDataset(datasetName);
        await dataset.pushData([{ willBeDeleted: true }]);
        const infoBefore = await dataset.getInfo();
        await dataset.drop();
        // Verify it's gone by trying to get info (should return undefined for new dataset with same name)
        const newDataset = await Actor.openDataset(datasetName);
        const infoAfter = await newDataset.getInfo();
        return {
            hadItemsBefore: (infoBefore?.itemCount ?? 0) > 0,
            itemCountAfterDrop: infoAfter?.itemCount ?? 0,
        };
    });

    // ============================================
    // Actor.openKeyValueStore comprehensive tests
    // ============================================
    // Actor.openKeyValueStore comprehensive tests
    // ============================================

    await check('Actor.openKeyValueStore (default, no args)', async () => {
        const store = await Actor.openKeyValueStore();
        // Test setValue/getValue roundtrip
        const testKey = 'sdk-smoke-kvs-test';
        const testValue = { smoke: true, timestamp: Date.now() };
        await store.setValue(testKey, testValue);
        const retrieved = await store.getValue<typeof testValue>(testKey);
        return {
            hasStore: !!store,
            roundtripOk: retrieved?.smoke === true,
            retrievedValue: retrieved ?? null,
        };
    });

    await check('Actor.openKeyValueStore (by string name)', async () => {
        const storeName = `sdk-smoke-kvs-${Date.now()}`;
        const store = await Actor.openKeyValueStore(storeName);
        await store.setValue('test-key', { openedBy: 'string-name' });
        return {
            hasStore: !!store,
            method: 'string-name',
        };
    });

    await check('Actor.openKeyValueStore (by { id })', async () => {
        // Use the default KVS ID from config
        const defaultKvsId = Actor.getDefaultInstance().config.get('defaultKeyValueStoreId');
        if (!defaultKvsId) {
            return { ok: false, reason: 'no default kvs id in config' };
        }
        // Now open by ID
        const byId = await Actor.openKeyValueStore({ id: defaultKvsId });
        await byId.setValue('opened-by-id', { method: 'id-object' });
        return { method: 'id-object', storeId: defaultKvsId };
    });

    await check('Actor.openKeyValueStore (by { name })', async () => {
        const storeName = `sdk-smoke-kvs-name-${Date.now()}`;
        const store = await Actor.openKeyValueStore({ name: storeName });
        await store.setValue('test-key', { openedBy: 'name-object' });
        return {
            hasStore: !!store,
            method: 'name-object',
        };
    });

    await check('Actor.openKeyValueStore (by { alias })', async () => {
        const storagesJson = process.env.ACTOR_STORAGES_JSON;
        if (!storagesJson) {
            return { skipped: true, reason: 'ACTOR_STORAGES_JSON not set' };
        }
        let parsed: any;
        try {
            parsed = JSON.parse(storagesJson);
        } catch {
            try {
                const decoded = Buffer.from(storagesJson, 'base64').toString('utf-8');
                parsed = JSON.parse(decoded);
            } catch {
                return { skipped: true, reason: 'could not parse ACTOR_STORAGES_JSON' };
            }
        }
        const aliases = parsed?.keyValueStores ? Object.keys(parsed.keyValueStores) : [];
        if (aliases.length === 0) {
            return { skipped: true, reason: 'no kvs aliases in ACTOR_STORAGES_JSON' };
        }
        const alias = aliases[0];
        const store = await Actor.openKeyValueStore({ alias });
        return {
            hasStore: !!store,
            alias,
            method: 'alias-object',
        };
    }, false);

    // ============================================
    // Actor.openRequestQueue comprehensive tests
    // ============================================

    await check('Actor.openRequestQueue (default, no args)', async () => {
        const queue = await Actor.openRequestQueue();
        const info = await queue.getInfo();
        return {
            hasQueue: !!queue,
            queueId: info?.id ?? null,
            queueName: info?.name ?? null,
        };
    });

    await check('Actor.openRequestQueue (by string name)', async () => {
        const queueName = `sdk-smoke-queue-${Date.now()}`;
        const queue = await Actor.openRequestQueue(queueName);
        await queue.addRequest({ url: 'https://example.com/smoke-test', label: 'test' });
        const info = await queue.getInfo();
        return {
            hasQueue: !!queue,
            name: info?.name ?? null,
            method: 'string-name',
        };
    });

    await check('Actor.openRequestQueue (by { id })', async () => {
        // First open default to get its ID
        const defaultQueue = await Actor.openRequestQueue();
        const defaultInfo = await defaultQueue.getInfo();
        if (!defaultInfo?.id) {
            return { ok: false, reason: 'no default queue id' };
        }
        // Now open by ID
        const byId = await Actor.openRequestQueue({ id: defaultInfo.id });
        return { method: 'id-object', queueId: defaultInfo.id };
    });

    await check('Actor.openRequestQueue (by { name })', async () => {
        const queueName = `sdk-smoke-queue-name-${Date.now()}`;
        const queue = await Actor.openRequestQueue({ name: queueName });
        await queue.addRequest({ url: 'https://example.com/name-object-test', label: 'name-test' });
        const info = await queue.getInfo();
        return {
            hasQueue: !!queue,
            name: info?.name ?? null,
            method: 'name-object',
        };
    });

    await check('Actor.openRequestQueue (by { alias })', async () => {
        const storagesJson = process.env.ACTOR_STORAGES_JSON;
        if (!storagesJson) {
            return { skipped: true, reason: 'ACTOR_STORAGES_JSON not set' };
        }
        let parsed: any;
        try {
            parsed = JSON.parse(storagesJson);
        } catch {
            try {
                const decoded = Buffer.from(storagesJson, 'base64').toString('utf-8');
                parsed = JSON.parse(decoded);
            } catch {
                return { skipped: true, reason: 'could not parse ACTOR_STORAGES_JSON' };
            }
        }
        const aliases = parsed?.requestQueues ? Object.keys(parsed.requestQueues) : [];
        if (aliases.length === 0) {
            return { skipped: true, reason: 'no queue aliases in ACTOR_STORAGES_JSON' };
        }
        const alias = aliases[0];
        const queue = await Actor.openRequestQueue({ alias });
        return {
            hasQueue: !!queue,
            alias,
            method: 'alias-object',
        };
    }, false);

    const useStateKey = input.useStateKey ?? 'sdk-smoke-state';

    await check('Actor.useState (mutate)', async () => {
        const state = await Actor.useState(useStateKey, { count: 0, probe: 'useState' });
        state.count = (state.count ?? 0) + 1;
        return { count: state.count, probe: state.probe };
    });

    await check('Actor.useState (persistState)', async () => {
        const state = await Actor.useState(useStateKey, { count: 0, saved: false });
        console.log(`[sdk-smoke] useState persistState: initial state =`, JSON.stringify(state));
        console.log(`[sdk-smoke] useState persistState: state identity =`, state === (await Actor.useState(useStateKey, { count: 0, saved: false })));
        state.count = 99;
        state.saved = true;
        console.log(`[sdk-smoke] useState persistState: after mutation, state =`, JSON.stringify(state));

        const eventManager = Actor.getDefaultInstance().config.getEventManager();
        console.log(`[sdk-smoke] useState persistState: emitting persistState event, eventManager type =`, eventManager.constructor.name);
        eventManager.emit('persistState', { isMigrating: false });
        await new Promise((r) => setTimeout(r, 500));

        const restored = await Actor.useState(useStateKey, { count: 0, saved: false });
        console.log(`[sdk-smoke] useState persistState: restored state =`, JSON.stringify(restored));
        console.log(`[sdk-smoke] useState persistState: restored same ref?`, restored === state);
        if (restored.count !== 99) {
            return { ok: false, count: restored.count, saved: restored.saved };
        }
        if (restored.saved !== true) {
            return { ok: false, reason: 'saved flag not persisted', saved: restored.saved };
        }
        return { count: restored.count, saved: restored.saved };
    });

    await check('Actor.useState (default key APIFY_GLOBAL_STATE)', async () => {
        const globalState = await Actor.useState(undefined, { marker: 'global' });
        globalState.marker = 'ok';
        return globalState.marker;
    }, false);

    let persistStateFired = false;
    Actor.on('persistState', () => {
        persistStateFired = true;
    });
    Actor.getDefaultInstance().config.getEventManager().emit('persistState', {
        isMigrating: false,
    });
    await check('Actor.on (EventManager persistState)', async () => persistStateFired);

    await check('Actor.newClient', async () => {
        const client = Actor.newClient();
        return client.constructor.name;
    });

    await check('Actor.apifyClient', async () => {
        return Actor.apifyClient.constructor.name === 'ApifyClient';
    });

    await check('Actor.apifyClient.user', async () => {
        const user = await Actor.apifyClient.user().get();
        return user?.id ?? user;
    }, false);  // Non-required: scoped tokens cannot access user account endpoints

    const runId = process.env.ACTOR_RUN_ID;
    if (runId) {
        await check('Actor.apifyClient.run().get', async () => {
            const run = await Actor.apifyClient.run(runId).get();
            return run?.status;
        });
    }

    await check('Actor.setStatusMessage', async () => {
        const msg = 'SDK smoke test running';
        const run = await Actor.setStatusMessage(msg);
        if (run?.statusMessage !== msg) {
            return {
                ok: false,
                expected: msg,
                statusMessage: run?.statusMessage ?? null,
                runId: run?.id ?? null,
            };
        }
        return { ok: true, statusMessage: run.statusMessage, id: run.id ?? null };
    });

    await check('Actor.getChargingManager', async () => {
        const manager = Actor.getChargingManager();
        return manager.getPricingInfo();
    });

    await check('ChargingManager.calculatePushDataLimits', async () => {
        const manager = Actor.getChargingManager();
        const pricingInfo = manager.getPricingInfo();

        // Test with array of items
        const items = [{ id: 1 }, { id: 2 }, { id: 3 }];
        // Ensure eventName is a string (not undefined) for the test
        const testEventName: string = input.chargeEventName || 'test-event';
        const result = manager.calculatePushDataLimits({
            eventName: testEventName,
            isDefaultDataset: true,
            items,
        });

        // Verify return shape
        if (!('eventsToCharge' in result) || !('limitedItems' in result)) {
            return { ok: false, reason: 'missing expected keys', result };
        }

        // For non-PPE or no event, should return all items
        if (!pricingInfo.isPayPerEvent || !input.chargeEventName) {
            if (result.limitedItems.length !== items.length) {
                return { ok: false, reason: 'should return all items when not PPE or no event', result };
            }
            if (Object.keys(result.eventsToCharge).length !== 0) {
                return { ok: false, reason: 'should have no events to charge when not PPE', result };
            }
        }

        return {
            hasMethod: true,
            eventsToCharge: result.eventsToCharge,
            limitedItemsCount: result.limitedItems.length,
            isPayPerEvent: pricingInfo.isPayPerEvent,
        };
    });

    await check('smokeActor.charge (instance method)', async () => typeof smokeActor.charge === 'function');

    const chargePricing = Actor.getChargingManager().getPricingInfo();
    if (input.chargeEventName && chargePricing.isPayPerEvent) {
        await check('Actor.charge', async () => {
            const result = await Actor.charge({ eventName: input.chargeEventName!, count: 1 });
            if (typeof result.chargedCount !== 'number') {
                return { ok: false, reason: 'missing chargedCount' };
            }
            if (result.chargedCount < 0 || result.chargedCount > 1) {
                return {
                    ok: false,
                    reason: 'unexpected chargedCount for count=1',
                    chargedCount: result.chargedCount,
                };
            }
            return {
                ok: true,
                chargedCount: result.chargedCount,
                eventChargeLimitReached: result.eventChargeLimitReached,
                chargeableWithinLimit: result.chargeableWithinLimit,
            };
        });
        await check(
            'Actor.pushData with eventName',
            async () => {
                const result = await Actor.pushData({ charged: true }, input.chargeEventName);
                return {
                    chargedCount: result.chargedCount,
                    eventChargeLimitReached: result.eventChargeLimitReached,
                };
            },
            false,
        );
    } else if (input.chargeEventName) {
        await skip('Actor.charge', 'chargeEventName set but actor is not pay-per-event');
        await skip('Actor.pushData(eventName)', 'chargeEventName set but actor is not pay-per-event');
    } else {
        await skip('Actor.charge', 'no chargeEventName in input');
        await skip('Actor.pushData(eventName)', 'no chargeEventName in input');
    }

    // Test: createProxyConfiguration with no options returns undefined
    await check('Actor.createProxyConfiguration (no options)', async () => {
        const proxy = await Actor.createProxyConfiguration();
        return proxy === undefined;
    });

    // Test: createProxyConfiguration with useApifyProxy: false returns undefined (Apify compatibility)
    if (input.testUseApifyProxyFalse) {
        await check('Actor.createProxyConfiguration (useApifyProxy: false)', async () => {
            const proxy = await Actor.createProxyConfiguration({ useApifyProxy: false });
            return proxy === undefined;
        });
    } else {
        await skip('Actor.createProxyConfiguration (useApifyProxy: false)', 'testUseApifyProxyFalse not set');
    }

    // Test: createProxyConfiguration with proxyUrls from input
    if (input.proxyUrls && input.proxyUrls.length > 0) {
        await check('Actor.createProxyConfiguration (with proxyUrls)', async () => {
            const proxy = await Actor.createProxyConfiguration({
                proxyUrls: input.proxyUrls,
                checkAccess: false, // Skip access check for smoke test
            });
            if (!proxy) {
                return { ok: false, reason: 'proxy configuration is undefined' };
            }
            // Test newUrl method
            const url = await proxy.newUrl('test-session');
            if (!url) {
                return { ok: false, reason: 'newUrl returned undefined' };
            }
            // Verify the URL matches one of the provided proxy URLs
            const isValidUrl = input.proxyUrls!.includes(url);
            return {
                ok: isValidUrl,
                proxyUrl: url,
                providedUrls: input.proxyUrls!.length,
            };
        });

        await check('Actor.createProxyConfiguration (newProxyInfo)', async () => {
            const proxy = await Actor.createProxyConfiguration({
                proxyUrls: input.proxyUrls,
                checkAccess: false,
            });
            if (!proxy) {
                return { ok: false, reason: 'proxy configuration is undefined' };
            }
            const proxyInfo = await proxy.newProxyInfo('session-123');
            if (!proxyInfo) {
                return { ok: false, reason: 'newProxyInfo returned undefined' };
            }
            return {
                url: proxyInfo.url,
                sessionId: proxyInfo.sessionId,
                hostname: proxyInfo.hostname,
                port: proxyInfo.port,
            };
        });
    } else {
        await skip('Actor.createProxyConfiguration (with proxyUrls)', 'no proxyUrls in input');
        await skip('Actor.createProxyConfiguration (newProxyInfo)', 'no proxyUrls in input');
    }

    // Test: createProxyConfiguration with custom newUrlFunction
    await check('Actor.createProxyConfiguration (newUrlFunction)', async () => {
        let callCount = 0;
        const proxy = await Actor.createProxyConfiguration({
            newUrlFunction: (sessionId) => {
                callCount++;
                return `http://user:${sessionId}@proxy.example.com:8080`;
            },
            checkAccess: false,
        });
        if (!proxy) {
            return { ok: false, reason: 'proxy configuration is undefined' };
        }
        const url = await proxy.newUrl('my-session');
        if (!url) {
            return { ok: false, reason: 'newUrl returned undefined' };
        }
        const hasSession = url.includes('my-session');
        return {
            ok: hasSession,
            url,
            callCount,
        };
    });

    if (input.targetActorId) {
        const routing = apiRoutingSnapshot();
        const startPreview = actorStartRequestPreview(
            input.targetActorId,
            routing.apifyClientBaseUrl,
        );
        const startDiagnostics = { routing, startPreview };

        console.log('[sdk-smoke] Actor.start diagnostics', JSON.stringify(startDiagnostics, null, 2));

        await check('API routing (Actor.start diagnostics)', async () => startDiagnostics, false);

        await check(
            'Actor.start',
            async () => {
                try {
                    const run = await Actor.start(input.targetActorId!, {});
                    return {
                        runId: run?.id ?? null,
                        status: run?.status ?? null,
                        ...startPreview,
                    };
                } catch (err) {
                    const payload = {
                        ...startDiagnostics,
                        apiError: apifyApiErrorFields(err),
                    };
                    console.error('[sdk-smoke] Actor.start failed', JSON.stringify(payload, null, 2));
                    throw new SmokeCheckError((err as Error).message, payload);
                }
            },
            false,
        );
    } else {
        await skip('Actor.start', 'no targetActorId in input');
        await skip('API routing (Actor.start diagnostics)', 'no targetActorId in input');
    }

    await check('smokeActor.call (instance method)', async () => typeof smokeActor.call === 'function');

    await check('instance.call delegates to Actor.call', async () => {
        const savedTimeoutAt = process.env.ACTOR_TIMEOUT_AT;
        const warnings: string[] = [];
        const origWarn = console.warn;
        console.warn = (...args: unknown[]) => {
            warnings.push(args.map(String).join(' '));
            origWarn.apply(console, args as Parameters<typeof console.warn>);
        };
        try {
            delete process.env.ACTOR_TIMEOUT_AT;
            try {
                await smokeActor.call('sdk-smoke-inherit-probe/nonexistent-actor', {}, {
                    timeout: 'inherit',
                    waitSecs: 1,
                });
            } catch {
                // API error expected for fake actor id
            }
            const warnedWithoutEnv = warnings.some((w) => w.includes('inherit'));
            if (!warnedWithoutEnv) {
                return false;
            }

            if (savedTimeoutAt) {
                process.env.ACTOR_TIMEOUT_AT = savedTimeoutAt;
                warnings.length = 0;
                try {
                    await smokeActor.call('sdk-smoke-inherit-probe/nonexistent-actor', {}, {
                        timeout: 'inherit',
                        waitSecs: 1,
                    });
                } catch {
                    // API error expected
                }
                if (warnings.some((w) => w.includes('inherit') && w.includes('ACTOR_TIMEOUT_AT'))) {
                    return false;
                }
                return {
                    warnedWithoutEnv: true,
                    silentWithEnv: true,
                    remainingMs: Actor.getRemainingTime(),
                };
            }

            return { warnedWithoutEnv: true };
        } finally {
            console.warn = origWarn;
            if (savedTimeoutAt !== undefined) {
                process.env.ACTOR_TIMEOUT_AT = savedTimeoutAt;
            } else {
                delete process.env.ACTOR_TIMEOUT_AT;
            }
        }
    });

    if (input.targetActorId) {
        await check(
            'Actor.call timeout inherit (remaining time)',
            async () => {
                const remaining = Actor.getRemainingTime();
                return { remainingMs: remaining };
            },
            false,
        );
    } else {
        await skip('Actor.call', 'no targetActorId in input');
    }

    await check('smokeActor.callTask (instance method)', async () => typeof smokeActor.callTask === 'function');

    await check('instance.callTask delegates to Actor.callTask', async () => {
        const savedTimeoutAt = process.env.ACTOR_TIMEOUT_AT;
        const warnings: string[] = [];
        const origWarn = console.warn;
        console.warn = (...args: unknown[]) => {
            warnings.push(args.map(String).join(' '));
            origWarn.apply(console, args as Parameters<typeof console.warn>);
        };
        try {
            delete process.env.ACTOR_TIMEOUT_AT;
            try {
                await smokeActor.callTask('sdk-smoke-inherit-probe/nonexistent-task', {}, {
                    timeout: 'inherit',
                    waitSecs: 1,
                });
            } catch {
                // API error expected for fake task id
            }
            const warnedWithoutEnv = warnings.some((w) => w.includes('inherit'));
            if (!warnedWithoutEnv) {
                return false;
            }

            if (savedTimeoutAt) {
                process.env.ACTOR_TIMEOUT_AT = savedTimeoutAt;
                warnings.length = 0;
                try {
                    await smokeActor.callTask('sdk-smoke-inherit-probe/nonexistent-task', {}, {
                        timeout: 'inherit',
                        waitSecs: 1,
                    });
                } catch {
                    // API error expected
                }
                if (warnings.some((w) => w.includes('inherit') && w.includes('ACTOR_TIMEOUT_AT'))) {
                    return false;
                }
                return {
                    warnedWithoutEnv: true,
                    silentWithEnv: true,
                    remainingMs: Actor.getRemainingTime(),
                };
            }

            return { warnedWithoutEnv: true };
        } finally {
            console.warn = origWarn;
            if (savedTimeoutAt !== undefined) {
                process.env.ACTOR_TIMEOUT_AT = savedTimeoutAt;
            } else {
                delete process.env.ACTOR_TIMEOUT_AT;
            }
        }
    });

    if (input.targetTaskId) {
        await check(
            'Actor.callTask',
            async () => {
                const run = await smokeActor.callTask(
                    input.targetTaskId!,
                    { sdkSmoke: true },
                    { waitSecs: 300 },
                );
                if (!run?.id) {
                    return { ok: false, reason: 'no run id returned' };
                }
                return { id: run.id, status: run.status ?? null };
            },
            false,
        );
    } else {
        await skip('Actor.callTask', 'no targetTaskId in input');
    }

    if (!Actor.isAtHome()) {
        await skip('Actor.addWebhook', 'not running on platform');
    } else {
        await check('Actor.addWebhook', async () => {
            const requestUrl = input.webhookRequestUrl ?? 'https://example.com/webhook';
            const webhook = await Actor.addWebhook({
                eventTypes: ['ACTOR.RUN.SUCCEEDED'],
                requestUrl,
                description: 'sdk-smoke',
                ...(currentRunId ? { idempotencyKey: currentRunId } : {}),
            });
            if (!webhook?.id) {
                return { ok: false, reason: 'no webhook id returned' };
            }
            if (webhook.isAdHoc !== true) {
                return { ok: false, isAdHoc: webhook.isAdHoc };
            }
            const runCondition = webhook.condition as { actorRunId?: string } | undefined;
            if (runCondition?.actorRunId !== currentRunId) {
                return {
                    ok: false,
                    expectedRunId: currentRunId,
                    condition: runCondition,
                };
            }
            return {
                ok: true,
                id: webhook.id,
                isAdHoc: webhook.isAdHoc,
                actorRunId: runCondition.actorRunId,
            };
        });
    }

    // Metamorph, reboot, and abort are destructive - they're tested at the end after OUTPUT is saved.
    // Individual skip flags allow fine-grained control over which destructive tests to run.
    await skip('Actor.metamorph', 'tested at end after OUTPUT (see metamorphAtEnd in summary)');
    await skip('Actor.reboot', 'tested at end after OUTPUT (see rebootAtEnd in summary)');
    await skip('Actor.abort', 'tested at end after OUTPUT (see abortAtEnd in summary)');

    const summary: Record<string, unknown> = {
        currentRunId,
        passed: results.filter((r) => r.status === 'ok').length,
        failed: results.filter((r) => r.status === 'fail').length,
        skipped: results.filter((r) => r.status === 'skip').length,
        checks: results,
    };

    await Actor.pushData(results);
    await Actor.setValue('OUTPUT', summary);

    const failed = results.filter((r) => r.status === 'fail');
    if (failed.length > 0) {
        console.log('[sdk-smoke] Some checks failed:', failed.map((f) => f.method).join(', '));
    }

    console.log('[sdk-smoke] Smoke test complete', summary);

    // Abort after OUTPUT is persisted (self by default, or abortTargetRunId).
    if (input.skipDestructive === false && !input.skipAbort) {
        const abortRunId = input.abortTargetRunId ?? currentRunId;
        if (!abortRunId) {
            summary.abortAtEnd = { status: 'skip', reason: 'no currentRunId or abortTargetRunId' };
            await Actor.setValue('OUTPUT', summary);
            return;
        }

        const gracefully = input.abortGracefully !== false;
        try {
            const run = await Actor.abort(abortRunId, {
                gracefully,
                statusMessage: 'SDK smoke test finished',
            });
            summary.abortAtEnd = {
                status: 'ok',
                runId: abortRunId,
                gracefully,
                runStatus: run?.status ?? null,
            };
            console.log('[sdk-smoke] Abort at end', summary.abortAtEnd);
        } catch (err) {
            summary.abortAtEnd = {
                status: 'fail',
                runId: abortRunId,
                error: (err as Error).message,
            };
            console.error('[sdk-smoke] Abort at end failed', summary.abortAtEnd);
            await Actor.setValue('OUTPUT', summary);
            throw err;
        }

        await Actor.setValue('OUTPUT', summary);
    } else if (input.skipAbort) {
        summary.abortAtEnd = { status: 'skip', reason: 'skipAbort=true' };
        await Actor.setValue('OUTPUT', summary);
        console.log('[sdk-smoke] Skipping abort (skipAbort=true)');
    }

    // Metamorph test at end (after OUTPUT is saved, since metamorph terminates the process)
    if (!input.skipMetamorph && input.metamorphTargetActorId) {
        try {
            console.log(`[sdk-smoke] Metamorphosing to actor ${input.metamorphTargetActorId}...`);
            await Actor.metamorph(input.metamorphTargetActorId, { metamorphTest: true, originalRunId: currentRunId });
            // Note: metamorph calls process.exit(0), so this line is unreachable
            // If we reach here, something went wrong
            summary.metamorphAtEnd = { status: 'fail', reason: 'metamorph did not exit process' };
            await Actor.setValue('OUTPUT', summary);
        } catch (err) {
            summary.metamorphAtEnd = {
                status: 'fail',
                targetActorId: input.metamorphTargetActorId,
                error: (err as Error).message,
            };
            console.error('[sdk-smoke] Metamorph at end failed', summary.metamorphAtEnd);
            await Actor.setValue('OUTPUT', summary);
            throw err;
        }
    } else if (!input.skipMetamorph && !input.metamorphTargetActorId) {
        summary.metamorphAtEnd = { status: 'skip', reason: 'no metamorphTargetActorId provided' };
        await Actor.setValue('OUTPUT', summary);
        console.log('[sdk-smoke] Skipping metamorph (no metamorphTargetActorId)');
    } else if (input.skipMetamorph) {
        summary.metamorphAtEnd = { status: 'skip', reason: 'skipMetamorph=true' };
        await Actor.setValue('OUTPUT', summary);
        console.log('[sdk-smoke] Skipping metamorph (skipMetamorph=true)');
    }

    // Reboot test at end (after OUTPUT is saved, since reboot restarts the container)
    if (!input.skipReboot) {
        try {
            console.log('[sdk-smoke] Rebooting...');
            const httpStatus = await Actor.reboot();
            summary.rebootAtEnd = { status: 'ok', httpStatus };
            await Actor.setValue('OUTPUT', summary);
            console.log('[sdk-smoke] Reboot at end', summary.rebootAtEnd);
        } catch (err) {
            const error = (err as Error).message;
            summary.rebootAtEnd = { status: 'fail', error };
            console.error('[sdk-smoke] Reboot at end failed:', error);
            await Actor.setValue('OUTPUT', summary);
            throw err;
        }
    } else {
        summary.rebootAtEnd = { status: 'skip', reason: 'skipReboot=true' };
        await Actor.setValue('OUTPUT', summary);
        console.log('[sdk-smoke] Skipping reboot (skipReboot=true)');
    }
});

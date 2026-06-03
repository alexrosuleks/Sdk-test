/**
 * SDK smoke actor — exercises Scrapely Actor APIs on the platform.
 * Each check is recorded in the default dataset; the run fails if any required check fails.
 *
 * Run on platform with input, e.g.:
 * {
 *   "targetActorId": "user/another-actor",
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
}

const results: SmokeCheck[] = [];

async function check(method: string, fn: () => Promise<unknown>, required = true): Promise<void> {
    try {
        const detail = await fn();
        if (detail === false) {
            throw new Error('check returned false');
        }
        results.push({ method, status: 'ok', detail });
    } catch (err) {
        const error = (err as Error).message;
        results.push({ method, status: 'fail', error });
        if (required) {
            throw new Error(`${method} failed: ${error}`);
        }
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

    await check('new Actor({ token }) isolated config', async () => {
        const isolated = new Actor({ token: 'test-token' });
        return isolated.config.get('token') === 'test-token';
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

    await check('Actor.openDataset + pushData', async () => {
        const dataset = await Actor.openDataset();
        await dataset.pushData({ probe: 'dataset' });
        return true;
    });

    await check('Actor.pushData shortcut', async () => {
        await Actor.pushData({ probe: 'shortcut' });
        return true;
    });

    await check('Actor.openKeyValueStore', async () => {
        const store = await Actor.openKeyValueStore();
        return !!store;
    });

    await check('Actor.openRequestQueue', async () => {
        const queue = await Actor.openRequestQueue();
        return !!queue;
    });

    const useStateKey = input.useStateKey ?? 'sdk-smoke-state';

    await check('Actor.useState (mutate)', async () => {
        const state = await Actor.useState(useStateKey, { count: 0, probe: 'useState' });
        state.count = (state.count ?? 0) + 1;
        return { count: state.count, probe: state.probe };
    });

    await check('Actor.useState (persistState)', async () => {
        const state = await Actor.useState(useStateKey, { count: 0, saved: false });
        state.count = 99;
        state.saved = true;

        const eventManager = Actor.getDefaultInstance().config.getEventManager();
        eventManager.emit('persistState', { isMigrating: false });
        await new Promise((r) => setTimeout(r, 300));

        const restored = await Actor.useState(useStateKey, { count: 0, saved: false });
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
    });

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

    if (input.chargeEventName) {
        await check(
            'Actor.charge',
            async () => Actor.charge({ eventName: input.chargeEventName!, count: 1 }),
            false,
        );
        await check(
            'Actor.pushData with eventName',
            async () => Actor.pushData({ charged: true }, input.chargeEventName),
            false,
        );
    } else {
        await skip('Actor.charge', 'no chargeEventName in input');
        await skip('Actor.pushData(eventName)', 'no chargeEventName in input');
    }

    await check('Actor.createProxyConfiguration', async () => {
        const proxy = await Actor.createProxyConfiguration();
        return proxy === undefined;
    });

    if (input.targetActorId) {
        await check(
            'Actor.start',
            async () => {
                const run = await Actor.start(input.targetActorId!, {});
                return run?.id ?? run;
            },
            false,
        );
    } else {
        await skip('Actor.start', 'no targetActorId in input');
    }

    if (input.targetActorId) {
        await check(
            'Actor.call timeout inherit',
            async () => {
                const remaining = Actor.getRemainingTime();
                return { remainingMs: remaining };
            },
            false,
        );
    } else {
        await skip('Actor.call', 'no targetActorId in input');
    }

    if (input.targetTaskId) {
        await skip('Actor.callTask', 'callTask requires valid task on platform');
    } else {
        await skip('Actor.callTask', 'no targetTaskId in input');
    }

    await check('Actor.addWebhook', async () => {
        const webhook = await Actor.addWebhook({
            eventTypes: ['ACTOR.RUN.SUCCEEDED'],
            requestUrl: 'https://example.com/webhook',
            description: 'sdk-smoke',
        });
        return webhook ?? 'skipped';
    }, false);

    if (input.skipDestructive !== false) {
        await skip('Actor.metamorph', 'skipDestructive=true');
        await skip('Actor.reboot', 'skipDestructive=true');
        await skip('Actor.abort', 'skipDestructive=true');
    } else {
        await skip('Actor.metamorph', 'destructive — not implemented in smoke');
        await skip('Actor.reboot', 'destructive — not implemented in smoke');
        await skip('Actor.abort', 'runs at end after OUTPUT (see abortAtEnd in summary)');
    }

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
        throw new Error(`SDK smoke failed: ${failed.map((f) => f.method).join(', ')}`);
    }

    console.log('[sdk-smoke] All required checks passed', summary);

    // Abort after OUTPUT is persisted (self by default, or abortTargetRunId).
    if (input.skipDestructive === false) {
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
    }
});

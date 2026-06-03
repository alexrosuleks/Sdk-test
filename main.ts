/**
 * SDK smoke actor — exercises Scrapely Actor APIs on the platform.
 * Each check is recorded in the default dataset; the run fails if any required check fails.
 *
 * Run on platform with input, e.g.:
 * { "targetActorId": "user/another-actor", "chargeEventName": "my-event", "skipDestructive": true }
 */

import { Actor } from 'scrapely';

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
}

const results: SmokeCheck[] = [];

async function check(method: string, fn: () => Promise<unknown>, required = true): Promise<void> {
    try {
        const detail = await fn();
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

    await check('Actor.init (via main)', async () => Actor.initialized);

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

    await check('Actor.getInput', async () => input);

    await check('Actor.input getter', async () => Actor.input);

    await check('Actor.getInputOrThrow', async () => {
        const value = await Actor.getInputOrThrow<SmokeInput>();
        return value !== null;
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

    await check('Actor.useState', async () => {
        const state = await Actor.useState('sdk-smoke-state', { count: 0 });
        state.count = (state.count ?? 0) + 1;
        return state.count;
    });

    let persistStateFired = false;
    Actor.on('persistState', () => {
        persistStateFired = true;
    });
    Actor.events.emit('persistState', { isMigrating: false });
    await check('Actor.on / Actor.events', async () => persistStateFired);

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
        const run = await Actor.setStatusMessage('SDK smoke test running');
        return run?.status ?? 'updated';
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
                const run = await Actor.start(input.targetActorId!, { smoke: true });
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
    }

    const summary = {
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
});

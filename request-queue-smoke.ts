/**
 * Isolated request-queue smoke suite (enabled via input.testRequestQueue).
 * Exercises the container API path: Actor.openRequestQueue → /v2/request-queues.
 */

import { Actor } from 'scrapely';

type RequestQueue = Awaited<ReturnType<typeof Actor.openRequestQueue>>;

const RQ_REBOOT_KVS_KEY = 'SDK_SMOKE_RQ_REBOOT';

export interface RequestQueueSmokeInput {
    testRequestQueue?: boolean;
    testRequestQueueReboot?: boolean;
    requestQueueSharedName?: string;
}

interface RebootCheckpoint {
    phase: 'awaiting_reboot';
    queueId: string;
    pendingRequestCount: number;
    totalRequestCount: number;
    handledRequestCount: number;
    uniqueKeys: string[];
}

export interface RequestQueueSmokeContext {
    currentRunId: string | null;
    results: Array<{ status: string }>;
    check: (method: string, fn: () => Promise<unknown>, required?: boolean) => Promise<void>;
    skip: (method: string, reason: string) => Promise<void>;
}

function runPrefix(currentRunId: string | null): string {
    return `rq-smoke-${currentRunId ?? Date.now()}`;
}

function urlFor(prefix: string, slug: string): string {
    return `https://${prefix}.example.test/${slug}`;
}

async function getQueueCounts(queue: RequestQueue) {
    const info = await queue.getInfo();
    return {
        totalRequestCount: info?.totalRequestCount ?? 0,
        pendingRequestCount: info?.pendingRequestCount ?? 0,
        handledRequestCount: info?.handledRequestCount ?? 0,
        queueId: info?.id ?? null,
    };
}

async function openVariants(ctx: RequestQueueSmokeContext): Promise<void> {
    const { check, skip } = ctx;

    await check('RQ.open.default', async () => {
        const queue = await Actor.openRequestQueue();
        const info = await queue.getInfo();
        return { hasQueue: !!queue, queueId: info?.id ?? null };
    });

    await check('RQ.open.byStringName', async () => {
        const queueName = `sdk-smoke-rq-name-${Date.now()}`;
        const queue = await Actor.openRequestQueue(queueName);
        await queue.addRequest({ url: urlFor('open-string', queueName), uniqueKey: queueName });
        const info = await queue.getInfo();
        return { hasQueue: !!queue, name: info?.name ?? null };
    });

    await check('RQ.open.byId', async () => {
        const defaultQueue = await Actor.openRequestQueue();
        const defaultInfo = await defaultQueue.getInfo();
        if (!defaultInfo?.id) return { ok: false, reason: 'no default queue id' };
        const byId = await Actor.openRequestQueue({ id: defaultInfo.id });
        const info = await byId.getInfo();
        return { queueId: defaultInfo.id, matches: info?.id === defaultInfo.id };
    });

    await check('RQ.open.byNameObject', async () => {
        const queueName = `sdk-smoke-rq-obj-${Date.now()}`;
        const queue = await Actor.openRequestQueue({ name: queueName });
        await queue.addRequest({ url: urlFor('open-obj', queueName), uniqueKey: queueName });
        const info = await queue.getInfo();
        return { hasQueue: !!queue, name: info?.name ?? null };
    });

    await check('RQ.open.byAlias', async () => {
        const storagesJson = process.env.ACTOR_STORAGES_JSON;
        if (!storagesJson) {
            return { skipped: true, reason: 'ACTOR_STORAGES_JSON not set' };
        }
        let parsed: { requestQueues?: Record<string, string> } | null = null;
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
        return { hasQueue: !!queue, alias };
    }, false);
}

async function defaultQueueTests(ctx: RequestQueueSmokeContext): Promise<void> {
    const { check, currentRunId } = ctx;
    const prefix = runPrefix(currentRunId);

    await check('RQ.default.addAndCounts', async () => {
        const queue = await Actor.openRequestQueue();
        const before = await getQueueCounts(queue);
        const keys = ['a', 'b', 'c'].map((s) => `${prefix}-add-${s}`);
        for (const key of keys) {
            await queue.addRequest({ url: urlFor(prefix, key), uniqueKey: key });
        }
        const after = await getQueueCounts(queue);
        return {
            added: keys.length,
            totalDelta: after.totalRequestCount - before.totalRequestCount,
            pendingDelta: after.pendingRequestCount - before.pendingRequestCount,
            ok: after.totalRequestCount - before.totalRequestCount >= keys.length
                && after.pendingRequestCount - before.pendingRequestCount >= keys.length,
        };
    });

    await check('RQ.default.dedup', async () => {
        const queue = await Actor.openRequestQueue();
        const dedupKey = `${prefix}-dedup`;
        const url = urlFor(prefix, 'dedup');
        await queue.addRequest({ url, uniqueKey: dedupKey });
        const mid = await getQueueCounts(queue);
        await queue.addRequest({ url, uniqueKey: dedupKey });
        const after = await getQueueCounts(queue);
        return {
            totalUnchanged: after.totalRequestCount === mid.totalRequestCount,
            pendingUnchanged: after.pendingRequestCount === mid.pendingRequestCount,
        };
    });

    await check('RQ.default.fetchAndHandle', async () => {
        const queue = await Actor.openRequestQueue();
        const handleKey = `${prefix}-handle`;
        await queue.addRequest({ url: urlFor(prefix, 'handle'), uniqueKey: handleKey });
        const before = await getQueueCounts(queue);

        let request = null;
        for (let i = 0; i < 50; i++) {
            const next = await queue.fetchNextRequest();
            if (!next) break;
            if (next.uniqueKey === handleKey) {
                request = next;
                break;
            }
            await queue.reclaimRequest(next);
        }
        if (!request) return { ok: false, reason: 'could not lock target request' };

        await queue.markRequestHandled(request);
        const after = await getQueueCounts(queue);
        return {
            fetchedUrl: request.url,
            handledIncreased: after.handledRequestCount >= before.handledRequestCount,
            pendingDecreased: after.pendingRequestCount <= before.pendingRequestCount,
        };
    });

    await check('RQ.default.reclaimForefront', async () => {
        const queue = await Actor.openRequestQueue();
        const keyA = `${prefix}-reclaim-a`;
        const keyB = `${prefix}-reclaim-b`;
        await queue.addRequest({ url: urlFor(prefix, 'reclaim-a'), uniqueKey: keyA });
        await queue.addRequest({ url: urlFor(prefix, 'reclaim-b'), uniqueKey: keyB });

        let first = null;
        for (let i = 0; i < 50; i++) {
            const next = await queue.fetchNextRequest();
            if (!next) break;
            if (next.uniqueKey === keyA) {
                first = next;
                break;
            }
            await queue.reclaimRequest(next);
        }
        if (!first) return { ok: false, reason: 'no request to reclaim' };

        await queue.reclaimRequest(first, { forefront: true });
        const again = await queue.fetchNextRequest();
        return {
            firstId: first.id,
            againId: again?.id ?? null,
            forefrontWorked: again?.id === first.id,
        };
    });
}

async function namedPersistenceTest(ctx: RequestQueueSmokeContext): Promise<void> {
    const { check, currentRunId } = ctx;
    const prefix = runPrefix(currentRunId);

    await check('RQ.named.persistence', async () => {
        const queueName = `sdk-smoke-rq-persist-${Date.now()}`;
        const uniqueKey = `${prefix}-named-persist`;
        const url = urlFor(prefix, 'named-persist');

        const q1 = await Actor.openRequestQueue(queueName);
        await q1.addRequest({ url, uniqueKey });

        const q2 = await Actor.openRequestQueue(queueName);
        const request = await q2.fetchNextRequest();
        return {
            queueName,
            fetched: !!request,
            urlMatch: request?.url === url,
            uniqueKeyMatch: request?.uniqueKey === uniqueKey,
        };
    });
}

async function sharedQueueTests(ctx: RequestQueueSmokeContext, input: RequestQueueSmokeInput): Promise<void> {
    const { check, currentRunId } = ctx;
    const prefix = runPrefix(currentRunId);
    const baseName = input.requestQueueSharedName ?? 'sdk-smoke-rq-shared';
    const queueName = `${baseName}-${currentRunId ?? Date.now()}`;

    await check('RQ.shared.dualConsumer', async () => {
        const q1 = await Actor.openRequestQueue(queueName);
        const q2 = await Actor.openRequestQueue(queueName);

        const slugs = ['dc-0', 'dc-1', 'dc-2', 'dc-3', 'dc-4'];
        for (const slug of slugs) {
            const uniqueKey = `${prefix}-${slug}`;
            await q1.addRequest({ url: urlFor(prefix, slug), uniqueKey });
        }

        const fetchedIds: string[] = [];
        const workers = slugs.map((_, i) => (i % 2 === 0 ? q1 : q2).fetchNextRequest());
        const results = await Promise.all(workers);
        for (const req of results) {
            if (!req?.id) return { ok: false, reason: 'parallel fetch returned null' };
            fetchedIds.push(req.id);
        }

        const unique = new Set(fetchedIds);
        return {
            queueName,
            fetchedCount: fetchedIds.length,
            uniqueCount: unique.size,
            noDuplicates: unique.size === fetchedIds.length,
        };
    });

    await check('RQ.shared.prolongOwnership', async () => {
        const isoName = `${queueName}-prolong`;
        const q1 = await Actor.openRequestQueue(isoName);
        const q2 = await Actor.openRequestQueue(isoName);

        const key1 = `${prefix}-prolong-1`;
        const key2 = `${prefix}-prolong-2`;
        await q1.addRequest({ url: urlFor(prefix, 'prolong-1'), uniqueKey: key1 });
        await q1.addRequest({ url: urlFor(prefix, 'prolong-2'), uniqueKey: key2 });

        const locked = await q1.fetchNextRequest();
        if (!locked?.id) return { ok: false, reason: 'q1 failed to lock first request' };

        const other = await q2.fetchNextRequest();
        return {
            lockedId: locked.id,
            otherId: other?.id ?? null,
            otherUniqueKey: other?.uniqueKey ?? null,
            noCrossLock: !other || other.id !== locked.id,
            expectedSecondKey: other?.uniqueKey === key2,
        };
    });
}

async function parityTests(ctx: RequestQueueSmokeContext): Promise<void> {
    const { check, currentRunId } = ctx;
    const prefix = runPrefix(currentRunId);

    await check('RQ.addRequest.forefront', async () => {
        const queueName = `sdk-smoke-rq-forefront-${Date.now()}`;
        const queue = await Actor.openRequestQueue(queueName);
        const keyBack = `${prefix}-forefront-back`;
        const keyFront = `${prefix}-forefront-front`;
        await queue.addRequest({ url: urlFor(prefix, 'forefront-back'), uniqueKey: keyBack });
        await queue.addRequest({ url: urlFor(prefix, 'forefront-front'), uniqueKey: keyFront }, { forefront: true });

        const first = await queue.fetchNextRequest();
        await queue.reclaimRequest(first!);
        return {
            firstUniqueKey: first?.uniqueKey ?? null,
            forefrontWorked: first?.uniqueKey === keyFront,
        };
    });

    await check('RQ.addRequests.batch', async () => {
        const queueName = `sdk-smoke-rq-addrequests-${Date.now()}`;
        const queue = await Actor.openRequestQueue(queueName);
        const before = await getQueueCounts(queue);
        const slugs = Array.from({ length: 30 }, (_, i) => `batch-${i}`);
        const requests = slugs.map((slug) => ({
            url: urlFor(prefix, slug),
            uniqueKey: `${prefix}-${slug}`,
        }));
        const result = await queue.addRequests(requests);
        const after = await getQueueCounts(queue);
        return {
            requested: requests.length,
            processed: result.processedRequests.length,
            unprocessed: result.unprocessedRequests.length,
            totalDelta: after.totalRequestCount - before.totalRequestCount,
            ok: result.processedRequests.length === requests.length
                && result.unprocessedRequests.length === 0
                && after.totalRequestCount - before.totalRequestCount >= requests.length,
        };
    });

    await check('RQ.addRequestsBatched.waitAll', async () => {
        const queueName = `sdk-smoke-rq-batched-${Date.now()}`;
        const queue = await Actor.openRequestQueue(queueName);
        const slugs = Array.from({ length: 30 }, (_, i) => `batched-${i}`);
        const requests = slugs.map((slug) => ({
            url: urlFor(prefix, slug),
            uniqueKey: `${prefix}-${slug}`,
        }));
        const { addedRequests, waitForAllRequestsToBeAdded } = await queue.addRequestsBatched(requests, {
            waitForAllRequestsToBeAdded: true,
        });
        await waitForAllRequestsToBeAdded;
        const after = await getQueueCounts(queue);
        return {
            addedRequests,
            pendingCount: after.pendingRequestCount,
            ok: addedRequests >= requests.length && after.pendingRequestCount >= requests.length,
        };
    });

    await check('RQ.getRequest', async () => {
        const queueName = `sdk-smoke-rq-getreq-${Date.now()}`;
        const queue = await Actor.openRequestQueue(queueName);
        const uniqueKey = `${prefix}-getreq`;
        const url = urlFor(prefix, 'getreq');
        const addResult = await queue.addRequest({ url, uniqueKey });
        const fetched = await queue.getRequest(addResult.requestId);
        return {
            requestId: addResult.requestId,
            found: !!fetched,
            urlMatch: (fetched as { url?: string } | null)?.url === url,
            uniqueKeyMatch: (fetched as { uniqueKey?: string } | null)?.uniqueKey === uniqueKey,
        };
    });

    await check('RQ.handledCount', async () => {
        const queueName = `sdk-smoke-rq-handledcount-${Date.now()}`;
        const queue = await Actor.openRequestQueue(queueName);
        const uniqueKey = `${prefix}-handledcount`;
        await queue.addRequest({ url: urlFor(prefix, 'handledcount'), uniqueKey });
        const before = await queue.handledCount();
        const req = await queue.fetchNextRequest();
        if (!req) return { ok: false, reason: 'no request to handle' };
        await queue.markRequestHandled(req);
        const after = await queue.handledCount();
        return {
            before,
            after,
            increased: after > before,
        };
    });

    await check('RQ.offlineCounts', async () => {
        const queueName = `sdk-smoke-rq-offline-${Date.now()}`;
        const queue = await Actor.openRequestQueue(queueName);
        const beforeTotal = queue.getTotalCount();
        const beforePending = queue.getPendingCount();
        await queue.addRequest({ url: urlFor(prefix, 'offline-a'), uniqueKey: `${prefix}-offline-a` });
        await queue.addRequest({ url: urlFor(prefix, 'offline-b'), uniqueKey: `${prefix}-offline-b` });
        return {
            beforeTotal,
            beforePending,
            afterTotal: queue.getTotalCount(),
            afterPending: queue.getPendingCount(),
            totalIncreased: queue.getTotalCount() > beforeTotal,
            pendingIncreased: queue.getPendingCount() > beforePending,
        };
    });

    await check('RQ.isEmpty.isFinished', async () => {
        const queueName = `sdk-smoke-rq-finished-${Date.now()}`;
        const queue = await Actor.openRequestQueue(queueName);
        const uniqueKey = `${prefix}-finished`;
        await queue.addRequest({ url: urlFor(prefix, 'finished'), uniqueKey });

        const emptyBeforeHandle = await queue.isEmpty();
        const finishedBeforeHandle = await queue.isFinished();

        const req = await queue.fetchNextRequest();
        if (!req) return { ok: false, reason: 'no request to handle' };
        await queue.markRequestHandled(req);

        const emptyAfterHandle = await queue.isEmpty();
        const finishedAfterHandle = await queue.isFinished();

        return {
            emptyBeforeHandle,
            finishedBeforeHandle,
            emptyAfterHandle,
            finishedAfterHandle,
            finishedWhenDrained: finishedAfterHandle === true,
        };
    });

    await check('RQ.asyncIterator', async () => {
        const queueName = `sdk-smoke-rq-iterator-${Date.now()}`;
        const queue = await Actor.openRequestQueue(queueName);
        const keys = ['iter-a', 'iter-b', 'iter-c'].map((s) => `${prefix}-${s}`);
        for (const key of keys) {
            await queue.addRequest({ url: urlFor(prefix, key), uniqueKey: key });
        }

        const seen: string[] = [];
        for await (const req of queue) {
            seen.push(req.uniqueKey);
            await queue.reclaimRequest(req);
            if (seen.length >= keys.length) break;
        }

        return {
            seenCount: seen.length,
            allKeysFound: keys.every((k) => seen.includes(k)),
        };
    });

    await check('RQ.getInfo.shape', async () => {
        const queue = await Actor.openRequestQueue();
        const info = await queue.getInfo();
        return {
            hasId: !!info?.id,
            hasCounts: info?.totalRequestCount !== undefined
                && info?.pendingRequestCount !== undefined
                && info?.handledRequestCount !== undefined,
            hasDates: !!info?.createdAt && !!info?.modifiedAt && !!info?.accessedAt,
            hasStats: info?.stats !== undefined
                && info.stats.readCount !== undefined
                && info.stats.writeCount !== undefined,
            hasActFields: info?.actId !== undefined || info?.actRunId !== undefined,
        };
    });

    await check('RQ.addRequest.forefrontCrossClient', async () => {
        const queueName = `sdk-smoke-rq-forefront-cc-${Date.now()}`;
        const keyBack = `${prefix}-forefront-cc-back`;
        const keyFront = `${prefix}-forefront-cc-front`;

        const producer = await Actor.openRequestQueue(queueName);
        await producer.addRequest({ url: urlFor(prefix, 'forefront-cc-back'), uniqueKey: keyBack });
        await producer.addRequest(
            { url: urlFor(prefix, 'forefront-cc-front'), uniqueKey: keyFront },
            { forefront: true },
        );

        const consumer = await Actor.openRequestQueue(queueName);
        const first = await consumer.fetchNextRequest();
        await consumer.reclaimRequest(first!);

        return {
            firstUniqueKey: first?.uniqueKey ?? null,
            forefrontWorked: first?.uniqueKey === keyFront,
        };
    });

    await check('RQ.reclaimRequest.forefrontCrossClient', async () => {
        const queueName = `sdk-smoke-rq-reclaim-cc-${Date.now()}`;
        const keyA = `${prefix}-reclaim-cc-a`;
        const keyB = `${prefix}-reclaim-cc-b`;

        const producer = await Actor.openRequestQueue(queueName);
        await producer.addRequest({ url: urlFor(prefix, 'reclaim-cc-a'), uniqueKey: keyA });
        await producer.addRequest({ url: urlFor(prefix, 'reclaim-cc-b'), uniqueKey: keyB });

        const consumer1 = await Actor.openRequestQueue(queueName);
        const locked = await consumer1.fetchNextRequest();
        if (!locked) return { ok: false, reason: 'no request to reclaim' };

        await consumer1.reclaimRequest(locked, { forefront: true });

        const consumer2 = await Actor.openRequestQueue(queueName);
        const again = await consumer2.fetchNextRequest();

        return {
            lockedUniqueKey: locked.uniqueKey,
            againUniqueKey: again?.uniqueKey ?? null,
            forefrontWorked: again?.uniqueKey === locked.uniqueKey,
        };
    });

    await check('RQ.addRequestsBatched.options', async () => {
        const queueName = `sdk-smoke-rq-batched-opts-${Date.now()}`;
        const queue = await Actor.openRequestQueue(queueName);
        const before = await getQueueCounts(queue);
        const slugs = Array.from({ length: 10 }, (_, i) => `batched-opts-${i}`);
        const requests = slugs.map((slug) => ({
            url: urlFor(prefix, slug),
            uniqueKey: `${prefix}-${slug}`,
        }));

        const { addedRequests, waitForAllRequestsToBeAdded } = await queue.addRequestsBatched(requests, {
            batchSize: 5,
            waitBetweenBatchesMillis: 50,
        });
        const initialAdded = addedRequests.length;
        const allAdded = await waitForAllRequestsToBeAdded;
        const after = await getQueueCounts(queue);

        return {
            requested: requests.length,
            initialAdded,
            allAddedCount: allAdded.length,
            totalDelta: after.totalRequestCount - before.totalRequestCount,
            ok: initialAdded >= 5
                && allAdded.length === requests.length
                && after.totalRequestCount - before.totalRequestCount >= requests.length,
        };
    });

    await check('RQ.drop', async () => {
        const queueName = `sdk-smoke-rq-drop-${Date.now()}`;
        const queue = await Actor.openRequestQueue(queueName);
        await queue.addRequest({
            url: urlFor(prefix, 'drop'),
            uniqueKey: `${prefix}-drop`,
        });
        const beforeDrop = await queue.getInfo();
        await queue.drop();
        const reopened = await Actor.openRequestQueue(queueName);
        const afterDrop = await getQueueCounts(reopened);
        return {
            droppedId: beforeDrop?.id ?? null,
            afterTotal: afterDrop.totalRequestCount,
            afterPending: afterDrop.pendingRequestCount,
            queueRecreatedEmpty: afterDrop.totalRequestCount === 0 && afterDrop.pendingRequestCount === 0,
        };
    });
}

async function verifyPostReboot(ctx: RequestQueueSmokeContext, checkpoint: RebootCheckpoint): Promise<void> {
    const { check } = ctx;

    await check('RQ.postReboot.verify', async () => {
        const queue = await Actor.openRequestQueue({ id: checkpoint.queueId });
        const info = await getQueueCounts(queue);

        const countsMatch =
            info.pendingRequestCount === checkpoint.pendingRequestCount
            && info.totalRequestCount === checkpoint.totalRequestCount
            && info.handledRequestCount === checkpoint.handledRequestCount;

        const fetchedKeys: string[] = [];
        const targetKeys = new Set(checkpoint.uniqueKeys);
        const maxAttempts = checkpoint.pendingRequestCount + checkpoint.uniqueKeys.length + 10;
        for (let i = 0; i < maxAttempts && fetchedKeys.length < checkpoint.uniqueKeys.length; i++) {
            const req = await queue.fetchNextRequest();
            if (!req) break;
            if (targetKeys.has(req.uniqueKey) && !fetchedKeys.includes(req.uniqueKey)) {
                fetchedKeys.push(req.uniqueKey);
            }
            await queue.reclaimRequest(req);
        }

        const keysFound = checkpoint.uniqueKeys.every((k) => fetchedKeys.includes(k));

        return {
            countsMatch,
            expected: {
                pending: checkpoint.pendingRequestCount,
                total: checkpoint.totalRequestCount,
                handled: checkpoint.handledRequestCount,
            },
            actual: info,
            keysFound,
            fetchedKeys,
        };
    });
}

async function seedRebootCheckpoint(ctx: RequestQueueSmokeContext): Promise<RebootCheckpoint> {
    const { currentRunId } = ctx;
    const prefix = runPrefix(currentRunId);
    const queue = await Actor.openRequestQueue();

    const key1 = `${prefix}-reboot-1`;
    const key2 = `${prefix}-reboot-2`;
    await queue.addRequest({ url: urlFor(prefix, 'reboot-1'), uniqueKey: key1 });
    await queue.addRequest({ url: urlFor(prefix, 'reboot-2'), uniqueKey: key2 });

    const counts = await getQueueCounts(queue);
    if (!counts.queueId) {
        throw new Error('default queue has no id for reboot checkpoint');
    }

    return {
        phase: 'awaiting_reboot',
        queueId: counts.queueId,
        pendingRequestCount: counts.pendingRequestCount,
        totalRequestCount: counts.totalRequestCount,
        handledRequestCount: counts.handledRequestCount,
        uniqueKeys: [key1, key2],
    };
}

/**
 * Run the isolated request-queue smoke suite.
 * Returns true if the run should end normally; false if Actor.reboot() was invoked (process restarts).
 */
export async function runRequestQueueSmokeSuite(
    input: RequestQueueSmokeInput,
    ctx: RequestQueueSmokeContext,
): Promise<'complete' | 'rebooted'> {
    const { check, skip, currentRunId, results } = ctx;

    await check('RQ.mode.init', async () => ({
        mode: 'request-queue-only',
        currentRunId,
        testRequestQueueReboot: input.testRequestQueueReboot ?? false,
    }));

    const rebootState = await Actor.getValue<RebootCheckpoint>(RQ_REBOOT_KVS_KEY);
    if (rebootState?.phase === 'awaiting_reboot') {
        await verifyPostReboot(ctx, rebootState);
        await Actor.setValue(RQ_REBOOT_KVS_KEY, null);
        await skip('RQ.reboot.seed', 'post-reboot verify only');
        return 'complete';
    }

    await openVariants(ctx);
    await defaultQueueTests(ctx);
    await namedPersistenceTest(ctx);
    await sharedQueueTests(ctx, input);
    await parityTests(ctx);

    if (input.testRequestQueueReboot) {
        const failed = results.filter((r) => r.status === 'fail');
        if (failed.length > 0) {
            await skip('RQ.reboot', `${failed.length} check(s) failed before reboot`);
            return 'complete';
        }

        const checkpoint = await seedRebootCheckpoint(ctx);
        await Actor.setValue(RQ_REBOOT_KVS_KEY, checkpoint);
        await check('RQ.reboot.seed', async () => ({
            queueId: checkpoint.queueId,
            pendingRequestCount: checkpoint.pendingRequestCount,
            uniqueKeys: checkpoint.uniqueKeys,
        }));
        console.log('[sdk-smoke-rq] Rebooting for persistence test...');
        await Actor.reboot({ customAfterSleepMillis: 0 });
        return 'rebooted';
    }

    await skip('RQ.reboot', 'testRequestQueueReboot not set');
    return 'complete';
}

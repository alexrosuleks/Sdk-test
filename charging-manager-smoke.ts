/**
 * Isolated ChargingManager smoke suite (enabled via input.testChargingManager).
 * Exercises all Apify-compatible ChargingManager methods on the platform.
 *
 * When the run has no maxTotalChargeUsd cap, calculateMaxEventChargeCountWithinLimit
 * correctly returns Infinity (unlimited). Set maxTotalChargeUsd on the run plus
 * testChargeBudgetLimits: true to exercise finite-remaining / partial-fulfillment paths.
 */

import {
    Actor,
    DEFAULT_DATASET_ITEM_EVENT,
    USES_PUSH_DATA_INTERCEPTION,
    type ActorPricingInfo,
    type ChargeResult,
} from 'scrapely';

export interface ChargingManagerSmokeInput {
    testChargingManager?: boolean;
    testChargeBudgetLimits?: boolean;
    chargeEventName?: string;
}

interface SmokeCheck {
    method: string;
    status: string;
    detail?: unknown;
    error?: string;
}

export interface ChargingManagerSmokeContext {
    currentRunId: string | null;
    smokeActor: InstanceType<typeof Actor>;
    results: SmokeCheck[];
    check: (method: string, fn: () => Promise<unknown>, required?: boolean) => Promise<void>;
    skip: (method: string, reason: string) => Promise<void>;
}

const UNKNOWN_EVENT = 'sdk-smoke-unregistered-event-xyz';

function getManager() {
    return Actor.getChargingManager();
}

function hasBudgetCap(pricing: ActorPricingInfo): boolean {
    return Number.isFinite(pricing.maxTotalChargeUsd);
}

function formatRemaining(value: number): number | string {
    return value === Infinity ? 'Infinity' : value;
}

function pricingSnapshot(pricing: ActorPricingInfo) {
    return {
        pricingModel: pricing.pricingModel ?? null,
        isPayPerEvent: pricing.isPayPerEvent,
        maxTotalChargeUsd: formatRemaining(pricing.maxTotalChargeUsd),
        budgetCapped: hasBudgetCap(pricing),
        perEventPrices: pricing.perEventPrices,
        eventNames: Object.keys(pricing.perEventPrices),
    };
}

function assertChargeResult(result: unknown): ChargeResult {
    if (!result || typeof result !== 'object') {
        throw new Error('charge result is not an object');
    }
    const r = result as ChargeResult;
    if (typeof r.chargedCount !== 'number') {
        throw new Error('missing chargedCount');
    }
    if (typeof r.eventChargeLimitReached !== 'boolean') {
        throw new Error('missing eventChargeLimitReached');
    }
    if (!r.chargeableWithinLimit || typeof r.chargeableWithinLimit !== 'object') {
        throw new Error('missing chargeableWithinLimit');
    }
    return r;
}

function hasDefaultDatasetItemInPricing(perEventPrices: Record<string, number>): boolean {
    return DEFAULT_DATASET_ITEM_EVENT in perEventPrices;
}

async function readOnlyChecks(ctx: ChargingManagerSmokeContext, input: ChargingManagerSmokeInput): Promise<void> {
    const { check, skip } = ctx;
    const manager = getManager();
    const pricing = manager.getPricingInfo();
    const eventName = input.chargeEventName;
    const countEvent = eventName ?? UNKNOWN_EVENT;

    await check('CM.init', async () => ({
        initialized: Actor.getDefaultInstance().initialized,
        managerReady: typeof manager.getPricingInfo === 'function',
    }));

    await check('CM.getChargingManager', async () => {
        const fromStatic = Actor.getChargingManager();
        const fromInstance = ctx.smokeActor.getChargingManager();
        return { sameInstance: fromStatic === fromInstance };
    });

    await check('CM.getPricingInfo.shape', async () => {
        const info = manager.getPricingInfo();
        if (typeof info.isPayPerEvent !== 'boolean') {
            return { ok: false, reason: 'isPayPerEvent must be boolean' };
        }
        if (typeof info.maxTotalChargeUsd !== 'number') {
            return { ok: false, reason: 'maxTotalChargeUsd must be number' };
        }
        if (!info.perEventPrices || typeof info.perEventPrices !== 'object') {
            return { ok: false, reason: 'perEventPrices must be object' };
        }
        return pricingSnapshot(info);
    });

    await check('CM.getMaxTotalChargeUsd', async () => {
        const fromMethod = manager.getMaxTotalChargeUsd();
        const fromPricing = manager.getPricingInfo().maxTotalChargeUsd;
        if (fromMethod !== fromPricing) {
            return { ok: false, reason: 'mismatch with getPricingInfo', fromMethod, fromPricing };
        }
        return { maxTotalChargeUsd: fromMethod };
    });

    await check('CM.DEFAULT_DATASET_ITEM_EVENT', async () => ({
        constant: DEFAULT_DATASET_ITEM_EVENT,
        expected: 'apify-default-dataset-item',
        matches: DEFAULT_DATASET_ITEM_EVENT === 'apify-default-dataset-item',
    }));

    await check('CM.getChargedEventCount', async () => {
        const count = manager.getChargedEventCount(countEvent);
        if (typeof count !== 'number' || count < 0) {
            return { ok: false, reason: 'expected non-negative number', count };
        }
        return { eventName: countEvent, count };
    });

    await check('CM.calculateMaxEventChargeCountWithinLimit.unknown', async () => {
        const remaining = manager.calculateMaxEventChargeCountWithinLimit(UNKNOWN_EVENT);
        if (remaining !== Infinity) {
            return { ok: false, reason: 'unregistered event should return Infinity', remaining };
        }
        return { remaining: formatRemaining(remaining) };
    });

    await check('CM.calculatePushDataLimits.shape', async () => {
        const items = [{ id: 1 }, { id: 2 }];
        const result = manager.calculatePushDataLimits({
            eventName: eventName,
            isDefaultDataset: true,
            items,
        });
        if (!('eventsToCharge' in result) || !('limitedItems' in result)) {
            return { ok: false, reason: 'missing expected keys', result };
        }
        return {
            limitedItemsCount: result.limitedItems.length,
            eventsToCharge: result.eventsToCharge,
        };
    });

    await check('CM.calculatePushDataLimits.singleItem', async () => {
        const item = { id: 'single' };
        const result = manager.calculatePushDataLimits({
            eventName: eventName,
            isDefaultDataset: false,
            items: item,
        });
        if (result.limitedItems.length !== 1) {
            return { ok: false, reason: 'expected one limited item', result };
        }
        return { limitedItemsCount: result.limitedItems.length };
    });

    await check('CM.calculatePushDataLimits.noDefaultDataset', async () => {
        const result = manager.calculatePushDataLimits({
            eventName: eventName,
            isDefaultDataset: false,
            items: [{ id: 1 }],
        });
        if (result.eventsToCharge[DEFAULT_DATASET_ITEM_EVENT] != null) {
            return {
                ok: false,
                reason: 'default dataset event should not appear when isDefaultDataset is false',
                eventsToCharge: result.eventsToCharge,
            };
        }
        return { eventsToCharge: result.eventsToCharge };
    });

    await check('CM.calculatePushDataLimits.noEventName', async () => {
        const result = manager.calculatePushDataLimits({
            eventName: undefined,
            isDefaultDataset: true,
            items: [{ id: 1 }],
        });
        if (eventName && result.eventsToCharge[eventName] != null) {
            return {
                ok: false,
                reason: 'custom event should not appear when eventName is undefined',
                eventsToCharge: result.eventsToCharge,
            };
        }
        return { eventsToCharge: result.eventsToCharge };
    });

    if (pricing.isPayPerEvent && eventName && eventName in pricing.perEventPrices) {
        await check('CM.calculateMaxEventChargeCountWithinLimit.known', async () => {
            const remaining = manager.calculateMaxEventChargeCountWithinLimit(eventName);
            const budgetCapped = hasBudgetCap(pricing);

            if (typeof remaining !== 'number' || (remaining < 0 && remaining !== Infinity)) {
                return {
                    ok: false,
                    reason: 'expected non-negative number or Infinity',
                    remaining: formatRemaining(remaining),
                };
            }
            if (budgetCapped && !Number.isFinite(remaining)) {
                return {
                    ok: false,
                    reason: 'expected finite number when budget is capped',
                    remaining: formatRemaining(remaining),
                    budgetCapped,
                };
            }
            if (!budgetCapped && remaining !== Infinity) {
                return {
                    ok: false,
                    reason: 'expected Infinity when no budget cap is set',
                    remaining: formatRemaining(remaining),
                    budgetCapped,
                };
            }
            return { eventName, remaining: formatRemaining(remaining), budgetCapped };
        });
    } else if (!pricing.isPayPerEvent) {
        await skip('CM.calculateMaxEventChargeCountWithinLimit.known', 'actor is not pay-per-event');
    } else if (!eventName) {
        await skip('CM.calculateMaxEventChargeCountWithinLimit.known', 'no chargeEventName in input');
    } else {
        await skip(
            'CM.calculateMaxEventChargeCountWithinLimit.known',
            `chargeEventName "${eventName}" not in perEventPrices`,
        );
    }
}

async function ppeLiveChecks(ctx: ChargingManagerSmokeContext, input: ChargingManagerSmokeInput): Promise<void> {
    const { check, skip } = ctx;
    const manager = getManager();
    const pricing = manager.getPricingInfo();
    const eventName = input.chargeEventName;

    if (!eventName) {
        await skip('CM.calculatePushDataLimits.ppeDefaultDataset', 'no chargeEventName in input');
        await skip('CM.charge.count1', 'no chargeEventName in input');
        await skip('CM.charge.ChargeResult.chargeableWithinLimit', 'no chargeEventName in input');
        await skip('CM.getChargedEventCount.afterCharge', 'no chargeEventName in input');
        await skip('CM.calculateMaxEventChargeCountWithinLimit.afterCharge', 'no chargeEventName in input');
        await skip('CM.smokeActor.charge.instance', 'no chargeEventName in input');
        await skip('CM.pushData.eventName', 'no chargeEventName in input');
        await skip('CM.apifyClient.dataset.pushItems', 'no chargeEventName in input');
        return;
    }

    if (!pricing.isPayPerEvent) {
        const reason = 'chargeEventName set but actor is not pay-per-event';
        await skip('CM.calculatePushDataLimits.ppeDefaultDataset', reason);
        await skip('CM.charge.count1', reason);
        await skip('CM.charge.ChargeResult.chargeableWithinLimit', reason);
        await skip('CM.getChargedEventCount.afterCharge', reason);
        await skip('CM.calculateMaxEventChargeCountWithinLimit.afterCharge', reason);
        await skip('CM.smokeActor.charge.instance', reason);
        await skip('CM.pushData.eventName', reason);
        await skip('CM.apifyClient.dataset.pushItems', reason);
        return;
    }

    if (!(eventName in pricing.perEventPrices)) {
        const reason = `chargeEventName "${eventName}" not in perEventPrices`;
        await skip('CM.calculatePushDataLimits.ppeDefaultDataset', reason);
        await skip('CM.charge.count1', reason);
        await skip('CM.charge.ChargeResult.chargeableWithinLimit', reason);
        await skip('CM.getChargedEventCount.afterCharge', reason);
        await skip('CM.calculateMaxEventChargeCountWithinLimit.afterCharge', reason);
        await skip('CM.smokeActor.charge.instance', reason);
        await skip('CM.pushData.eventName', reason);
        await skip('CM.apifyClient.dataset.pushItems', reason);
        return;
    }

    const hasDefaultDatasetPricing = hasDefaultDatasetItemInPricing(pricing.perEventPrices);

    if (hasDefaultDatasetPricing) {
        await check('CM.calculatePushDataLimits.ppeDefaultDataset', async () => {
            const result = manager.calculatePushDataLimits({
                eventName,
                isDefaultDataset: true,
                items: [{ id: 1 }, { id: 2 }],
            });
            if (result.limitedItems.length > 0 && result.eventsToCharge[DEFAULT_DATASET_ITEM_EVENT] == null) {
                return {
                    ok: false,
                    reason: 'PPE default dataset push should include default dataset item charge',
                    eventsToCharge: result.eventsToCharge,
                };
            }
            return {
                eventsToCharge: result.eventsToCharge,
                limitedItemsCount: result.limitedItems.length,
            };
        });
    } else {
        await skip(
            'CM.calculatePushDataLimits.ppeDefaultDataset',
            `${DEFAULT_DATASET_ITEM_EVENT} not in perEventPrices`,
        );
    }

    const countBefore = manager.getChargedEventCount(eventName);
    const remainingBefore = manager.calculateMaxEventChargeCountWithinLimit(eventName);

    let chargeResult: ChargeResult | undefined;

    await check('CM.charge.count1', async () => {
        const result = assertChargeResult(await Actor.charge({ eventName, count: 1 }));
        if (result.chargedCount < 0 || result.chargedCount > 1) {
            return {
                ok: false,
                reason: 'unexpected chargedCount for count=1',
                chargedCount: result.chargedCount,
            };
        }
        chargeResult = result;
        return {
            chargedCount: result.chargedCount,
            eventChargeLimitReached: result.eventChargeLimitReached,
        };
    });

    await check('CM.charge.ChargeResult.chargeableWithinLimit', async () => {
        if (!chargeResult) {
            return { ok: false, reason: 'CM.charge.count1 did not run' };
        }
        const keys = Object.keys(chargeResult.chargeableWithinLimit);
        const pricedEvents = Object.keys(pricing.perEventPrices);
        for (const name of pricedEvents) {
            if (!(name in chargeResult.chargeableWithinLimit)) {
                return {
                    ok: false,
                    reason: `missing event "${name}" in chargeableWithinLimit`,
                    keys,
                    pricedEvents,
                };
            }
            if (typeof chargeResult.chargeableWithinLimit[name] !== 'number') {
                return { ok: false, reason: `non-number limit for "${name}"` };
            }
        }
        return { keys, pricedEvents };
    });

    await check('CM.getChargedEventCount.afterCharge', async () => {
        const countAfter = manager.getChargedEventCount(eventName);
        const chargedDelta = countAfter - countBefore;
        if (!chargeResult || chargedDelta !== chargeResult.chargedCount) {
            return {
                ok: false,
                reason: 'charged count did not increase by chargedCount',
                countBefore,
                countAfter,
                chargedCount: chargeResult?.chargedCount,
            };
        }
        return { countBefore, countAfter, chargedDelta };
    });

    await check('CM.calculateMaxEventChargeCountWithinLimit.afterCharge', async () => {
        const remainingAfter = manager.calculateMaxEventChargeCountWithinLimit(eventName);
        const budgetCapped = hasBudgetCap(pricing);

        if (!chargeResult || chargeResult.chargedCount <= 0) {
            return {
                remainingBefore: formatRemaining(remainingBefore),
                remainingAfter: formatRemaining(remainingAfter),
                note: 'no charge applied',
            };
        }

        if (!budgetCapped) {
            return {
                remainingBefore: formatRemaining(remainingBefore),
                remainingAfter: formatRemaining(remainingAfter),
                budgetCapped,
                note: 'unlimited budget — remaining stays Infinity',
            };
        }

        if (!Number.isFinite(remainingBefore) || !Number.isFinite(remainingAfter)) {
            return {
                ok: false,
                reason: 'expected finite remaining counts when budget is capped',
                remainingBefore: formatRemaining(remainingBefore),
                remainingAfter: formatRemaining(remainingAfter),
                budgetCapped,
            };
        }

        if (remainingAfter >= remainingBefore) {
            return {
                ok: false,
                reason: 'remaining budget should decrease after charge',
                remainingBefore: formatRemaining(remainingBefore),
                remainingAfter: formatRemaining(remainingAfter),
                chargedCount: chargeResult.chargedCount,
                budgetCapped,
            };
        }

        return {
            remainingBefore: formatRemaining(remainingBefore),
            remainingAfter: formatRemaining(remainingAfter),
            budgetCapped,
        };
    });

    await check('CM.smokeActor.charge.instance', async () => {
        const result = assertChargeResult(await ctx.smokeActor.charge(eventName, 1));
        if (result.chargedCount < 0 || result.chargedCount > 1) {
            return {
                ok: false,
                reason: 'unexpected chargedCount for instance charge count=1',
                chargedCount: result.chargedCount,
            };
        }
        return { chargedCount: result.chargedCount };
    });

    await check('CM.pushData.eventName', async () => {
        const result = assertChargeResult(
            await Actor.pushData({ cmSmokePush: true, ts: Date.now() }, eventName),
        );
        if (result.chargedCount < 0) {
            return { ok: false, reason: 'negative chargedCount', chargedCount: result.chargedCount };
        }
        return {
            chargedCount: result.chargedCount,
            eventChargeLimitReached: result.eventChargeLimitReached,
        };
    });

    if (hasDefaultDatasetPricing) {
        await check('CM.apifyClient.dataset.pushItems', async () => {
            const defaultDatasetId = Actor.getDefaultInstance().config.get('defaultDatasetId');
            if (!defaultDatasetId) {
                return { ok: false, reason: 'defaultDatasetId not configured' };
            }

            const client = Actor.apifyClient.dataset(defaultDatasetId);
            const patched = Boolean(
                (client as unknown as Record<symbol, boolean>)[USES_PUSH_DATA_INTERCEPTION],
            );
            if (!patched) {
                return {
                    ok: false,
                    reason: 'default dataset client should use push-data interception for PPE',
                    defaultDatasetId,
                };
            }

            const before = manager.getChargedEventCount(DEFAULT_DATASET_ITEM_EVENT);
            await client.pushItems([{ cmSmokeClientPush: true, ts: Date.now() }]);
            const after = manager.getChargedEventCount(DEFAULT_DATASET_ITEM_EVENT);

            return {
                patched,
                defaultDatasetId,
                defaultDatasetItemCountBefore: before,
                defaultDatasetItemCountAfter: after,
                increased: after >= before,
            };
        });
    } else {
        await skip(
            'CM.apifyClient.dataset.pushItems',
            `${DEFAULT_DATASET_ITEM_EVENT} not in perEventPrices`,
        );
    }
}

async function budgetLimitChecks(ctx: ChargingManagerSmokeContext, input: ChargingManagerSmokeInput): Promise<void> {
    const { check, skip } = ctx;
    const manager = getManager();
    const pricing = manager.getPricingInfo();
    const eventName = input.chargeEventName;

    if (!input.testChargeBudgetLimits) {
        await skip('CM.charge.partialFulfillment', 'testChargeBudgetLimits not set');
        return;
    }

    if (!eventName || !pricing.isPayPerEvent || !(eventName in pricing.perEventPrices)) {
        await skip('CM.charge.partialFulfillment', 'requires PPE actor with valid chargeEventName');
        return;
    }

    if (!hasBudgetCap(pricing)) {
        await skip('CM.charge.partialFulfillment', 'requires run-level maxTotalChargeUsd budget cap');
        return;
    }

    const remaining = manager.calculateMaxEventChargeCountWithinLimit(eventName);
    if (!Number.isFinite(remaining) || remaining <= 0) {
        await skip('CM.charge.partialFulfillment', 'no remaining budget for partial-fulfillment test');
        return;
    }

    const requestCount = remaining + 5;

    await check('CM.charge.partialFulfillment', async () => {
        const result = assertChargeResult(await Actor.charge({ eventName, count: requestCount }));
        if (result.chargedCount >= requestCount) {
            return {
                ok: false,
                reason: 'expected partial fulfillment when count exceeds remaining budget',
                requestCount,
                chargedCount: result.chargedCount,
                remainingBefore: formatRemaining(remaining),
            };
        }
        if (result.chargedCount <= 0) {
            return {
                ok: false,
                reason: 'expected at least one charge when budget remains',
                requestCount,
                chargedCount: result.chargedCount,
                remainingBefore: formatRemaining(remaining),
            };
        }
        return {
            requestCount,
            chargedCount: result.chargedCount,
            remainingBefore: formatRemaining(remaining),
            partial: result.chargedCount < requestCount,
        };
    });
}

/**
 * Run the isolated ChargingManager smoke suite.
 */
export async function runChargingManagerSmokeSuite(
    input: ChargingManagerSmokeInput,
    ctx: ChargingManagerSmokeContext,
): Promise<'complete'> {
    const { check, currentRunId } = ctx;

    await check('CM.mode.init', async () => ({
        mode: 'charging-manager-only',
        currentRunId,
        chargeEventName: input.chargeEventName ?? null,
        testChargeBudgetLimits: input.testChargeBudgetLimits ?? false,
        pricing: pricingSnapshot(getManager().getPricingInfo()),
    }));

    await readOnlyChecks(ctx, input);
    await ppeLiveChecks(ctx, input);
    await budgetLimitChecks(ctx, input);

    return 'complete';
}

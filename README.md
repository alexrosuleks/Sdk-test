# sdk-smoke-actor

Platform smoke test for the Scrapely Actor SDK. Each API check is recorded in the default dataset; the run fails if any **required** check fails.

## Configuration / constructor checks

- `new Actor(options)` and `instance.configuration`
- Static `Actor.configuration` (not `Actor.config`)
- `Actor.getDefaultInstance()`
- Standby getters (`isStandby`, `standbyPort`, …)
- Optional: `CRAWLEE_*` env bridges when running on Scrapely

## Run

```bash
npm install
npm start   # local only if SCRAPELY_* env + storage are set
```

On the platform (recommended), push this actor and run with optional input:

```json
{
  "targetActorId": "user/another-actor",
  "chargeEventName": "my-event",
  "skipDestructive": true
}
```

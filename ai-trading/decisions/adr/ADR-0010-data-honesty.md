# ADR-0010: Honest data states, never fabricated values

Status: standing rule. Sources: [02l](../../plans/subplans/02l-desk-desktop-first-mvp.md) c3, [02t §5.5](../../plans/subplans/02t-market-data-bridge-plan.md), [02m §a1](../../plans/subplans/02m-desk-mvp-implementation-spec.md).

Decision: every number on screen comes from a stored row with a vendor + delay stamp; a tile with no row reads **unavailable** and says why. Nothing delayed is ever labeled realtime; the top bar says "last close" only when the strip's `as_of` is the last close. A job that fetched nothing reports an **honest empty/degraded state** (and `feed_health.detail` says so) instead of a fake-ok; failures log at warning level and never kill the scheduler tick. Production fixtures are marked `SIMULATED DESIGN CONTENT` and carry no order controls.

Consequences: rows 5T/5U exist because this rule caught their violations (silent stale strip, fake-ok passes); the shadow card carries a "Preview" badge; alerts evaluated on delayed data keep today's delayed stamp.

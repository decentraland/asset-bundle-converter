# Impact queries — asset reuse (PR #258) + fast-path (PR #287)

> **Scope: Mac + Windows pools only.** WebGL is out of scope for this report. PR #287 (fast-path triage split) has not been deployed to the WebGL pool either way (no `ab_converter_running_triage` series on `service=asset-bundle-converter`).

Paste each query into **Grafana Explore** with the Prometheus datasource `prom-prd`. Replace `$service` with `asset-bundle-converter-(mac|windows)` (the regex form is required — PromQL `=~` is anchored).

To filter to one specific pool, swap `service=~"$service"` for `service="asset-bundle-converter-mac"` or `service="asset-bundle-converter-windows"`.

**Rate window note.** Most rate queries use `[$__rate_interval]` (Grafana adapts to panel resolution). For sparse counters (short-circuits, etc.) the queries use a fixed `[1h]`. If a query returns nothing, widen to `[1h]` or `[6h]`.

**Rollout pivots:**
- Asset reuse on (Mac + Windows): **2026-05-13**
- Fast-path on (Mac + Windows): **2026-05-20**

---

## A. Asset reuse impact

> Set Explore time range to **2026-05-13 00:00 UTC → 2026-05-19 23:59 UTC** for A1–A7 (7 days post-reuse, before fast-path contaminates).

### A1. Unity spawns avoided per hour (graph)
```promql
sum(rate(ab_converter_asset_reuse_short_circuit_total{service=~"$service"}[1h])) * 3600
```

### A1a. Unity spawns avoided per hour, per pool (graph, 2 lines)
```promql
sum by (service) (rate(ab_converter_asset_reuse_short_circuit_total{service=~"$service"}[1h])) * 3600
```

### A2. Total scenes short-circuited (instant)
```promql
sum(increase(ab_converter_asset_reuse_short_circuit_total{service=~"$service"}[$__range]))
```

### A3. Scenes short-circuited per pool (instant, one row per pool)
```promql
sum by (service) (increase(ab_converter_asset_reuse_short_circuit_total{service=~"$service"}[$__range]))
```

### A4. Asset cache hit ratio over time (graph, 0–1)
```promql
sum(rate(ab_converter_asset_cache_hits_total{service=~"$service"}[$__rate_interval]))
/
clamp_min(
  sum(rate(ab_converter_asset_cache_hits_total{service=~"$service"}[$__rate_interval]))
  + sum(rate(ab_converter_asset_cache_misses_total{service=~"$service"}[$__rate_interval])),
  1
)
```

### A5. Asset cache hit ratio per pool (graph, 2 lines)
```promql
sum by (service) (rate(ab_converter_asset_cache_hits_total{service=~"$service"}[$__rate_interval]))
/
clamp_min(
  sum by (service) (rate(ab_converter_asset_cache_hits_total{service=~"$service"}[$__rate_interval]))
  + sum by (service) (rate(ab_converter_asset_cache_misses_total{service=~"$service"}[$__rate_interval])),
  1
)
```

### A6. LRU effectiveness — share of probes that skipped S3 HEAD (graph, 0–1)
```promql
sum(rate(ab_converter_asset_probe_hit_cache_total{service=~"$service"}[$__rate_interval]))
/
clamp_min(
  sum(rate(ab_converter_asset_probe_hit_cache_total{service=~"$service"}[$__rate_interval]))
  + sum(rate(ab_converter_asset_probe_head_total{service=~"$service"}[$__rate_interval])),
  1
)
```

### A7. Probe errors (instant; should be ~0)
```promql
sum(increase(ab_converter_asset_cache_probe_errors_total{service=~"$service"}[$__range]))
```

---

## B. End-to-end latency — before vs after asset reuse

Run each query **twice**: once with Explore time range **2026-05-05 → 2026-05-12** (before), once with **2026-05-13 → 2026-05-19** (after). Compare side by side.

> **Histogram note.** `job_queue_duration_seconds` has wide buckets (1s, 10s, 100s … 3600s). `rate(...[$__rate_interval])` over a histogram is unreliable — many buckets stay at zero and `histogram_quantile` returns no result. Use `[1h]` as the rate window for percentile queries, or use the `_sum / _count` mean which always returns something if any jobs completed.
>
> Post-PR-#287 the distribution is bimodal (fast-path: sub-second; Unity: minutes). Prefer the mean (B0 / B0a) for cross-rollout comparison.

### B0. Mean job duration overall (always populates if any jobs completed)
```promql
sum(rate(job_queue_duration_seconds_sum{service=~"$service"}[1h]))
/
clamp_min(sum(rate(job_queue_duration_seconds_count{service=~"$service"}[1h])), 1)
```

### B0a. Mean job duration per pool (graph, 2 lines)
```promql
sum by (service) (rate(job_queue_duration_seconds_sum{service=~"$service"}[1h]))
/
clamp_min(sum by (service) (rate(job_queue_duration_seconds_count{service=~"$service"}[1h])), 1)
```

### B1. p50 job duration per pool (graph, 2 lines)
```promql
histogram_quantile(0.5, sum by (le, service) (rate(job_queue_duration_seconds_bucket{service=~"$service"}[1h])))
```

### B2. p95 job duration per pool (graph, 2 lines)
```promql
histogram_quantile(0.95, sum by (le, service) (rate(job_queue_duration_seconds_bucket{service=~"$service"}[1h])))
```

### B2-mac. p95 — Mac only
```promql
histogram_quantile(0.95, sum by (le) (rate(job_queue_duration_seconds_bucket{service="asset-bundle-converter-mac"}[1h])))
```

### B2-windows. p95 — Windows only
```promql
histogram_quantile(0.95, sum by (le) (rate(job_queue_duration_seconds_bucket{service="asset-bundle-converter-windows"}[1h])))
```

### B3. Successful conversions per hour
```promql
sum(rate(ab_converter_exit_codes{exit_code="0",service=~"$service"}[$__rate_interval])) * 3600
```

---

## C. Latency before vs after — single chart with `offset`

To overlay "now" vs "before". Set Explore time range to the **after** window (`2026-05-13 → 2026-05-19`); the `offset 10d` line draws the matching pre-rollout days (10d puts the comparison line on 2026-05-03 to 2026-05-09, well before the 2026-05-13 pivot).

### C1. p50 — current vs 10d earlier (two queries, same chart)
```promql
histogram_quantile(0.5, sum by (le) (rate(job_queue_duration_seconds_bucket{service=~"$service"}[1h])))
```
```promql
histogram_quantile(0.5, sum by (le) (rate(job_queue_duration_seconds_bucket{service=~"$service"}[1h] offset 10d)))
```

### C2. p95 — current vs 10d earlier
```promql
histogram_quantile(0.95, sum by (le) (rate(job_queue_duration_seconds_bucket{service=~"$service"}[1h])))
```
```promql
histogram_quantile(0.95, sum by (le) (rate(job_queue_duration_seconds_bucket{service=~"$service"}[1h] offset 10d)))
```

### C3. Throughput — current vs 10d earlier
```promql
sum(rate(ab_converter_exit_codes{exit_code="0",service=~"$service"}[$__rate_interval])) * 3600
```
```promql
sum(rate(ab_converter_exit_codes{exit_code="0",service=~"$service"}[$__rate_interval] offset 10d)) * 3600
```

---

## D. Fast-path impact

> Set Explore time range to **2026-05-20 00:00 UTC → now**. ~2 days of data so far; re-run on/after **2026-05-27** for a defensible read.

> **Instrumentation gap — several counters are not exposed in production.** As of 2026-05-22 the following metrics return no data despite the call sites being present in code:
> - `ab_converter_triage_outcomes_total` — never incremented (call sites at `consumer-server/src/logic/conversion-task.ts:167,199,208,219,228,239,280,291`)
> - `ab_converter_conversion_queue_publish_total` — never incremented (call site at `consumer-server/src/logic/conversion-orchestrator/component.ts:140`)
> - `ab_converter_conversion_queue_publish_errors_total` — never incremented (call site at `consumer-server/src/logic/conversion-orchestrator/component.ts:148`)
> - `ab_converter_republish_fallback_inline_total` — never incremented (call site at `consumer-server/src/logic/conversion-orchestrator/component.ts:171`)
>
> `prom-client` does not expose a labelled counter until it is incremented at least once. The triage **gauge** (`ab_converter_running_triage`) IS being emitted on Mac/Windows, so the triage code path IS running — but none of the outcome/publish counters fire. Most likely the running image's `metrics.ts` does not include these declarations and the WKC metrics component silently drops the increment calls. Investigate by curl'ing `/metrics` on a Mac or Windows pod and grep'ing for `ab_converter_triage_outcomes_total` / `ab_converter_conversion_queue_publish_total`.
>
> Queries D1, D2, D3, D5, D6 below depend on the broken counters and will return no data until the instrumentation is fixed. **D-proxy** queries below give the same business signal using counters that ARE working (`ab_converter_asset_reuse_short_circuit_total`, `ab_converter_exit_codes`). D4 (the concurrency gauges) works as-is.

### D-proxy-1. Fast-path share of successful completions (works today)
```promql
sum(rate(ab_converter_asset_reuse_short_circuit_total{service=~"$service"}[1h]))
/
clamp_min(sum(rate(ab_converter_exit_codes{exit_code="0",service=~"$service"}[1h])), 1)
```
A short-circuit IS a fast-path completion (same code path in `executeTriagePass`, `full-hit` branch — both counters increment together). `exit_codes{exit_code="0"}` counts ALL successful completions (fast-path + Unity slow-path). Ratio = fraction of successful completions that skipped Unity.

### D-proxy-2. Fast-path scenes per hour, per pool (works today)
```promql
sum by (service) (rate(ab_converter_asset_reuse_short_circuit_total{service=~"$service"}[1h])) * 3600
```

### D-proxy-3. Slow-path (Unity) completions per hour, per pool (works today)
```promql
sum by (service) (
  rate(ab_converter_exit_codes{exit_code="0",service=~"$service"}[1h])
  - rate(ab_converter_asset_reuse_short_circuit_total{service=~"$service"}[1h])
) * 3600
```

### D4. Concurrency uplift — triage gauge vs Unity gauge (works today)
```promql
sum by (service) (ab_converter_running_triage{service=~"$service"})
```
```promql
sum by (service) (ab_converter_running_conversion{service=~"$service"})
```
`running_triage` (cheap, S3-probe-bound) should comfortably exceed `running_conversion` (Unity-spawn-bound) — that's the concurrency-multiplier story.

### D1, D2, D3, D5, D6 — currently blocked

Will return no data until the missing counter increments reach production. Queries are kept here so they can be re-run once the instrumentation is fixed.

D1 — fast-path share via dedicated counter:
```promql
sum(rate(ab_converter_triage_outcomes_total{outcome="fast_path",service=~"$service"}[1h]))
/
clamp_min(sum(rate(ab_converter_triage_outcomes_total{service=~"$service"}[1h])), 1)
```
D2 — outcomes per hour:
```promql
sum by (outcome) (rate(ab_converter_triage_outcomes_total{service=~"$service"}[1h])) * 3600
```
D3 — outcomes totals over range:
```promql
sum by (outcome) (increase(ab_converter_triage_outcomes_total{service=~"$service"}[$__range]))
```
D5 — Conversion-queue publishes per hour by priority lane:
```promql
sum by (priority) (rate(ab_converter_conversion_queue_publish_total{service=~"$service"}[1h])) * 3600
```
D6 — operational health (both should be 0):
```promql
sum(rate(ab_converter_conversion_queue_publish_errors_total{service=~"$service"}[1h])) * 3600
```
```promql
sum(rate(ab_converter_republish_fallback_inline_total{service=~"$service"}[1h])) * 3600
```

---

## E. Latency before vs after fast-path — overlay

Set Explore time range to **2026-05-20 → now**; the `offset 7d` line gives matching pre-fast-path days (post-reuse, pre-fast-path, so the only variable is the triage split).

### E1. p50 — current vs 7d earlier
```promql
histogram_quantile(0.5, sum by (le) (rate(job_queue_duration_seconds_bucket{service=~"$service"}[1h])))
```
```promql
histogram_quantile(0.5, sum by (le) (rate(job_queue_duration_seconds_bucket{service=~"$service"}[1h] offset 7d)))
```

### E2. p95 — current vs 7d earlier
```promql
histogram_quantile(0.95, sum by (le) (rate(job_queue_duration_seconds_bucket{service=~"$service"}[1h])))
```
```promql
histogram_quantile(0.95, sum by (le) (rate(job_queue_duration_seconds_bucket{service=~"$service"}[1h] offset 7d)))
```

### E3. Mean — current vs 7d earlier (more robust than percentiles for bimodal distribution)
```promql
sum(rate(job_queue_duration_seconds_sum{service=~"$service"}[1h]))
/
clamp_min(sum(rate(job_queue_duration_seconds_count{service=~"$service"}[1h])), 1)
```
```promql
sum(rate(job_queue_duration_seconds_sum{service=~"$service"}[1h] offset 7d))
/
clamp_min(sum(rate(job_queue_duration_seconds_count{service=~"$service"}[1h] offset 7d)), 1)
```

---

## F. SQS oldest-message-age (CloudWatch — switch datasource to `ioi-prd`)

Not PromQL. In Explore, switch the datasource to CloudWatch, then:

- Namespace: `AWS/SQS`
- Metric: `ApproximateAgeOfOldestMessage`
- Dimension: `QueueName=~"ab-conversion-queue-(mac|windows)-.*"` (regex matches both pools' queues; ignores the unsuffixed WebGL queue)
- Statistic: `Maximum`
- Period: `1m`

Set the time range to a 14-day window spanning **2026-05-05 → now** to see both rollouts on one graph.

If your CloudWatch console doesn't accept regex dimension values, run twice with literal `QueueName`s:
- `ab-conversion-queue-mac-0acb3b6`
- `ab-conversion-queue-windows-55cd2f7`

---

## G. Compute-hours saved (paper calc, not a query)

```
hours_saved = A3_result × B0a_before_result / 3600     # per pool, then sum
```

For each pool (Mac, Windows):

- `A3_result` (per pool) — scenes short-circuited over the after window. Run A3 as instant with time range 2026-05-13 → 2026-05-19.
- `B0a_before_result` (per pool) — mean job duration in seconds over the before window. Run B0a with time range 2026-05-05 → 2026-05-12, filter to one pool.

Sum the per-pool products and divide by 3600 to get total compute hours saved.

This is a conservative proxy: `job_queue_duration_seconds` is "time the job spent in the worker" — dominated by but not strictly equal to Unity spawn cost.

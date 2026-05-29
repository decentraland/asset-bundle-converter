import { IMetricsComponent } from '@well-known-components/interfaces'
import { validateMetricsDeclaration } from '@well-known-components/metrics'
import { metricDeclarations as logsMetricsDeclarations } from '@well-known-components/logger'
import { queueMetrics } from './adapters/task-queue'
import { getDefaultHttpMetrics } from '@well-known-components/http-server'

export const metricDeclarations = {
  ...getDefaultHttpMetrics(),
  ...logsMetricsDeclarations,
  ...queueMetrics,
  ab_converter_exit_codes: {
    help: 'Counter of exit codes of asset bundle conversions',
    type: IMetricsComponent.CounterType,
    labelNames: ['exit_code']
  },
  ab_converter_empty_conversion: {
    help: 'Counter of conversions with empty files',
    type: IMetricsComponent.CounterType,
    labelNames: ['ab_version']
  },
  ab_converter_timeout: {
    help: 'Counter of timed out conversions',
    type: IMetricsComponent.CounterType
  },
  ab_converter_running_conversion: {
    help: 'Gauge of running Unity conversions (excludes triage-only fast-path work — see ab_converter_running_triage)',
    type: IMetricsComponent.GaugeType
  },
  ab_converter_running_triage: {
    help: 'Gauge of triage passes currently in flight (probe + fast-path or republish-to-Unity decision)',
    type: IMetricsComponent.GaugeType
  },
  ab_converter_free_disk_space: {
    help: 'Free bytes in disk',
    type: IMetricsComponent.GaugeType
  },
  ab_converter_asset_cache_hits_total: {
    help: 'Counter of per-asset cache hits (asset hash already canonicalized)',
    type: IMetricsComponent.CounterType,
    labelNames: ['build_target', 'ab_version']
  },
  ab_converter_asset_cache_misses_total: {
    help: 'Counter of per-asset cache misses (asset hash needs conversion)',
    type: IMetricsComponent.CounterType,
    labelNames: ['build_target', 'ab_version']
  },
  ab_converter_asset_reuse_short_circuit_total: {
    help: 'Counter of scenes that skipped Unity entirely because all assets were cached',
    type: IMetricsComponent.CounterType,
    labelNames: ['build_target', 'ab_version']
  },
  ab_converter_asset_probe_hit_cache_total: {
    help: 'Counter of asset cache probes served from the Redis hit-cache (skipping S3 HEAD)',
    type: IMetricsComponent.CounterType,
    labelNames: ['build_target', 'ab_version']
  },
  ab_converter_glb_deps_cache_total: {
    help: 'Counter of Redis-cached glb URI lookups, labelled by outcome ∈ {hit, miss}. A hit means the catalyst byte fetch + JSON parse for that glb was skipped because another probe (here or on a peer pod) already cached the URI list. Track hit rate to size the cache and tune the TTL.',
    type: IMetricsComponent.CounterType,
    labelNames: ['build_target', 'ab_version', 'outcome']
  },
  ab_converter_redis_cache_errors_total: {
    help: 'Counter of Redis errors observed by the cache helpers. operation ∈ {get, set, exists}; kind ∈ {probe-hit, glb-deps}. A sustained spike here means cache lookups are silently falling through to the cold path even when the data is in Redis — alert on this to catch a Redis outage that would otherwise look like normal cache misses on the other counters.',
    type: IMetricsComponent.CounterType,
    labelNames: ['operation', 'kind']
  },
  ab_converter_asset_probe_head_total: {
    help: 'Counter of asset cache probes that required a fresh S3 HEAD request',
    type: IMetricsComponent.CounterType,
    labelNames: ['build_target', 'ab_version']
  },
  ab_converter_asset_cache_probe_errors_total: {
    help: 'Counter of asset cache probe failures (S3 error propagated; conversion fell back to full Unity run)',
    type: IMetricsComponent.CounterType,
    labelNames: ['build_target', 'ab_version']
  },
  ab_converter_glb_skipped_total: {
    help: 'Counter of glb/gltf assets silently skipped (missing dependencies or unparseable bytes)',
    type: IMetricsComponent.CounterType,
    labelNames: ['build_target', 'ab_version', 'reason']
  },
  ab_converter_triage_outcomes_total: {
    help: 'Counter of triage-pass outcomes per scene. outcome ∈ {already_converted, fast_path, republished, failed}.',
    type: IMetricsComponent.CounterType,
    labelNames: ['build_target', 'outcome']
  },
  ab_converter_conversion_queue_publish_total: {
    help: 'Counter of triage republishes to the Conversion queue, labelled by priority lane (priority / standard)',
    type: IMetricsComponent.CounterType,
    labelNames: ['build_target', 'priority']
  },
  ab_converter_conversion_queue_publish_errors_total: {
    help: 'Counter of failed Conversion-queue publishes from the triage loop. Non-zero triggers the inline-fallback path (see ab_converter_republish_fallback_inline_total) so work is not lost, but indicates a wedged downstream queue — alert on this.',
    type: IMetricsComponent.CounterType,
    labelNames: ['build_target']
  },
  ab_converter_republish_fallback_inline_total: {
    help: 'Counter of triage jobs that ran Unity inline on the triage pod because Conversion-queue publish failed. Pair with conversion_queue_publish_errors_total to confirm fallback coverage.',
    type: IMetricsComponent.CounterType,
    labelNames: ['build_target']
  },
  ab_converter_engine_used_total: {
    help: 'Counter of which engine processed a scene-converter request. engine ∈ {unity, encoder, encoder-fallback-unity, unity-unsupported-target, unity-missing-inputs}. During rollout: watch for non-zero encoder-fallback-unity (encoder threw but Unity recovered) and the two unity-* fallback reasons (encoder enabled but not selected — usually a misconfigured pod).',
    type: IMetricsComponent.CounterType,
    labelNames: ['engine']
  },
  ab_converter_encoder_errors_total: {
    help: 'Counter of encoder errors that rejected the encode() promise, labelled by error code from EncoderError. code ∈ {TARGET_MISMATCH, INVALID_BAKE, NOT_STARTED, MISSING_DEPS_DIGEST, OUT_OF_MEMORY, INTERNAL, UNKNOWN}. INTERNAL is the only code that triggers Unity fallback when ENCODER_FALLBACK_TO_UNITY=true.',
    type: IMetricsComponent.CounterType,
    labelNames: ['build_target', 'code']
  },
  ab_converter_encoder_partial_failures_total: {
    help: "Counter of per-asset failures the encoder tolerated within a scene (broken glb, missing dep, etc.). Mirrors Unity's per-glb skip semantics but reported as a counter to match the existing taxonomy.",
    type: IMetricsComponent.CounterType,
    labelNames: ['build_target', 'ab_version']
  },
  ab_converter_encoder_wall_seconds: {
    help: 'Histogram of encoder convert() wall time per scene. Compare against the implicit Unity-spawn duration to track latency wins during rollout.',
    type: IMetricsComponent.HistogramType,
    labelNames: ['build_target', 'ab_version'],
    buckets: [0.1, 0.5, 1, 2, 5, 10, 30, 60, 120, 300, 600]
  }
}

// type assertions
validateMetricsDeclaration(metricDeclarations)

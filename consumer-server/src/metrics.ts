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
  }
}

// type assertions
validateMetricsDeclaration(metricDeclarations)

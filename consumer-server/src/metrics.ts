import { IMetricsComponent } from '@well-known-components/interfaces'
import { validateMetricsDeclaration } from '@dcl/metrics'
import { metricDeclarations as logsMetricsDeclarations } from '@well-known-components/logger'
import { queueMetrics } from './adapters/task-queue'
import { getDefaultHttpMetrics } from '@dcl/http-server'

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
    help: 'Gauge of running conversions',
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
    help: 'Counter of asset cache probes served from the process-local hit-cache (skipping S3 HEAD)',
    type: IMetricsComponent.CounterType,
    labelNames: ['build_target', 'ab_version']
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
  }
}

// type assertions
validateMetricsDeclaration(metricDeclarations)

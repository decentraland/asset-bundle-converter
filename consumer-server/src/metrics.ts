import { IMetricsComponent } from "@well-known-components/interfaces"
import { getDefaultHttpMetrics, validateMetricsDeclaration } from "@well-known-components/metrics"
import { metricDeclarations as logsMetricsDeclarations } from "@well-known-components/logger"
import { queueMetrics } from "./adapters/task-queue"

export const metricDeclarations = {
  ...getDefaultHttpMetrics(),
  ...logsMetricsDeclarations,
  ...queueMetrics,
  test_ping_counter: {
    help: "Count calls to ping",
    type: IMetricsComponent.CounterType,
    labelNames: ["pathname"],
  },
  ab_converter_exit_codes: {
    help: "Counter of exit codes of asset bundle conversions",
    type: IMetricsComponent.CounterType,
    labelNames: ["exit_code"],
  },
  ab_converter_empty_conversion: {
    help: "Counter of conversions with empty files",
    type: IMetricsComponent.CounterType,
    labelNames: ["ab_version"],
  },
  ab_converter_free_disk_space: {
    help: "Free bytes in disk",
    type: IMetricsComponent.GaugeType
  },
}

// type assertions
validateMetricsDeclaration(metricDeclarations)

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
  ab_conversor_exit_codes: {
    help: "Counter of exit codes of asset bundle conversions",
    type: IMetricsComponent.CounterType,
    labelNames: ["exit_code"],
  },
}

// type assertions
validateMetricsDeclaration(metricDeclarations)

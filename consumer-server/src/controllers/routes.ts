import { Router } from "@well-known-components/http-server"
import { GlobalContext } from "../types"
import { queueTaskHandler } from "./handlers/queue-conversion-handle"
import { statusHandler } from "./handlers/status-handler";

// We return the entire router because it will be easier to test than a whole server
export async function setupRouter(globalContext: GlobalContext): Promise<Router<GlobalContext>> {
  const router = new Router<GlobalContext>()

  router.get("/status", statusHandler)
  router.post("/queue-task", queueTaskHandler)

  return router
}

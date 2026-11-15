import { receiveBrowserReport } from "@/src/services/ops/browser-reports";
import { observedRoute } from "@/src/services/ops/http-telemetry";

export const POST = observedRoute("/api/telemetry/browser", receiveBrowserReport);

import handler from 'vinext/server/app-router-entry';
import { env } from 'cloudflare:workers';
import { handleOperations, isOperationsPath } from './lib/platform/admin';
import { observeOperations, pruneOperationsTelemetry } from './lib/platform/telemetry';

export default {
  async fetch(request: Request, bindings: Parameters<typeof handler.fetch>[1], context: ExecutionContext) {
    if (isOperationsPath(new URL(request.url).pathname)) return handleOperations(request);
    const response = await handler.fetch(request, bindings, context);
    return observeOperations(request, response, context);
  },
  async scheduled() {
    if (env.STUDIO_OPS_TELEMETRY === '1') await pruneOperationsTelemetry();
  },
};

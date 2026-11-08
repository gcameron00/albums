import { handle, type Env } from "./app.ts";
import { verifyAccess } from "./auth.ts";

export type { Env };

export default {
  fetch(request, env): Promise<Response> {
    return handle(request, env, { verify: verifyAccess, fetch: (input, init) => fetch(input, init), now: () => new Date() });
  },
} satisfies ExportedHandler<Env>;

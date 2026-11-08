import { handle, type Env } from "./app.ts";
import { verifyAccess } from "./auth.ts";
import { musicToken } from "./musicToken.ts";

export type { Env };

export default {
  fetch(request, env): Promise<Response> {
    return handle(request, env, {
      verify: verifyAccess,
      fetch: (input, init) => fetch(input, init),
      musicToken: (e) => musicToken(e),
      now: () => new Date(),
    });
  },
} satisfies ExportedHandler<Env>;

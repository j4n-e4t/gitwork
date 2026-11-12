import { DurableObject } from "cloudflare:workers";
import { initDb } from "./db.ts";
import { handleRequest } from "./server.ts";

// All state (SQLite, the board cache and in-flight fetches) lives in this one object, so requests are serialized
// and the data layer can stay synchronous. The frontend is served by Workers Assets and never reaches this code.
export class WorkView extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    initDb(ctx.storage);
  }

  fetch(req: Request) {
    return handleRequest(req);
  }
}

export default {
  fetch(req, env) {
    return env.WORK_VIEW.getByName("main").fetch(req);
  },
} satisfies ExportedHandler<Env>;

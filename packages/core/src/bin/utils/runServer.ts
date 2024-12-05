import type { ApiBuild } from "@/build/index.js";
import type { Common } from "@/common/common.js";
import type { Database } from "@/database/index.js";
import { createServer } from "@/server/index.js";

/**
 * Starts the server for the specified build.
 */
export async function runServer({
  common,
  build,
  database,
}: {
  common: Common;
  build: ApiBuild;
  database: Database;
}) {
  const { graphqlSchema } = build;

  const server = await createServer({
    app: build.app,
    routes: build.routes,
    common,
    graphqlSchema,
    database,
  });

  return async () => {
    await server.kill();
  };
}

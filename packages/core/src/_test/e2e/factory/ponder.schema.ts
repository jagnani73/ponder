import { onchainTable } from "../../../drizzle/index.js";

export const swapEvent = onchainTable("swap_event", (t) => ({
  id: t.text().primaryKey(),
  pair: t.hex().notNull(),
  from: t.hex().notNull(),
  to: t.hex().notNull(),
}));

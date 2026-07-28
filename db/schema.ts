import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const routeArchives = sqliteTable("route_archives", {
  id: text("id").primaryKey(),
  ownerId: text("owner_id").notNull(),
  kind: text("kind", { enum: ["auto", "manual"] }).notNull(),
  name: text("name").notNull(),
  payload: text("payload").notNull(),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});
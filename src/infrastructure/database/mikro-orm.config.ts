import { defineConfig } from "@mikro-orm/postgresql";
import { Migrator } from "@mikro-orm/migrations";

export default defineConfig({
  clientUrl: process.env.DATABASE_URL || "postgresql://wagering_user:wagering_password@localhost:5432/wagering_db",
  entities: ["./dist/infrastructure/database/entities", "./src/infrastructure/database/entities"],
  entitiesTs: ["./src/infrastructure/database/entities"],
  extensions: [Migrator],
  migrations: {
    path: "./dist/infrastructure/database/migrations",
    pathTs: "./src/infrastructure/database/migrations",
    transactional: true,
    allOrNothing: true,
    emit: "ts",
  },
  debug: process.env.NODE_ENV === "development",
  pool: {
    min: 2,
    max: 20,
  },
});

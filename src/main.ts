import "reflect-metadata";
import { MikroORM } from "@mikro-orm/core";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module";
import { logger } from "./infrastructure/observability/app-logger";
import { configureApp } from "./presentation/app-setup";

async function bootstrap() {
  const app = await NestFactory.create(AppModule, {
    logger: ["error", "warn", "log"],
  });

  configureApp(app);

  // Habilitar Graceful Shutdown (SIGINT, SIGTERM)
  app.enableShutdownHooks();

  // Executar migrations automaticamente na inicialização
  try {
    const orm = app.get(MikroORM);
    const migrator = orm.getMigrator();
    await migrator.up();
    logger.info("Migrations executadas com sucesso!");
  } catch (err) {
    logger.error(`Aviso/Erro ao executar migrations automáticas: ${(err as Error).message}`);
  }

  const port = process.env.PORT || 3000;
  await app.listen(port);
  logger.info(`Distributed Wagering Processor rodando na porta ${port}`);
}

bootstrap().catch((err) => {
  logger.error(`Falha crítica ao iniciar aplicação: ${(err as Error).message}`);
  process.exit(1);
});

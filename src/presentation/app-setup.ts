import { INestApplication, ValidationPipe } from "@nestjs/common";
import { DocumentBuilder, OpenAPIObject, SwaggerModule } from "@nestjs/swagger";

export function configureApp(app: INestApplication): OpenAPIObject {
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
    })
  );

  const config = new DocumentBuilder()
    .setTitle("Distributed Wagering Processor")
    .setDescription(
      "Event-driven wagering wallet and ledger processor with idempotency, outbox/inbox, and reconciliation"
    )
    .setVersion("1.0.0")
    .addApiKey(
      {
        type: "apiKey",
        name: "x-provider-id",
        in: "header",
        description: "Provider identity header (defaults to provider-a in demo/test mode)",
      },
      "x-provider-id"
    )
    .build();

  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup("docs", app, document);

  return document;
}

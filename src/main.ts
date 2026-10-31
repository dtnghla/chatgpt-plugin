import { createApp, type Logger } from "./app.js";
import { ConfigError, loadConfig } from "./config.js";
import { cachedWidgetLoader, readWidgetHtml } from "./widget.js";

const logger: Logger = {
  info: (message) => console.log(`${new Date().toISOString()} ${message}`),
  error: (message) => console.error(`${new Date().toISOString()} ERROR ${message}`),
};

async function main(): Promise<void> {
  const config = loadConfig();
  await readWidgetHtml();

  const { app, close } = createApp(config, { loadWidgetHtml: cachedWidgetLoader() }, logger);
  const server = app.listen(config.port, config.host, () => {
    logger.info(`pentaho-to-aws MCP server listening on http://${config.host}:${config.port}/mcp`);
  });

  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(`${signal} received, shutting down`);
    server.close(() => process.exit(0));
    server.closeIdleConnections();
    void close();
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((error: unknown) => {
  if (error instanceof ConfigError) {
    logger.error(error.message);
  } else {
    logger.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
  }
  process.exit(1);
});

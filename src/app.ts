import { hostHeaderValidation, originValidation } from "@modelcontextprotocol/express";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { createMcpHandler } from "@modelcontextprotocol/server";
import express, { type ErrorRequestHandler, type Express } from "express";
import type { Config } from "./config.js";
import { createServer, type ServerDeps } from "./server.js";

export const MCP_BODY_LIMIT = "256kb";

export interface Logger {
  info(message: string): void;
  error(message: string): void;
}

export interface AppHandle {
  app: Express;
  close(): Promise<void>;
}

const jsonRpcError = (code: number, message: string) => ({
  jsonrpc: "2.0" as const,
  error: { code, message },
  id: null,
});

const bodyErrorHandler: ErrorRequestHandler = (error, _req, res, next) => {
  const status = typeof error?.status === "number" ? error.status : undefined;
  if (status === undefined || status < 400 || status > 499) {
    next(error);
    return;
  }
  const code = status === 413 ? -32600 : -32700;
  res
    .status(status)
    .json(jsonRpcError(code, status === 413 ? "Request body too large." : "Invalid JSON."));
};

export function createApp(
  config: Config,
  deps: ServerDeps,
  logger: Logger = { info: () => {}, error: () => {} },
): AppHandle {
  const app = express();
  app.disable("x-powered-by");

  app.use((req, res, next) => {
    const startedAt = process.hrtime.bigint();
    res.on("finish", () => {
      const ms = Number(process.hrtime.bigint() - startedAt) / 1e6;
      logger.info(`${req.method} ${req.path} ${res.statusCode} ${ms.toFixed(1)}ms`);
    });
    next();
  });

  app.get("/healthz", (_req, res) => {
    res.set("Cache-Control", "no-store").json({ status: "ok" });
  });

  const { challengeToken } = config;
  if (challengeToken !== undefined) {
    app.get("/.well-known/openai-apps-challenge", (_req, res) => {
      res.type("text/plain").send(challengeToken);
    });
  }

  const handler = createMcpHandler(() => createServer(deps), {
    onerror: (error) => logger.error(`mcp: ${error.message}`),
  });
  const handleMcp = toNodeHandler(handler, {
    onerror: (error) => logger.error(`mcp transport: ${error.message}`),
  });

  app.all(
    "/mcp",
    hostHeaderValidation(config.allowedHosts),
    originValidation(config.allowedHosts),
    express.json({ limit: MCP_BODY_LIMIT }),
    (req, res) => {
      handleMcp(req, res, req.body).catch((error: unknown) => {
        logger.error(`mcp: ${error instanceof Error ? error.message : String(error)}`);
        if (!res.headersSent) res.status(500).json(jsonRpcError(-32603, "Internal server error."));
      });
    },
  );

  app.use(bodyErrorHandler);

  return { app, close: () => handler.close() };
}

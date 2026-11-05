import { hostHeaderValidation, originValidation } from "@modelcontextprotocol/express";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { createMcpHandler } from "@modelcontextprotocol/server";
import express, { type ErrorRequestHandler, type Express } from "express";
import { ArtifactService } from "./artifacts/store.js";
import type { Config } from "./config.js";
import { BundleQuota, type LicensingContext, licenseFromHeader } from "./licensing/entitlements.js";
import { LICENSE_HEADER } from "./licensing/license.js";
import { createServer, type ServerDeps } from "./server.js";

export const MCP_BODY_LIMIT = "256kb";

export interface Logger {
  info(message: string): void;
  error(message: string): void;
}

export interface AppDeps {
  loadWidgetHtml: () => Promise<string>;
  /** Optional injection point for tests; otherwise created from the config. */
  artifacts?: ArtifactService;
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
  deps: AppDeps,
  logger: Logger = { info: () => {}, error: () => {} },
): AppHandle {
  const artifacts = deps.artifacts ?? ArtifactService.fromConfig(config);
  const licensing: LicensingContext | undefined =
    config.licenseMode === "enforced" && config.licenseSigningSecret !== undefined
      ? {
          settings: {
            enforced: true,
            signingSecret: config.licenseSigningSecret,
            upgradeUrl: config.upgradeUrl,
            free: {
              maxFiles: config.freeMaxFiles,
              maxSteps: config.freeMaxSteps,
              dailyBundles: config.freeDailyBundles,
            },
          },
          quota: new BundleQuota(),
        }
      : undefined;
  const serverDeps: ServerDeps = {
    loadWidgetHtml: deps.loadWidgetHtml,
    artifacts,
    fileHostAllowlist: config.fileHostAllowlist,
    widgetDomain: config.widgetDomain,
    licensing,
  };
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

  app.get("/artifacts/:id/download", async (req, res) => {
    const expires = Number(req.query.expires);
    const signature = typeof req.query.signature === "string" ? req.query.signature : "";
    let download;
    try {
      download = await artifacts.download(req.params.id ?? "", expires, signature);
    } catch (error) {
      logger.error(
        `artifact download failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      res.status(500).json({ error: "Could not read the artifact." });
      return;
    }
    if (!download) {
      res.set("Cache-Control", "no-store").status(404).json({ error: "Artifact not found." });
      return;
    }
    res
      .set({
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename="${download.fileName.replace(/["\\]/g, "_")}"`,
        "Content-Length": String(download.data.byteLength),
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      })
      .send(Buffer.from(download.data));
  });

  const { challengeToken } = config;
  if (challengeToken !== undefined) {
    app.get("/.well-known/openai-apps-challenge", (_req, res) => {
      res.type("text/plain").send(challengeToken);
    });
  }

  const handler = createMcpHandler(
    (ctx) => {
      const headerLicense = licenseFromHeader(
        licensing?.settings,
        ctx.requestInfo?.headers.get(LICENSE_HEADER) ?? undefined,
      );
      return createServer({ ...serverDeps, headerLicense });
    },
    { onerror: (error) => logger.error(`mcp: ${error.message}`) },
  );
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

  return {
    app,
    close: async () => {
      await Promise.all([handler.close(), artifacts.close()]);
    },
  };
}

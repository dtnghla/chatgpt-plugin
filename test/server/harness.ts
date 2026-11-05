import type { AddressInfo } from "node:net";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createApp, type Logger } from "../../src/app.js";
import type { ArtifactService } from "../../src/artifacts/store.js";
import type { Config } from "../../src/config.js";
import { cachedWidgetLoader, readWidgetHtml } from "../../src/widget.js";

export const STUB_WIDGET_HTML = "<!doctype html><html><body>stub</body></html>";

export interface RunningServer {
  origin: string;
  mcpUrl: URL;
  close(): Promise<void>;
}

export interface StartServerOptions {
  artifacts?: ArtifactService;
  logger?: Logger;
}

export async function widgetLoader(): Promise<() => Promise<string>> {
  try {
    await readWidgetHtml();
    return cachedWidgetLoader();
  } catch {
    return async () => STUB_WIDGET_HTML;
  }
}

export async function startServer(
  overrides: Partial<Config> = {},
  options: StartServerOptions = {},
): Promise<RunningServer> {
  const config: Config = {
    port: 0,
    host: "127.0.0.1",
    allowedHosts: ["localhost", "127.0.0.1", "[::1]"],
    challengeToken: undefined,
    fileHostAllowlist: ["localhost", "127.0.0.1"],
    widgetDomain: undefined,
    artifactStore: "memory",
    artifactBucket: undefined,
    awsRegion: "us-east-1",
    artifactSigningSecret: "test-artifact-signing-secret",
    publicBaseUrl: undefined,
    artifactTtlSeconds: 900,
    licenseMode: "off",
    licenseSigningSecret: undefined,
    upgradeUrl: undefined,
    freeMaxFiles: 5,
    freeMaxSteps: 75,
    freeDailyBundles: 3,
    ...overrides,
  };
  const { app, close } = createApp(
    config,
    { loadWidgetHtml: await widgetLoader(), artifacts: options.artifacts },
    options.logger,
  );
  const server = await new Promise<import("node:http").Server>((resolve) => {
    const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
  });
  const { port } = server.address() as AddressInfo;
  const origin = `http://127.0.0.1:${port}`;
  return {
    origin,
    mcpUrl: new URL(`${origin}/mcp`),
    close: async () => {
      await close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

export type Era = "legacy" | "modern";

export async function connectClient(url: URL, era: Era): Promise<Client> {
  const client =
    era === "modern"
      ? new Client(
          { name: "test-client", version: "0.0.0" },
          { versionNegotiation: { mode: { pin: "2026-07-28" } } },
        )
      : new Client({ name: "test-client", version: "0.0.0" });
  await client.connect(new StreamableHTTPClientTransport(url));
  return client;
}

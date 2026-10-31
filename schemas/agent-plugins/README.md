# Agent Plugins JSON Schemas (vendored)

Unmodified copies of the Agent Plugins 1.0.0 schemas, retrieved on 2026-10-02:

- `1.0.0/plugin.schema.json` from https://agent-plugins.org/schemas/1.0.0/plugin.schema.json
- `1.0.0/mcp.schema.json` from https://agent-plugins.org/schemas/1.0.0/mcp.schema.json

The specification (https://agent-plugins.org/specification) says clients must not fetch schemas
when loading a plugin, so `scripts/validate-plugin.ts` validates against these local copies.

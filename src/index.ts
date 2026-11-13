#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { PagosRD } from "@pagosrd/node";
import { createServer } from "./server.js";

const apiKey = process.env.PAGOSRD_API_KEY;
if (!apiKey) {
  console.error("Falta PAGOSRD_API_KEY (tu llave sk_test_… o sk_live_…).");
  process.exit(1);
}
const client = new PagosRD(apiKey, { baseUrl: process.env.PAGOSRD_API_URL });
const server = createServer(client);
await server.connect(new StdioServerTransport());
// stdout es del protocolo MCP: los mensajes para humanos van a stderr.
console.error(`PagosRD MCP listo (${client.testMode ? "modo de prueba" : "modo live"}).`);

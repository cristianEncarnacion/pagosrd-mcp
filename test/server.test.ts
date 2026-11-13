import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { PagosRD } from "@pagosrd/node";
import { describe, expect, it } from "vitest";
import { createServer } from "../src/server.js";

function setup(handler: (url: URL, init: RequestInit) => Response) {
  const calls: { url: URL; init: RequestInit }[] = [];
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    const u = new URL(String(url));
    calls.push({ url: u, init: init ?? {} });
    return handler(u, init ?? {});
  }) as typeof fetch;
  const server = createServer(new PagosRD("sk_test_abc", { baseUrl: "http://api.local", fetch: fetchImpl, maxRetries: 0 }));
  return { server, calls };
}

async function connect(server: ReturnType<typeof createServer>) {
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "prueba", version: "1.0.0" });
  await Promise.all([server.connect(a), client.connect(b)]);
  return client;
}

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const LINK = {
  id: "pl_1",
  object: "payment_link",
  livemode: false,
  url: "https://app.pagosrd.com/l/pl_1",
  merchant_id: "mer_1",
  amount: 450000,
  itbis: 0,
  currency: "DOP",
  description: "Cuota octubre",
  reference: "cuota-4b",
  customer: { name: "Ana Pérez", email: null, phone: null },
  locale: "es",
  success_url: null,
  status: "open",
  expires_at: null,
  paid_at: null,
  payment_id: null,
  metadata: {},
  created_at: "2026-10-24T15:00:00Z",
};

describe("servidor MCP", () => {
  it("expone las herramientas con anotaciones de seguridad", async () => {
    const { server } = setup(() => json(200, {}));
    const client = await connect(server);
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual([
      "cancelar_link",
      "consultar_link",
      "consultar_pago",
      "crear_link_de_cobro",
      "listar_comercios",
      "listar_links",
      "listar_pagos",
      "reembolsar_pago",
      "resumen_de_cobros",
    ]);
    expect(tools.find((t) => t.name === "reembolsar_pago")!.annotations?.destructiveHint).toBe(true);
    expect(tools.find((t) => t.name === "listar_pagos")!.annotations?.readOnlyHint).toBe(true);
  });

  it("crea un link convirtiendo pesos a centavos", async () => {
    const { server, calls } = setup(() => json(201, LINK));
    const client = await connect(server);
    const r = await client.callTool({ name: "crear_link_de_cobro", arguments: { comercio_id: "mer_1", monto: "4,500.00", concepto: "Cuota octubre", referencia: "cuota-4b", cliente_nombre: "Ana Pérez" } });
    expect(r.isError).toBeFalsy();
    const text = (r.content as { text: string }[])[0]!.text;
    expect(text).toContain("https://app.pagosrd.com/l/pl_1");
    expect(text).toContain("Modo de prueba");
    const body = JSON.parse(String(calls[0]!.init.body));
    expect(body).toMatchObject({ merchant_id: "mer_1", amount: 450000, description: "Cuota octubre", reference: "cuota-4b" });
  });

  it("devuelve errores de la API como resultado con isError", async () => {
    const { server } = setup(() => json(422, { code: "datos_invalidos", detail: "El comercio está deshabilitado.", field: "merchant_id" }));
    const client = await connect(server);
    const r = await client.callTool({ name: "crear_link_de_cobro", arguments: { comercio_id: "mer_1", monto: "100", concepto: "x" } });
    expect(r.isError).toBe(true);
    expect((r.content as { text: string }[])[0]!.text).toContain("El comercio está deshabilitado. (campo: merchant_id)");
  });

  it("rechaza montos con más de dos decimales sin llamar a la API", async () => {
    const { server, calls } = setup(() => json(201, LINK));
    const client = await connect(server);
    const r = await client.callTool({ name: "crear_link_de_cobro", arguments: { comercio_id: "mer_1", monto: "10.555", concepto: "x" } });
    expect(r.isError).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it("reembolsa un monto parcial", async () => {
    const { server, calls } = setup(() => json(201, { id: "re_1", object: "refund", status: "succeeded", amount: 100000, itbis: 0, failure_message: null }));
    const client = await connect(server);
    const r = await client.callTool({ name: "reembolsar_pago", arguments: { pago_id: "pay_1", monto: "1,000" } });
    expect((r.content as { text: string }[])[0]!.text).toContain("re_1: succeeded");
    expect(calls[0]!.url.pathname).toBe("/v1/payments/pay_1/refunds");
    expect(JSON.parse(String(calls[0]!.init.body))).toMatchObject({ amount: 100000 });
  });
});

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { formatMoney, PagosRD, PagosRDError, toCents, type Payment, type PaymentLink } from "@pagosrd/node";
import { z } from "zod";

/**
 * Servidor MCP de PagosRD. Permite a Claude (u otro cliente MCP) crear links de
 * cobro, consultar pagos y reembolsar usando la llave de API de la plataforma.
 *
 * Los montos se piden en PESOS ("4,500.00") porque es como habla la gente; el
 * servidor los convierte a centavos sin errores de redondeo.
 */

const pesos = z.string().describe('Monto en pesos dominicanos, por ejemplo "4,500.00" o "1500".');

function linkText(l: PaymentLink): string {
  return [
    `Link ${l.id} (${l.status})`,
    `Monto: ${formatMoney(l.amount, l.currency)}${l.itbis ? ` (ITBIS ${formatMoney(l.itbis, l.currency)})` : ""}`,
    `Concepto: ${l.description}`,
    l.reference ? `Referencia: ${l.reference}` : null,
    l.customer.name ? `Cliente: ${l.customer.name}` : null,
    `URL para pagar: ${l.url}`,
    l.expires_at ? `Vence: ${l.expires_at}` : null,
    l.livemode ? null : "Modo de prueba: no se cobra dinero real.",
  ]
    .filter(Boolean)
    .join("\n");
}

function paymentText(p: Payment): string {
  return [
    `Pago ${p.id}: ${p.status}${p.requires_review ? " (requiere revisión)" : ""}`,
    `Monto: ${formatMoney(p.amount, p.currency)}${p.amount_refunded ? `, reembolsado ${formatMoney(p.amount_refunded, p.currency)}` : ""}`,
    p.card ? `Tarjeta: ${p.card.brand ?? ""} terminada en ${p.card.last4}` : null,
    p.failure_message ? `Detalle: ${p.failure_message}` : null,
    p.paid_at ? `Pagado: ${p.paid_at}` : null,
    p.payment_link_id ? `Link: ${p.payment_link_id}` : null,
  ]
    .filter(Boolean)
    .join("\n");
}

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

async function run(fn: () => Promise<string>): Promise<ToolResult> {
  try {
    return { content: [{ type: "text", text: await fn() }] };
  } catch (err) {
    const message = err instanceof PagosRDError ? `${err.message}${err.field ? ` (campo: ${err.field})` : ""} [${err.code}]` : (err as Error).message;
    return { content: [{ type: "text", text: `Error: ${message}` }], isError: true };
  }
}

export function createServer(client: PagosRD): McpServer {
  const server = new McpServer({ name: "pagosrd", version: "0.1.1" });

  server.registerTool(
    "crear_link_de_cobro",
    {
      title: "Crear link de cobro",
      description:
        "Crea un link de cobro con tarjeta para un comercio y devuelve la URL para enviársela al cliente (por WhatsApp o correo). Si no sabes el comercio, usa primero listar_comercios.",
      inputSchema: {
        comercio_id: z.string().describe("Id del comercio (mer_…)."),
        monto: pesos.describe('Total a cobrar en pesos, ITBIS incluido. Ej: "4,500.00".'),
        itbis: pesos.optional().describe("Parte del monto que es ITBIS, en pesos. Omítelo si está exento."),
        concepto: z.string().min(1).max(140).describe('Qué se cobra. Ej: "Cuota de mantenimiento octubre, Apto 4B".'),
        referencia: z.string().max(100).optional().describe("Tu referencia interna (factura, cuota). Vuelve en los webhooks."),
        cliente_nombre: z.string().optional(),
        cliente_correo: z.string().optional(),
        cliente_telefono: z.string().optional(),
        idioma: z.enum(["es", "en"]).optional().describe("Idioma de la página de pago. Por defecto es."),
        vence_en_dias: z.number().int().min(1).max(90).optional().describe("Días hasta que vence el link. Por defecto 30."),
      },
      annotations: { destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (a) =>
      run(async () => {
        const link = await client.paymentLinks.create({
          merchant_id: a.comercio_id,
          amount: toCents(a.monto),
          itbis: a.itbis ? toCents(a.itbis) : undefined,
          description: a.concepto,
          reference: a.referencia,
          customer: { name: a.cliente_nombre, email: a.cliente_correo, phone: a.cliente_telefono },
          locale: a.idioma,
          expires_at: a.vence_en_dias ? new Date(Date.now() + a.vence_en_dias * 86_400_000).toISOString() : undefined,
        });
        return `Link de cobro creado.\n${linkText(link)}`;
      }),
  );

  server.registerTool(
    "consultar_link",
    { title: "Consultar link de cobro", description: "Muestra el estado de un link de cobro (abierto, pagado, vencido o cancelado).", inputSchema: { link_id: z.string() }, annotations: { readOnlyHint: true } },
    async (a) => run(async () => linkText(await client.paymentLinks.retrieve(a.link_id))),
  );

  server.registerTool(
    "listar_links",
    {
      title: "Listar links de cobro",
      description: "Lista links de cobro recientes. Puede filtrar por estado o por referencia.",
      inputSchema: {
        estado: z.enum(["open", "paid", "expired", "canceled"]).optional().describe("open = pendiente de pago."),
        referencia: z.string().optional(),
        cantidad: z.number().int().min(1).max(50).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    async (a) =>
      run(async () => {
        const list = await client.paymentLinks.list({ status: a.estado, reference: a.referencia, limit: a.cantidad ?? 10 });
        if (list.data.length === 0) return "No hay links que coincidan.";
        return list.data.map(linkText).join("\n\n") + (list.has_more ? "\n\nHay más resultados." : "");
      }),
  );

  server.registerTool(
    "cancelar_link",
    {
      title: "Cancelar link de cobro",
      description: "Cancela un link que aún no se ha pagado, para que ya no se pueda pagar. Confirma con el usuario antes de usarla.",
      inputSchema: { link_id: z.string() },
      annotations: { destructiveHint: true, idempotentHint: true },
    },
    async (a) => run(async () => `Link cancelado.\n${linkText(await client.paymentLinks.cancel(a.link_id))}`),
  );

  server.registerTool(
    "consultar_pago",
    { title: "Consultar pago", description: "Muestra el detalle de un pago: estado, monto, tarjeta y reembolsos.", inputSchema: { pago_id: z.string() }, annotations: { readOnlyHint: true } },
    async (a) => run(async () => paymentText(await client.payments.retrieve(a.pago_id))),
  );

  server.registerTool(
    "listar_pagos",
    {
      title: "Listar pagos",
      description: "Lista pagos recientes, con filtro opcional por estado.",
      inputSchema: {
        estado: z.enum(["pending", "processing", "succeeded", "failed", "canceled"]).optional().describe("succeeded = cobrado."),
        cantidad: z.number().int().min(1).max(50).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    async (a) =>
      run(async () => {
        const list = await client.payments.list({ status: a.estado, limit: a.cantidad ?? 10 });
        if (list.data.length === 0) return "No hay pagos que coincidan.";
        return list.data.map(paymentText).join("\n\n");
      }),
  );

  server.registerTool(
    "reembolsar_pago",
    {
      title: "Reembolsar pago",
      description:
        "Devuelve dinero de un pago cobrado al cliente, total o parcial. Mueve dinero real en modo live: confirma SIEMPRE con el usuario el pago y el monto antes de llamarla.",
      inputSchema: {
        pago_id: z.string(),
        monto: pesos.optional().describe("Monto a reembolsar en pesos. Omítelo para reembolsar todo lo disponible."),
        motivo: z.string().max(300).optional(),
      },
      annotations: { destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async (a) =>
      run(async () => {
        const r = await client.refunds.create(a.pago_id, { amount: a.monto ? toCents(a.monto) : undefined, reason: a.motivo });
        return `Reembolso ${r.id}: ${r.status}, ${formatMoney(r.amount)}${r.failure_message ? `. Detalle: ${r.failure_message}` : ""}`;
      }),
  );

  server.registerTool(
    "listar_comercios",
    { title: "Listar comercios", description: "Lista los comercios de la plataforma, con su procesador y estado.", inputSchema: {}, annotations: { readOnlyHint: true } },
    async () =>
      run(async () => {
        const list = await client.merchants.list({ limit: 100 });
        if (list.data.length === 0) return "No hay comercios.";
        return list.data.map((m) => `${m.id}: ${m.name} (${m.processor}, ${m.status}${m.processor_configured ? "" : ", sin credenciales"})`).join("\n");
      }),
  );

  server.registerTool(
    "resumen_de_cobros",
    {
      title: "Resumen de cobros",
      description: "Totales de los últimos días: cobrado, cantidad de pagos, reembolsado, fallidos y pagos en revisión.",
      inputSchema: { dias: z.number().int().min(1).max(365).optional().describe("Por defecto 30.") },
      annotations: { readOnlyHint: true },
    },
    async (a) =>
      run(async () => {
        const dias = a.dias ?? 30;
        const s = await client.summary({ from: new Date(Date.now() - dias * 86_400_000).toISOString() });
        return [
          `Últimos ${dias} días:`,
          `Cobrado: ${formatMoney(s.succeeded_amount)} en ${s.succeeded_count} ${s.succeeded_count === 1 ? "pago" : "pagos"}`,
          `Reembolsado: ${formatMoney(s.refunded_amount)}`,
          `Pagos fallidos: ${s.failed_count}`,
          s.review_count ? `Pagos que requieren revisión: ${s.review_count}` : null,
        ]
          .filter(Boolean)
          .join("\n");
      }),
  );

  return server;
}

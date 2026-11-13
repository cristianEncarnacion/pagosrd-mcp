# @pagosrd/mcp

Servidor MCP de PagosRD. Le permite a Claude (u otro cliente MCP) crear links de cobro, consultar pagos y reembolsar con la llave de API de tu plataforma.

## Configuración

```json
{
  "mcpServers": {
    "pagosrd": {
      "command": "npx",
      "args": ["-y", "@pagosrd/mcp"],
      "env": { "PAGOSRD_API_KEY": "sk_test_…" }
    }
  }
}
```

`PAGOSRD_API_URL` es opcional (por defecto `https://api.pagosrd.com`).

## Herramientas

| Herramienta | Qué hace |
|---|---|
| `crear_link_de_cobro` | Crea un link y devuelve la URL para el cliente. El monto se da en pesos ("4,500.00"). |
| `consultar_link`, `listar_links` | Estado de los links. |
| `cancelar_link` | Cancela un link sin pagar (destructiva). |
| `consultar_pago`, `listar_pagos` | Estado de los pagos. |
| `reembolsar_pago` | Reembolso total o parcial (destructiva: mueve dinero en live). |
| `listar_comercios` | Comercios de la plataforma. |
| `resumen_de_cobros` | Totales de los últimos días. |

Las herramientas destructivas están marcadas con `destructiveHint` para que el cliente pida confirmación.

Licencia MIT.

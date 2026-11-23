# PDfEr documentation

A document engine: a template plus JSON in, a PDF out. One container, no
database, no external services.

## Learning path

| # | Page | For |
|---|---|---|
| 1 | [What PDfEr is](01-what-is-pdfer.md) | everyone — five minutes |
| 2 | [Quick start](02-quick-start.md) | everyone — render a PDF in one command |
| 3 | [Concepts](03-concepts.md) | template authors and integrators |
| 4 | [Templates](04-templates.md) | whoever writes the HTML |
| 5 | [Schemas](05-schemas.md) | whoever defines the data contract |
| 6 | [API](06-api.md) | backend developers |
| 7 | [Building a template UI](07-building-a-template-ui.md) | product/UI teams |
| 8 | [Operations](08-operations.md) | whoever runs it |
| 9 | [Security](09-security.md) | security review, ops |
| 10 | [Troubleshooting](10-troubleshooting.md) | support, ops |
| 11 | [Expert notes](11-expert-notes.md) | determinism, provenance, performance |

Reference material lives at the repository root:

- [`schema/openapi.yaml`](../schema/openapi.yaml) — the HTTP contract
- [`SPEC-v1.1.md`](../SPEC-v1.1.md) — the normative specification
- [`examples/invoice`](../examples/invoice) — a working schema, template and payload

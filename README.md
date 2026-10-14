# FarmAssist Agent

> Talk to your farm ledger — every number verified, never guessed.

FarmAssist Agent is a voice-friendly farm ledger for small dairy and crop farmers in India. It is a **self-hosted MCP server** (Model Context Protocol, spec 2025-11-25, Streamable HTTP) that will run on AWS Lambda with DynamoDB and Amazon Bedrock.

**Status: early development (Phase 0).** Right now the server answers `initialize`, `tools/list` and `tools/call` for one placeholder tool (`health_check`). The farm tools, AWS deployment and web client are still to come. This README will grow as each part actually works.

## Run it locally

Requires Node.js 22 (22.19 or newer recommended, because MCP Inspector needs it).

```bash
npm ci
npm test                 # unit + protocol tests
npm run start:local      # serves http://127.0.0.1:3000/mcp
```

In a second terminal:

```bash
npm run smoke -- http://127.0.0.1:3000/mcp
```

See [docs/protocol-tests.md](docs/protocol-tests.md) for what the smoke test checks and recorded results.

## About Alexa+

This project targets the Alexa+ track of the *Build, Ship, Shape* hackathon. Amazon's Alexa+ add-on tools (CLI, MCP Toolkit, Web Simulator) are partner-only, so this project is **not** connected to a real Alexa+ device or console. It is shown through its own web-based MCP client instead. See [FRICTION.md](FRICTION.md).

## License

[MIT](LICENSE)

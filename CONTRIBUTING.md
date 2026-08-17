# Contributing

Contributions are welcome. Use macOS with Node.js 20 or newer and full Xcode for Simulator-specific tests.

```bash
npm install
npm run check
```

Keep changes production-safe: preserve redaction defaults, avoid shell command construction, authorize filesystem paths, bind control services to loopback unless the user explicitly requests LAN access, and never add Simulator-erasing or keychain-reset behavior. New MCP tools must be added to the central registry with an input schema, output schema, all four behavior annotations, structured errors, and focused tests. Public response changes must retain the `schema_version: "1.0"` envelope and compatibility aliases throughout the 1.x contract period.

When a change depends on Mockttp, the MCP TypeScript SDK, Xcode, or `simctl`, verify the current upstream documentation. Include tests for success, invalid input, sensitive-data handling, and cleanup. Run the full suite before submitting a pull request.

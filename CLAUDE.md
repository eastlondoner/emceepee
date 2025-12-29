# MCP Proxy Server

An MCP proxy server with static tools for managing dynamic backend MCP servers.

## Development Commands

```bash
# Install dependencies
bun install

# Type check (must pass before committing)
bun run typecheck

# Lint (must pass before committing)
bun run lint

# Run both checks
bun run check

# Fix auto-fixable lint issues
bun run lint:fix

# Build for production
bun run build

# Run in development
bun run dev

# Run built version
bun run start
```

## Code Quality Requirements

**Before making any changes, ensure:**

1. **TypeScript compiles without errors**: Run `bun run typecheck`
2. **ESLint passes**: Run `bun run lint`

**After making changes:**

1. Run `bun run check` to verify both TypeScript and ESLint pass
2. Fix any errors before considering the change complete

## TypeScript Configuration

This project uses strict TypeScript settings:

- `strict: true` - All strict type checking options enabled
- `noUnusedLocals: true` - Error on unused local variables
- `noUnusedParameters: true` - Error on unused function parameters
- `noImplicitReturns: true` - Error if not all code paths return a value
- `noUncheckedIndexedAccess: true` - Add undefined to indexed access results

## ESLint Configuration

Uses typescript-eslint with strict and stylistic rules:

- Explicit return types required on all functions
- Explicit accessibility modifiers required on class members
- Consistent type imports/exports enforced
- No floating promises
- Switch exhaustiveness checking

## Project Structure

```
mcp-proxy/
├── src/
│   ├── server.ts      # Main HTTP MCP server with static tools
│   ├── registry.ts    # Backend server connection manager
│   ├── client.ts      # HTTP MCP client for backend connections
│   └── types.ts       # Shared types
├── ad-hoc-tests/      # Throwaway test scripts (gitignored)
├── package.json
├── tsconfig.json
├── eslint.config.js
└── CLAUDE.md
```

## Ad-hoc Test Scripts

Place throwaway test scripts in the `ad-hoc-tests/` directory. This folder is gitignored.

**Naming convention**: Prefix files with the current date in `YYYY-MM-DD` format.

```bash
# Example
ad-hoc-tests/2025-12-29-test-client.ts

# Run with
bun run ad-hoc-tests/2025-12-29-test-client.ts
```

## Running the Server

```bash
# Default port 8080
bun run dev

# Custom port
PORT=9000 bun run dev

# With initial config
bun run dev -- --config ./servers.json
```

## Configuration File Format

```json
{
  "servers": [
    { "name": "minecraft", "url": "http://localhost:3001/mcp" },
    { "name": "other", "url": "http://localhost:4000/mcp" }
  ]
}
```

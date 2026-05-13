#!/usr/bin/env bash
set -euo pipefail

pnpm --parallel \
  --filter "@zeko/hive-gateway" \
  --filter "@zeko/contract-registry-api" \
  --filter "@zeko/mcp-worker" \
  --filter "@zeko/frontend" \
  dev

#!/usr/bin/env bash
set -euo pipefail

proto run moon -- run hive-gateway:dev contract-registry-api:dev mcp-worker:dev frontend:dev

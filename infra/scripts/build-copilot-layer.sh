#!/bin/bash
# Builds a Lambda layer containing @github/copilot-sdk for Node.js 24.
# Uses Docker (linux/amd64) to ensure any native binaries are Linux-compatible.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
OUTPUT_DIR="${1:-$SCRIPT_DIR/../layers}"
OUTPUT_FILE="$OUTPUT_DIR/copilot-sdk-layer.zip"

mkdir -p "$OUTPUT_DIR"

if [[ -f "$OUTPUT_FILE" ]]; then
  echo "✓ $OUTPUT_FILE already exists (delete to rebuild)"
  exit 0
fi

if ! command -v docker &>/dev/null; then
  echo "Error: Docker is required to build the Copilot SDK layer" >&2
  exit 1
fi

echo "Building Copilot SDK Lambda layer (Node.js 24, x86_64)..."

docker run --rm \
  -v "$OUTPUT_DIR:/output" \
  --platform linux/amd64 \
  node:24-slim \
  bash -c '
set -euo pipefail

apt-get update -qq >/dev/null 2>&1
apt-get install -y -qq zip >/dev/null 2>&1

# Lambda layer structure for Node.js:
#   nodejs/node_modules/ -> added to NODE_PATH automatically
mkdir -p /layer/nodejs
cd /layer/nodejs

npm init -y --silent >/dev/null 2>&1
npm install @github/copilot-sdk --silent 2>&1 | tail -1

# Remove unnecessary files to reduce layer size
find node_modules \( \
  -name "*.md" -o \
  -name "*.d.ts.map" -o \
  -name "CHANGELOG*" -o \
  -name "LICENSE*" -o \
  -name ".package-lock.json" \
\) -delete 2>/dev/null || true

rm -f package.json package-lock.json

cd /layer
zip -qr /output/copilot-sdk-layer.zip nodejs/
echo "Copilot SDK layer built successfully"
'

echo "✓ Copilot SDK layer saved to $OUTPUT_FILE ($(du -h "$OUTPUT_FILE" | cut -f1))"

#!/bin/bash
# Builds a Lambda layer containing git for Amazon Linux 2023 (nodejs24.x runtime).
# Requires Docker.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
OUTPUT_DIR="${1:-$SCRIPT_DIR/../layers}"
OUTPUT_FILE="$OUTPUT_DIR/git-layer.zip"

mkdir -p "$OUTPUT_DIR"

if [[ -f "$OUTPUT_FILE" ]]; then
  echo "✓ $OUTPUT_FILE already exists (delete to rebuild)"
  exit 0
fi

if ! command -v docker &>/dev/null; then
  echo "Error: Docker is required to build the git layer" >&2
  exit 1
fi

echo "Building git Lambda layer (Amazon Linux 2023, x86_64)..."

docker run --rm \
  -v "$OUTPUT_DIR:/output" \
  --platform linux/amd64 \
  public.ecr.aws/amazonlinux/amazonlinux:2023 \
  bash -c '
set -euo pipefail

yum install -y git zip >/dev/null 2>&1

# Lambda layer structure:
#   bin/     -> /opt/bin      (on PATH)
#   lib/     -> /opt/lib      (on LD_LIBRARY_PATH)
#   libexec/ -> /opt/libexec
mkdir -p /layer/bin /layer/lib /layer/libexec

# Copy git binary
cp /usr/bin/git /layer/bin/

# Copy git-core helpers (includes git-remote-https for HTTPS clones)
cp -r /usr/libexec/git-core /layer/libexec/git-core

# Collect shared libraries required by git and git-remote-https
collect_libs() {
  ldd "$1" 2>/dev/null | grep "=> /" | awk "{print \$3}" || true
}

for bin in /usr/bin/git /usr/libexec/git-core/git-remote-https; do
  if [[ -f "$bin" ]]; then
    for lib in $(collect_libs "$bin"); do
      cp -n "$lib" /layer/lib/ 2>/dev/null || true
    done
  fi
done

# Also pull libcurl transitive deps (TLS, compression, etc.)
for lib in $(collect_libs /usr/lib64/libcurl.so.4); do
  cp -n "$lib" /layer/lib/ 2>/dev/null || true
done

cd /layer
zip -qr /output/git-layer.zip .
echo "Git layer built successfully"
'

echo "✓ Git layer saved to $OUTPUT_FILE ($(du -h "$OUTPUT_FILE" | cut -f1))"

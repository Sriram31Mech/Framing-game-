#!/usr/bin/env bash
# share.sh — expose the dev server to the internet via ngrok.
# Usage: bash scripts/share.sh
# Requires: ngrok installed, `pnpm dev` already running in another terminal.

set -euo pipefail

ENV_FILE="$(dirname "$0")/../.env"
NGROK_API="http://localhost:4040/api/tunnels"

echo "▶  Starting ngrok tunnel on port 5173…"
# Kill any existing ngrok on this port.
pkill -f "ngrok.*5173" 2>/dev/null || true
sleep 0.5

# Start ngrok in the background.
ngrok http 5173 --log=stdout --log-level=warn > /tmp/bh-ngrok.log 2>&1 &
NGROK_PID=$!
echo "   ngrok PID: $NGROK_PID"

# Wait for the tunnel to be ready (up to 10 s).
echo "   Waiting for tunnel…"
for i in $(seq 1 20); do
  sleep 0.5
  URL=$(curl -s "$NGROK_API" 2>/dev/null \
    | grep -o '"public_url":"https://[^"]*"' \
    | head -1 \
    | sed 's/"public_url":"//;s/"//')
  if [[ -n "$URL" ]]; then break; fi
done

if [[ -z "$URL" ]]; then
  echo "✗  Could not get ngrok URL. Check /tmp/bh-ngrok.log"
  kill "$NGROK_PID" 2>/dev/null || true
  exit 1
fi

echo ""
echo "✅  Share this URL with your friend:"
echo ""
echo "    $URL"
echo ""

# Patch PUBLIC_CLIENT_URL in .env so the server allows CORS from the ngrok origin.
if grep -q "^PUBLIC_CLIENT_URL=" "$ENV_FILE"; then
  # macOS sed needs an empty string after -i
  sed -i '' "s|^PUBLIC_CLIENT_URL=.*|PUBLIC_CLIENT_URL=$URL|" "$ENV_FILE"
else
  echo "PUBLIC_CLIENT_URL=$URL" >> "$ENV_FILE"
fi

echo "   .env updated: PUBLIC_CLIENT_URL=$URL"
echo ""
echo "⚠️  Restart the dev server (Ctrl-C then pnpm dev) for the CORS change to take effect."
echo "   When done sharing, run:  pkill -f 'ngrok.*5173'"
echo "   And restore .env:        sed -i '' 's|^PUBLIC_CLIENT_URL=.*|PUBLIC_CLIENT_URL=http://localhost:5173|' .env"
echo ""

# Keep the script alive so Ctrl-C kills ngrok cleanly.
trap 'echo ""; echo "Stopping ngrok…"; kill "$NGROK_PID" 2>/dev/null; \
  sed -i "" "s|^PUBLIC_CLIENT_URL=.*|PUBLIC_CLIENT_URL=http://localhost:5173|" "$ENV_FILE"; \
  echo ".env restored."; exit 0' INT TERM

wait "$NGROK_PID"

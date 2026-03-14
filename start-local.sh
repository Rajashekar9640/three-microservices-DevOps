#!/usr/bin/env bash
# start-local.sh — install dependencies and run all services in background (local dev)
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PIDS=()

cleanup() {
  echo ""
  echo "Stopping all services..."
  for pid in "${PIDS[@]}"; do
    kill "$pid" 2>/dev/null || true
  done
  echo "All services stopped."
}
trap cleanup EXIT INT TERM

start_service() {
  local name="$1"
  local dir="$2"
  local port="$3"
  local env_vars="$4"

  echo "Installing deps: $name..."
  (cd "$SCRIPT_DIR/$dir" && npm install --silent)

  echo "Starting $name on port $port..."
  (cd "$SCRIPT_DIR/$dir" && eval "$env_vars node server.js" > "$SCRIPT_DIR/logs/$name.log" 2>&1) &
  PIDS+=($!)
}

mkdir -p "$SCRIPT_DIR/logs"

# Start services
start_service "event-bus"      "event-bus"      3004 "PORT=3004"
sleep 1
start_service "user-service"   "user-service"   3001 "PORT=3001 JWT_SECRET=dev-jwt-secret"
start_service "product-service" "product-service" 3002 "PORT=3002"
sleep 1
start_service "order-service"  "order-service"  3003 \
  "PORT=3003 USER_SERVICE_URL=http://localhost:3001 PRODUCT_SERVICE_URL=http://localhost:3002 EVENT_BUS_URL=http://localhost:3004"
sleep 1
start_service "api-gateway"    "api-gateway"    3000 \
  "PORT=3000 USER_SERVICE_URL=http://localhost:3001 PRODUCT_SERVICE_URL=http://localhost:3002 ORDER_SERVICE_URL=http://localhost:3003 EVENT_BUS_URL=http://localhost:3004"

echo ""
echo "============================================"
echo "  All services started!"
echo "  API Gateway:      http://localhost:3000"
echo "  User Service:     http://localhost:3001"
echo "  Product Service:  http://localhost:3002"
echo "  Order Service:    http://localhost:3003"
echo "  Event Bus:        http://localhost:3004"
echo ""
echo "  Logs: ./logs/<service>.log"
echo "  Press Ctrl+C to stop all services"
echo "============================================"
echo ""

# Wait for all background jobs
wait

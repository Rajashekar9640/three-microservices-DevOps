#!/usr/bin/env bash
# test.sh — end-to-end test: register → login → browse → order → verify events
set -euo pipefail

BASE="http://localhost:3000/api/v1"
GW="http://localhost:3000"
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m'

ok()   { echo -e "${GREEN}  ✓ $1${NC}"; }
fail() { echo -e "${RED}  ✗ $1${NC}"; exit 1; }
step() { echo -e "\n${YELLOW}▶ $1${NC}"; }

require_jq() {
  command -v jq >/dev/null 2>&1 || { echo "jq is required. Install with: apt install jq / brew install jq"; exit 1; }
}
require_jq

# ============================================================
step "Health check"
# ============================================================
HEALTH=$(curl -sf "$GW/health") || fail "Gateway health check failed — are services running? Run ./start-local.sh first"
echo "$HEALTH" | jq '{status, services: (.services | to_entries | map({(.key): .value.status}) | add)}'
ok "Gateway is reachable"

# ============================================================
step "Register user"
# ============================================================
REGISTER=$(curl -sf -X POST "$BASE/users/register" \
  -H "Content-Type: application/json" \
  -d '{"name":"Alice Smith","email":"alice@example.com","password":"secret123"}') \
  || {
    # User may already exist — that's fine
    echo "  (user may already exist, continuing with login)"
  }

ok "Register request sent"

# ============================================================
step "Login"
# ============================================================
LOGIN=$(curl -sf -X POST "$BASE/users/login" \
  -H "Content-Type: application/json" \
  -d '{"email":"alice@example.com","password":"secret123"}') \
  || fail "Login failed"

TOKEN=$(echo "$LOGIN" | jq -r '.token')
USER_ID=$(echo "$LOGIN" | jq -r '.user.id')
[[ -n "$TOKEN" && "$TOKEN" != "null" ]] || fail "No token in login response"
ok "Login successful — user: $USER_ID"

# ============================================================
step "Get profile"
# ============================================================
PROFILE=$(curl -sf "$BASE/users/profile" -H "Authorization: Bearer $TOKEN") \
  || fail "Profile fetch failed"
echo "$PROFILE" | jq '.user | {id, name, email, role}'
ok "Profile retrieved"

# ============================================================
step "Browse products (no auth required)"
# ============================================================
PRODUCTS=$(curl -sf "$BASE/products") || fail "Products list failed"
PRODUCT_COUNT=$(echo "$PRODUCTS" | jq '.total')
ok "Products listed — total: $PRODUCT_COUNT"

# ============================================================
step "Browse by category: Electronics"
# ============================================================
ELECTRONICS=$(curl -sf "$BASE/products?category=Electronics") || fail "Category filter failed"
echo "$ELECTRONICS" | jq '[.products[] | {id, name, price}]'
ok "Electronics filter works"

# ============================================================
step "Search products"
# ============================================================
SEARCH=$(curl -sf "$BASE/products/search?q=laptop") || fail "Search failed"
echo "$SEARCH" | jq '{total, results: [.products[] | {name, price}]}'
ok "Search works"

# ============================================================
step "Get single product"
# ============================================================
PROD_ID=$(curl -sf "$BASE/products" | jq -r '.products[0].id')
PRODUCT=$(curl -sf "$BASE/products/$PROD_ID") || fail "Single product fetch failed"
PROD_NAME=$(echo "$PRODUCT" | jq -r '.product.name')
ok "Fetched product: $PROD_NAME"

# ============================================================
step "Subscribe to order events (event bus)"
# ============================================================
SUB=$(curl -sf -X POST "http://localhost:3004/subscribe" \
  -H "Content-Type: application/json" \
  -d '{"name":"test-monitor","callbackUrl":"http://localhost:9999/webhook","eventTypes":["order.created","order.status_updated"]}') \
  || fail "Subscribe failed"
SUB_ID=$(echo "$SUB" | jq -r '.subscriber.id')
ok "Subscribed to order events — id: $SUB_ID"

# ============================================================
step "Create order"
# ============================================================
# Get first two products
PROD1=$(curl -sf "$BASE/products" | jq -r '.products[0].id')
PROD2=$(curl -sf "$BASE/products" | jq -r '.products[1].id')

ORDER_PAYLOAD=$(cat <<EOF
{
  "items": [
    {"productId": "$PROD1", "quantity": 2},
    {"productId": "$PROD2", "quantity": 1}
  ],
  "shippingAddress": {
    "street": "123 Main St",
    "city": "San Francisco",
    "state": "CA",
    "zip": "94105",
    "country": "US"
  }
}
EOF
)

ORDER=$(curl -sf -X POST "$BASE/orders" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d "$ORDER_PAYLOAD") || fail "Order creation failed"

ORDER_ID=$(echo "$ORDER" | jq -r '.order.id')
ORDER_TOTAL=$(echo "$ORDER" | jq -r '.order.total')
echo "$ORDER" | jq '.order | {id, status, total, items: [.items[] | {productName, quantity, lineTotal}]}'
ok "Order created — id: $ORDER_ID  total: \$$ORDER_TOTAL"

# ============================================================
step "Get user orders"
# ============================================================
ORDERS=$(curl -sf "$BASE/orders/user/$USER_ID" -H "Authorization: Bearer $TOKEN") \
  || fail "Get orders failed"
ORDER_COUNT=$(echo "$ORDERS" | jq '.count')
ok "User has $ORDER_COUNT order(s)"

# ============================================================
step "Verify event was published"
# ============================================================
sleep 1  # give event bus a moment to store the event
EVENTS=$(curl -sf "http://localhost:3004/events?type=order.created") \
  || fail "Events fetch failed"
EVENT_COUNT=$(echo "$EVENTS" | jq '.total')
echo "$EVENTS" | jq '[.events[] | {id: .id, type: .type, orderId: .payload.orderId, publishedAt: .publishedAt}]'
[[ "$EVENT_COUNT" -ge 1 ]] || fail "No order.created events found"
ok "Event bus recorded $EVENT_COUNT order.created event(s)"

# ============================================================
step "Test circuit breaker info via health"
# ============================================================
HEALTH2=$(curl -sf "$GW/health") || fail "Health check failed"
echo "$HEALTH2" | jq '[.circuitBreakers[] | {name, state, failureCount}]'
ok "Circuit breaker states reported"

# ============================================================
step "Test auth protection — request without token"
# ============================================================
HTTP_STATUS=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/orders" \
  -H "Content-Type: application/json" \
  -d '{"items":[]}')
[[ "$HTTP_STATUS" == "401" ]] || fail "Expected 401, got $HTTP_STATUS"
ok "Unauthenticated requests correctly rejected (401)"

# ============================================================
step "Test graceful handling of non-existent product"
# ============================================================
BAD_ORDER=$(curl -s -X POST "$BASE/orders" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"items":[{"productId":"does-not-exist","quantity":1}],"shippingAddress":{"street":"1st St","city":"NYC"}}')
STATUS=$(echo "$BAD_ORDER" | jq -r '.error // empty')
[[ -n "$STATUS" ]] || fail "Expected error for non-existent product"
ok "Non-existent product handled gracefully: $STATUS"

# ============================================================
echo ""
echo -e "${GREEN}============================================"
echo "  All tests passed!"
echo -e "============================================${NC}"
echo ""
echo "Summary:"
echo "  User ID:   $USER_ID"
echo "  Order ID:  $ORDER_ID"
echo "  Order Total: \$$ORDER_TOTAL"
echo "  Events published: $EVENT_COUNT"

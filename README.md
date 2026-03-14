# Microservices E-Commerce Architecture

A production-oriented microservices architecture demonstrating key distributed systems patterns: service decomposition, event-driven communication, circuit breaking, API gateway pattern, and database-per-service.

## Architecture Diagram

```
                          ┌─────────────────────────────────────────────────┐
                          │                  Clients                         │
                          │          (Browser / Mobile / curl)               │
                          └────────────────────┬────────────────────────────┘
                                               │ HTTP
                          ┌────────────────────▼────────────────────────────┐
                          │              API Gateway  :3000                  │
                          │  ┌──────────┐  ┌──────────┐  ┌───────────────┐  │
                          │  │Rate Limit│  │  Auth    │  │Circuit Breaker│  │
                          │  └──────────┘  └──────────┘  └───────────────┘  │
                          │         Route /api/v1/{service}/*                │
                          └──────┬──────────┬────────────┬───────────────────┘
                                 │          │            │
              ┌──────────────────┘    ┌─────┘     ┌─────┘
              │                       │           │
  ┌───────────▼────────┐  ┌───────────▼──────┐  ┌─▼──────────────┐
  │  User Service :3001 │  │Product Svc :3002 │  │ Order Svc :3003│
  │  ┌───────────────┐  │  │  ┌────────────┐  │  │  ┌──────────┐  │
  │  │ JWT Auth      │  │  │  │ Catalog    │  │  │  │ Create   │  │
  │  │ Registration  │  │  │  │ Search     │  │  │  │ Track    │  │
  │  │ Login         │  │  │  │ Categories │  │  │  │ Status   │  │
  │  └───────────────┘  │  │  └────────────┘  │  │  └──────────┘  │
  │  [users.json]       │  │  [products.json]  │  │  [orders.json] │
  └─────────────────────┘  └──────────────────┘  └────────┬───────┘
                                                           │ publishes
                                              ┌────────────▼────────────┐
                                              │    Event Bus  :3004      │
                                              │  ┌─────────────────────┐ │
                                              │  │  Pub/Sub            │ │
                                              │  │  Webhook Delivery   │ │
                                              │  │  Event History      │ │
                                              │  └─────────────────────┘ │
                                              │  [events.json]           │
                                              │  [subscribers.json]      │
                                              └──────────────────────────┘
```

## Services

| Service | Port | Responsibility |
|---------|------|----------------|
| **API Gateway** | 3000 | Single entry point, routing, auth, rate limiting, circuit breaking |
| **User Service** | 3001 | Registration, login, JWT, profiles |
| **Product Service** | 3002 | Catalog, categories, search, stock management |
| **Order Service** | 3003 | Order creation, status tracking, inter-service coordination |
| **Event Bus** | 3004 | Pub/sub, webhook delivery, event history |

## Architecture Patterns

| Pattern | Where Used |
|---------|-----------|
| **API Gateway** | `api-gateway/` — single entry point, cross-cutting concerns |
| **Circuit Breaker** | Gateway's `CircuitBreaker` class — CLOSED/OPEN/HALF_OPEN states |
| **Database per Service** | Each service has its own `data/*.json` — fully isolated stores |
| **Event-Driven** | Order service publishes `order.created` / `order.status_updated` to event bus |
| **Service Discovery** | Environment variables (`USER_SERVICE_URL`, etc.) — swappable for Consul/k8s DNS |
| **Health Monitoring** | `GET /health` on every service + aggregated gateway health |
| **Request Tracing** | `X-Request-ID` header propagated through all hops |
| **Idempotent Subscribers** | Event bus deduplicates subscribers by name+callbackUrl |

## API Reference

All routes go through the gateway at `http://localhost:3000/api/v1/`.

### Users
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `POST` | `/users/register` | No | Register new user |
| `POST` | `/users/login` | No | Login, returns JWT |
| `GET` | `/users/profile` | Yes | Current user profile |

### Products
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/products` | No | List products (filter: `?category=&search=&minPrice=&maxPrice=&inStock=true&page=1&limit=20`) |
| `GET` | `/products/categories` | No | List all categories |
| `GET` | `/products/search?q=` | No | Search by keyword |
| `GET` | `/products/:id` | No | Single product |
| `POST` | `/products` | Yes | Create product |
| `PUT` | `/products/:id` | Yes | Update product |
| `DELETE` | `/products/:id` | Yes | Delete product |

### Orders
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `POST` | `/orders` | Yes | Create order |
| `GET` | `/orders/user/:userId` | Yes | Get user's orders |
| `GET` | `/orders/:orderId` | Yes | Get single order |
| `PATCH` | `/orders/:orderId/status` | Yes | Update order status |

### Events (direct or via gateway)
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `POST` | `/events/subscribe` | Yes | Register webhook subscriber |
| `DELETE` | `/events/subscribers/:id` | Yes | Unsubscribe |
| `GET` | `/events/subscribers` | Yes | List subscribers |
| `POST` | `/events/publish` | Yes | Publish an event |
| `GET` | `/events/events` | Yes | Event history |

### Gateway
| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/health` | Aggregated health + circuit breaker states |

## Quick Start

### Option 1: Local (Node.js required)

```bash
# Install dependencies and start all services
chmod +x start-local.sh
./start-local.sh

# In another terminal, run the test suite
chmod +x test.sh
./test.sh
```

Logs are written to `./logs/<service>.log`.

### Option 2: Docker Compose

```bash
docker-compose up --build

# In another terminal:
./test.sh
```

## Example Requests

```bash
# Register
curl -X POST http://localhost:3000/api/v1/users/register \
  -H "Content-Type: application/json" \
  -d '{"name":"Jane Doe","email":"jane@example.com","password":"pass123"}'

# Login
TOKEN=$(curl -s -X POST http://localhost:3000/api/v1/users/login \
  -H "Content-Type: application/json" \
  -d '{"email":"jane@example.com","password":"pass123"}' | jq -r '.token')

# Browse products
curl http://localhost:3000/api/v1/products?category=Electronics

# Create order
curl -X POST http://localhost:3000/api/v1/orders \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "items": [{"productId":"prod-001","quantity":1}],
    "shippingAddress": {"street":"1 Main St","city":"SF","state":"CA","zip":"94102","country":"US"}
  }'

# View events
curl http://localhost:3004/events?type=order.created
```

## Technology Choices

| Technology | Reason |
|------------|--------|
| **Node.js + Express** | Lightweight, fast to stand up, excellent for I/O-bound microservices |
| **Axios** | Promise-based HTTP client for service-to-service calls |
| **JSON Web Tokens** | Stateless auth — no shared session storage required between services |
| **bcryptjs** | Industry-standard password hashing |
| **JSON file storage** | Eliminates external database dependency for demo; easily swapped for Postgres/MongoDB |
| **Docker + Compose** | Reproducible environments, network isolation, volume-based data persistence |
| **Express Rate Limit** | Zero-dependency rate limiting for the gateway tier |

## Data Persistence

Each service writes to its own JSON file:

```
user-service/data/users.json
product-service/data/products.json    ← seeded with 10 sample products
order-service/data/orders.json
event-bus/data/events.json
event-bus/data/subscribers.json
```

When running via Docker Compose, named volumes ensure data survives container restarts.

## Screenshot Description

When running, you'll see:
- **Five terminal windows** (or log files) — one per service — each showing timestamped request logs
- **API Gateway health** at `GET /health` returns a JSON tree with each service's status and circuit breaker states
- **Product listing** returns 10 seeded products across 4 categories (Electronics, Furniture, Sports, Kitchen)
- **Order creation** triggers a cascade: user validation → product validation → stock deduction → order save → event publish
- **Event bus** shows `order.created` event with full order payload and attempted webhook deliveries

## Project Structure

```
.
├── docker-compose.yml
├── start-local.sh          ← run all services locally
├── test.sh                 ← end-to-end test suite
├── api-gateway/
│   ├── Dockerfile
│   ├── package.json
│   └── server.js           ← circuit breaker, rate limiter, proxy router
├── user-service/
│   ├── Dockerfile
│   ├── package.json
│   ├── server.js
│   └── data/users.json     ← auto-created on first run
├── product-service/
│   ├── Dockerfile
│   ├── package.json
│   ├── server.js
│   └── data/products.json  ← 10 sample products
├── order-service/
│   ├── Dockerfile
│   ├── package.json
│   ├── server.js
│   └── data/orders.json    ← auto-created on first run
└── event-bus/
    ├── Dockerfile
    ├── package.json
    ├── server.js
    └── data/
        ├── events.json
        └── subscribers.json
```

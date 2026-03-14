require('dotenv').config();
const express = require('express');
const axios = require('axios');
const rateLimit = require('express-rate-limit');
const morgan = require('morgan');

const app = express();
const PORT = process.env.PORT || 3000;

// ============================================================
// Service Registry (via environment variables)
// ============================================================
const SERVICES = {
  users:    process.env.USER_SERVICE_URL    || 'http://localhost:3001',
  products: process.env.PRODUCT_SERVICE_URL || 'http://localhost:3002',
  orders:   process.env.ORDER_SERVICE_URL   || 'http://localhost:3003',
  events:   process.env.EVENT_BUS_URL       || 'http://localhost:3004',
};

// ============================================================
// Circuit Breaker Implementation
// ============================================================
class CircuitBreaker {
  constructor(name, options = {}) {
    this.name             = name;
    this.state            = 'CLOSED';   // CLOSED | OPEN | HALF_OPEN
    this.failureCount     = 0;
    this.successCount     = 0;
    this.failureThreshold = options.failureThreshold || 5;
    this.successThreshold = options.successThreshold || 2;
    this.resetTimeout     = options.resetTimeout     || 30000; // ms
    this.lastFailureTime  = null;
    this.nextAttempt      = null;
  }

  async execute(fn) {
    if (this.state === 'OPEN') {
      if (Date.now() < this.nextAttempt) {
        const err = new Error(`[Circuit Open] ${this.name}: retry after ${new Date(this.nextAttempt).toISOString()}`);
        err.isCircuitOpen = true;
        throw err;
      }
      this.state = 'HALF_OPEN';
      console.log(`[CB] ${this.name}: OPEN -> HALF_OPEN`);
    }

    try {
      const result = await fn();
      this._onSuccess();
      return result;
    } catch (err) {
      if (!err.isCircuitOpen) this._onFailure();
      throw err;
    }
  }

  _onSuccess() {
    this.failureCount = 0;
    if (this.state === 'HALF_OPEN') {
      this.successCount++;
      if (this.successCount >= this.successThreshold) {
        this.state        = 'CLOSED';
        this.successCount = 0;
        console.log(`[CB] ${this.name}: HALF_OPEN -> CLOSED`);
      }
    }
  }

  _onFailure() {
    this.failureCount++;
    this.lastFailureTime = Date.now();
    if (this.state === 'HALF_OPEN' || this.failureCount >= this.failureThreshold) {
      this.state       = 'OPEN';
      this.nextAttempt = Date.now() + this.resetTimeout;
      this.successCount = 0;
      console.log(`[CB] ${this.name}: -> OPEN (failures: ${this.failureCount})`);
    }
  }

  getStatus() {
    return {
      name:            this.name,
      state:           this.state,
      failureCount:    this.failureCount,
      lastFailureTime: this.lastFailureTime ? new Date(this.lastFailureTime).toISOString() : null,
      nextAttempt:     this.nextAttempt     ? new Date(this.nextAttempt).toISOString()     : null,
    };
  }
}

const breakers = Object.fromEntries(
  Object.keys(SERVICES).map(name => [name, new CircuitBreaker(name)])
);

// ============================================================
// Middleware
// ============================================================
app.use(morgan('[:date[iso]] :method :url :status :response-time ms'));
app.use(express.json());

// CORS
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Origin, Content-Type, Accept, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// Request ID
app.use((req, res, next) => {
  req.requestId = `gw-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  res.setHeader('X-Request-ID', req.requestId);
  next();
});

// Rate limiting — global
const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later.' },
});
// Stricter limiter for auth endpoints
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  message: { error: 'Too many authentication attempts, please try again later.' },
});

app.use(globalLimiter);

// ============================================================
// Authentication Middleware
// ============================================================
const authenticate = async (req, res, next) => {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Authorization header missing or invalid.' });
  }
  const token = header.slice(7);

  try {
    const { data } = await breakers.users.execute(() =>
      axios.post(`${SERVICES.users}/verify-token`, { token }, { timeout: 5000 })
    );
    req.user = data.user;
    next();
  } catch (err) {
    if (err.isCircuitOpen) {
      return res.status(503).json({ error: 'Authentication service unavailable (circuit open).' });
    }
    if (err.response?.status === 401) {
      return res.status(401).json({ error: 'Invalid or expired token.' });
    }
    console.error('[Auth]', err.message);
    return res.status(503).json({ error: 'Authentication service unavailable.' });
  }
};

// Allow auth for specific paths, skip for others
const conditionalAuth = (skipWhen) => (req, res, next) => {
  if (skipWhen(req)) return next();
  return authenticate(req, res, next);
};

// ============================================================
// Service Proxy
// ============================================================
const proxy = (serviceName, baseUrl) => async (req, res) => {
  const targetUrl = `${baseUrl}${req.url}`;
  console.log(`[Proxy] ${req.method} ${req.originalUrl} -> ${targetUrl}  [${req.requestId}]`);

  try {
    const response = await breakers[serviceName].execute(() =>
      axios({
        method:  req.method,
        url:     targetUrl,
        data:    ['GET', 'DELETE', 'HEAD'].includes(req.method) ? undefined : req.body,
        headers: {
          'Content-Type':   'application/json',
          'X-Request-ID':   req.requestId,
          'X-User-ID':      req.user?.id    || '',
          'X-User-Email':   req.user?.email || '',
          'X-User-Role':    req.user?.role  || '',
        },
        timeout: 10000,
        validateStatus: () => true,   // let us forward all status codes
      })
    );
    res.status(response.status).json(response.data);
  } catch (err) {
    if (err.isCircuitOpen) {
      return res.status(503).json({
        error: `Service '${serviceName}' temporarily unavailable (circuit open).`,
        requestId: req.requestId,
      });
    }
    if (err.response) {
      return res.status(err.response.status).json({ ...err.response.data, requestId: req.requestId });
    }
    console.error(`[Proxy:${serviceName}]`, err.message);
    res.status(503).json({ error: `Service '${serviceName}' is unreachable.`, requestId: req.requestId });
  }
};

// ============================================================
// Routes
// ============================================================

// Health check — aggregates all downstream services
app.get('/health', async (req, res) => {
  const checks = await Promise.allSettled(
    Object.entries(SERVICES).map(async ([name, url]) => {
      const t0 = Date.now();
      try {
        const r = await axios.get(`${url}/health`, { timeout: 3000 });
        return { name, status: 'healthy', latencyMs: Date.now() - t0, info: r.data };
      } catch (e) {
        return { name, status: 'unhealthy', latencyMs: Date.now() - t0, error: e.message };
      }
    })
  );

  const services = {};
  checks.forEach(c => {
    const v = c.value;
    services[v.name] = { status: v.status, latencyMs: v.latencyMs, ...(v.error && { error: v.error }) };
  });

  const degraded = Object.values(services).some(s => s.status !== 'healthy');
  res.status(degraded ? 207 : 200).json({
    status:          degraded ? 'degraded' : 'healthy',
    gateway:         'healthy',
    version:         '1.0.0',
    services,
    circuitBreakers: Object.values(breakers).map(b => b.getStatus()),
    timestamp:       new Date().toISOString(),
  });
});

// User routes — /register and /login are public
app.use('/api/v1/users',
  authLimiter,
  conditionalAuth(req => req.url === '/register' || req.url === '/login' || req.url === '/verify-token'),
  proxy('users', SERVICES.users)
);

// Product routes — GET is public, mutations require auth
app.use('/api/v1/products',
  conditionalAuth(req => req.method === 'GET'),
  proxy('products', SERVICES.products)
);

// Order routes — always authenticated
app.use('/api/v1/orders', authenticate, proxy('orders', SERVICES.orders));

// Event routes — always authenticated
app.use('/api/v1/events', authenticate, proxy('events', SERVICES.events));

// 404
app.use('*', (req, res) => {
  res.status(404).json({ error: 'Route not found.', path: req.originalUrl });
});

// Error handler
app.use((err, req, res, next) => {
  console.error('[Gateway] Unhandled error:', err);
  res.status(500).json({ error: 'Internal gateway error.' });
});

app.listen(PORT, () => {
  console.log(`\nAPI Gateway  →  port ${PORT}`);
  console.log('Service registry:');
  Object.entries(SERVICES).forEach(([k, v]) => console.log(`  ${k.padEnd(10)} ${v}`));
  console.log('');
});

module.exports = app;

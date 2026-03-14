require('dotenv').config();
const express  = require('express');
const axios    = require('axios');
const { v4: uuidv4 } = require('uuid');
const fs   = require('fs');
const path = require('path');

const app  = express();
const PORT = process.env.PORT || 3003;

// Internal service URLs (direct, NOT through the gateway)
const USER_SERVICE_URL    = process.env.USER_SERVICE_URL    || 'http://localhost:3001';
const PRODUCT_SERVICE_URL = process.env.PRODUCT_SERVICE_URL || 'http://localhost:3002';
const EVENT_BUS_URL       = process.env.EVENT_BUS_URL       || 'http://localhost:3004';

const DATA_DIR  = path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'orders.json');

app.use(express.json());

// ============================================================
// Persistence
// ============================================================
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const loadOrders = () => {
  if (!fs.existsSync(DATA_FILE)) return [];
  try { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); }
  catch { return []; }
};

const saveOrders = () => {
  fs.writeFileSync(DATA_FILE, JSON.stringify(orders, null, 2));
};

let orders = loadOrders();

// ============================================================
// Logging
// ============================================================
app.use((req, res, next) => {
  const t = Date.now();
  res.on('finish', () =>
    console.log(`[order-svc] ${req.method} ${req.path} ${res.statusCode} ${Date.now() - t}ms`)
  );
  next();
});

// ============================================================
// Helpers
// ============================================================
const publishEvent = async (type, payload) => {
  try {
    await axios.post(`${EVENT_BUS_URL}/publish`, { type, payload }, { timeout: 3000 });
    console.log(`[order-svc] Event published: ${type}`);
  } catch (err) {
    // Event bus failure is non-blocking — log but don't fail the order
    console.error(`[order-svc] Failed to publish event ${type}:`, err.message);
  }
};

// ============================================================
// Order status machine
// ============================================================
const ORDER_STATUSES = ['pending', 'confirmed', 'processing', 'shipped', 'delivered', 'cancelled'];

// ============================================================
// Routes
// ============================================================
app.get('/health', (req, res) => {
  res.json({ status: 'healthy', service: 'order-service', orderCount: orders.length, timestamp: new Date().toISOString() });
});

// POST /  — create order
app.post('/', async (req, res) => {
  const userId = req.headers['x-user-id'];
  const { items, shippingAddress } = req.body;

  // Validate request
  if (!userId) return res.status(401).json({ error: 'User ID not provided.' });
  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'Order must contain at least one item.' });
  }
  for (const item of items) {
    if (!item.productId) return res.status(400).json({ error: 'Each item must have a productId.' });
    if (!item.quantity || item.quantity < 1) return res.status(400).json({ error: 'Each item must have a positive quantity.' });
  }
  if (!shippingAddress || !shippingAddress.street || !shippingAddress.city) {
    return res.status(400).json({ error: 'Shipping address (street, city) is required.' });
  }

  // Verify user exists (service-to-service call)
  try {
    await axios.get(`${USER_SERVICE_URL}/users/${userId}`, { timeout: 5000 });
  } catch (err) {
    if (err.response?.status === 404) return res.status(404).json({ error: 'User not found.' });
    return res.status(503).json({ error: 'User service unavailable.' });
  }

  // Validate products and calculate total
  const resolvedItems = [];
  let total = 0;

  for (const item of items) {
    let product;
    try {
      const { data } = await axios.get(`${PRODUCT_SERVICE_URL}/${item.productId}`, { timeout: 5000 });
      product = data.product;
    } catch (err) {
      if (err.response?.status === 404) {
        return res.status(404).json({ error: `Product ${item.productId} not found.` });
      }
      return res.status(503).json({ error: 'Product service unavailable.' });
    }

    if (product.stock < item.quantity) {
      return res.status(409).json({
        error: `Insufficient stock for "${product.name}".`,
        available: product.stock,
        requested: item.quantity,
      });
    }

    const lineTotal = product.price * item.quantity;
    resolvedItems.push({
      productId:   product.id,
      productName: product.name,
      price:       product.price,
      quantity:    item.quantity,
      lineTotal:   Math.round(lineTotal * 100) / 100,
    });
    total += lineTotal;
  }

  // Deduct stock (fire-and-forget style, but we do handle errors)
  for (const item of resolvedItems) {
    try {
      await axios.patch(
        `${PRODUCT_SERVICE_URL}/${item.productId}/stock`,
        { delta: -item.quantity },
        { timeout: 5000 }
      );
    } catch (err) {
      console.error(`[order-svc] Failed to deduct stock for ${item.productId}:`, err.message);
      // In production: implement saga/compensating transactions
    }
  }

  // Build order
  const order = {
    id:              uuidv4(),
    userId,
    items:           resolvedItems,
    total:           Math.round(total * 100) / 100,
    status:          'pending',
    shippingAddress,
    createdAt:       new Date().toISOString(),
    updatedAt:       new Date().toISOString(),
    statusHistory:   [{ status: 'pending', timestamp: new Date().toISOString() }],
  };

  orders.push(order);
  saveOrders();

  // Publish order.created event (non-blocking)
  await publishEvent('order.created', {
    orderId:  order.id,
    userId:   order.userId,
    items:    order.items,
    total:    order.total,
    status:   order.status,
    createdAt: order.createdAt,
  });

  console.log(`[order-svc] Order created: ${order.id} for user ${userId}  total: $${order.total}`);
  res.status(201).json({ message: 'Order created.', order });
});

// GET /user/:userId  — orders for a specific user
app.get('/user/:userId', (req, res) => {
  const userId = req.params.userId;
  const callerUserId = req.headers['x-user-id'];

  // Users can only see their own orders (gateway enforces auth)
  if (callerUserId && callerUserId !== userId) {
    return res.status(403).json({ error: 'Access denied.' });
  }

  const userOrders = orders
    .filter(o => o.userId === userId)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

  res.json({ orders: userOrders, count: userOrders.length });
});

// GET /:orderId  — single order
app.get('/:orderId', (req, res) => {
  const order = orders.find(o => o.id === req.params.orderId);
  if (!order) return res.status(404).json({ error: 'Order not found.' });

  const callerUserId = req.headers['x-user-id'];
  if (callerUserId && order.userId !== callerUserId) {
    return res.status(403).json({ error: 'Access denied.' });
  }
  res.json({ order });
});

// PATCH /:orderId/status  — update status
app.patch('/:orderId/status', (req, res) => {
  const { status } = req.body;
  if (!ORDER_STATUSES.includes(status)) {
    return res.status(400).json({ error: `Invalid status. Valid values: ${ORDER_STATUSES.join(', ')}` });
  }

  const idx = orders.findIndex(o => o.id === req.params.orderId);
  if (idx === -1) return res.status(404).json({ error: 'Order not found.' });

  orders[idx].status = status;
  orders[idx].updatedAt = new Date().toISOString();
  orders[idx].statusHistory.push({ status, timestamp: new Date().toISOString() });
  saveOrders();

  publishEvent('order.status_updated', { orderId: orders[idx].id, status, updatedAt: orders[idx].updatedAt });

  res.json({ message: 'Order status updated.', order: orders[idx] });
});

// ============================================================
// Error handler
// ============================================================
app.use((err, req, res, next) => {
  console.error('[order-svc] Error:', err);
  res.status(500).json({ error: 'Internal server error.' });
});

app.listen(PORT, () => console.log(`Order Service running on port ${PORT}  (${orders.length} existing orders)`));
module.exports = app;

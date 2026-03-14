require('dotenv').config();
const express  = require('express');
const { v4: uuidv4 } = require('uuid');
const fs   = require('fs');
const path = require('path');

const app  = express();
const PORT = process.env.PORT || 3002;
const DATA_DIR  = path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'products.json');
const SEED_FILE = path.join(__dirname, 'data', 'products.json');

app.use(express.json());

// ============================================================
// Persistence
// ============================================================
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const loadProducts = () => {
  if (fs.existsSync(DATA_FILE)) {
    try { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); }
    catch { /* fall through to seed */ }
  }
  // Use bundled seed file if present
  if (fs.existsSync(SEED_FILE)) {
    try { return JSON.parse(fs.readFileSync(SEED_FILE, 'utf8')); }
    catch { /* fall through */ }
  }
  return [];
};

const saveProducts = () => {
  fs.writeFileSync(DATA_FILE, JSON.stringify(products, null, 2));
};

let products = loadProducts();

// ============================================================
// Logging
// ============================================================
app.use((req, res, next) => {
  const t = Date.now();
  res.on('finish', () =>
    console.log(`[product-svc] ${req.method} ${req.path} ${res.statusCode} ${Date.now() - t}ms`)
  );
  next();
});

// ============================================================
// Helpers
// ============================================================
const applyFilters = (list, query) => {
  let result = [...list];

  if (query.category) {
    result = result.filter(p => p.category.toLowerCase() === query.category.toLowerCase());
  }
  if (query.search) {
    const term = query.search.toLowerCase();
    result = result.filter(p =>
      p.name.toLowerCase().includes(term) ||
      p.description.toLowerCase().includes(term) ||
      (p.tags || []).some(t => t.toLowerCase().includes(term))
    );
  }
  if (query.minPrice) {
    result = result.filter(p => p.price >= parseFloat(query.minPrice));
  }
  if (query.maxPrice) {
    result = result.filter(p => p.price <= parseFloat(query.maxPrice));
  }
  if (query.inStock === 'true') {
    result = result.filter(p => p.stock > 0);
  }

  // Sorting
  const sortBy = query.sortBy || 'createdAt';
  const order  = query.order  === 'asc' ? 1 : -1;
  result.sort((a, b) => {
    if (a[sortBy] < b[sortBy]) return -1 * order;
    if (a[sortBy] > b[sortBy]) return  1 * order;
    return 0;
  });

  // Pagination
  const page  = Math.max(1, parseInt(query.page  || '1'));
  const limit = Math.min(100, Math.max(1, parseInt(query.limit || '20')));
  const total = result.length;
  const start = (page - 1) * limit;
  result = result.slice(start, start + limit);

  return { products: result, total, page, limit, pages: Math.ceil(total / limit) };
};

// ============================================================
// Routes
// ============================================================
app.get('/health', (req, res) => {
  res.json({ status: 'healthy', service: 'product-service', productCount: products.length, timestamp: new Date().toISOString() });
});

// GET /  — list/filter/search products
app.get('/', (req, res) => {
  const result = applyFilters(products, req.query);
  res.json(result);
});

// GET /categories  — distinct category list
app.get('/categories', (req, res) => {
  const categories = [...new Set(products.map(p => p.category))].sort();
  res.json({ categories, count: categories.length });
});

// GET /search  — convenience search alias
app.get('/search', (req, res) => {
  if (!req.query.q) return res.status(400).json({ error: 'Query parameter ?q= is required.' });
  const result = applyFilters(products, { ...req.query, search: req.query.q });
  res.json(result);
});

// GET /:id  — single product
app.get('/:id', (req, res) => {
  const product = products.find(p => p.id === req.params.id);
  if (!product) return res.status(404).json({ error: 'Product not found.' });
  res.json({ product });
});

// POST /  — create product (requires auth via gateway, role check optional)
app.post('/', (req, res) => {
  const { name, description, price, category, stock, tags } = req.body;

  if (!name || !name.trim())     return res.status(400).json({ error: 'Product name is required.' });
  if (!description)              return res.status(400).json({ error: 'Description is required.' });
  if (typeof price !== 'number' || price <= 0) return res.status(400).json({ error: 'Valid price is required.' });
  if (!category)                 return res.status(400).json({ error: 'Category is required.' });

  const product = {
    id:          uuidv4(),
    name:        name.trim(),
    description,
    price:       Math.round(price * 100) / 100,
    category,
    stock:       typeof stock === 'number' ? stock : 0,
    tags:        Array.isArray(tags) ? tags : [],
    createdAt:   new Date().toISOString(),
    updatedAt:   new Date().toISOString(),
  };

  products.push(product);
  saveProducts();
  res.status(201).json({ message: 'Product created.', product });
});

// PUT /:id  — update product
app.put('/:id', (req, res) => {
  const idx = products.findIndex(p => p.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Product not found.' });

  const allowed = ['name', 'description', 'price', 'category', 'stock', 'tags'];
  const updates = Object.fromEntries(Object.entries(req.body).filter(([k]) => allowed.includes(k)));
  products[idx] = { ...products[idx], ...updates, updatedAt: new Date().toISOString() };
  saveProducts();
  res.json({ message: 'Product updated.', product: products[idx] });
});

// PATCH /:id/stock  — adjust stock (used internally by order-service)
app.patch('/:id/stock', (req, res) => {
  const { delta } = req.body;   // negative to reduce stock
  const idx = products.findIndex(p => p.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Product not found.' });

  const newStock = products[idx].stock + delta;
  if (newStock < 0) return res.status(409).json({ error: 'Insufficient stock.', available: products[idx].stock });

  products[idx].stock     = newStock;
  products[idx].updatedAt = new Date().toISOString();
  saveProducts();
  res.json({ message: 'Stock updated.', stock: newStock });
});

// DELETE /:id
app.delete('/:id', (req, res) => {
  const idx = products.findIndex(p => p.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Product not found.' });
  const [deleted] = products.splice(idx, 1);
  saveProducts();
  res.json({ message: 'Product deleted.', product: deleted });
});

// ============================================================
// Error handler
// ============================================================
app.use((err, req, res, next) => {
  console.error('[product-svc] Error:', err);
  res.status(500).json({ error: 'Internal server error.' });
});

app.listen(PORT, () => console.log(`Product Service running on port ${PORT}  (${products.length} products loaded)`));
module.exports = app;

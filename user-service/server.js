require('dotenv').config();
const express  = require('express');
const bcrypt   = require('bcryptjs');
const jwt      = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const fs   = require('fs');
const path = require('path');

const app  = express();
const PORT = process.env.PORT || 3001;
const JWT_SECRET = process.env.JWT_SECRET || 'super-secret-jwt-key-change-in-production';
const DATA_DIR  = path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'users.json');

app.use(express.json());

// ============================================================
// Persistence helpers
// ============================================================
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const loadUsers = () => {
  if (!fs.existsSync(DATA_FILE)) return [];
  try { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); }
  catch { return []; }
};

const saveUsers = (users) => {
  fs.writeFileSync(DATA_FILE, JSON.stringify(users, null, 2));
};

let users = loadUsers();

// ============================================================
// Logging
// ============================================================
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () =>
    console.log(`[user-svc] ${req.method} ${req.path} ${res.statusCode} ${Date.now() - start}ms`)
  );
  next();
});

// ============================================================
// Validation helpers
// ============================================================
const validateEmail = (email) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
const validatePassword = (pw) => pw && pw.length >= 6;

// ============================================================
// Routes
// ============================================================
app.get('/health', (req, res) => {
  res.json({ status: 'healthy', service: 'user-service', userCount: users.length, timestamp: new Date().toISOString() });
});

// POST /register
app.post('/register', async (req, res) => {
  const { name, email, password } = req.body;

  if (!name || !name.trim()) {
    return res.status(400).json({ error: 'Name is required.' });
  }
  if (!validateEmail(email)) {
    return res.status(400).json({ error: 'Valid email is required.' });
  }
  if (!validatePassword(password)) {
    return res.status(400).json({ error: 'Password must be at least 6 characters.' });
  }
  if (users.find(u => u.email === email.toLowerCase())) {
    return res.status(409).json({ error: 'An account with this email already exists.' });
  }

  const hash = await bcrypt.hash(password, 12);
  const user = {
    id:        uuidv4(),
    name:      name.trim(),
    email:     email.toLowerCase(),
    password:  hash,
    role:      'user',
    createdAt: new Date().toISOString(),
  };

  users.push(user);
  saveUsers(users);

  const { password: _, ...safe } = user;
  console.log(`[user-svc] Registered user: ${user.email}`);
  res.status(201).json({ message: 'User registered successfully.', user: safe });
});

// POST /login
app.post('/login', async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required.' });
  }

  const user = users.find(u => u.email === email.toLowerCase());
  if (!user) {
    return res.status(401).json({ error: 'Invalid credentials.' });
  }

  const match = await bcrypt.compare(password, user.password);
  if (!match) {
    return res.status(401).json({ error: 'Invalid credentials.' });
  }

  const token = jwt.sign(
    { id: user.id, email: user.email, role: user.role },
    JWT_SECRET,
    { expiresIn: '24h' }
  );

  const { password: _, ...safe } = user;
  console.log(`[user-svc] Login: ${user.email}`);
  res.json({ message: 'Login successful.', token, user: safe });
});

// GET /profile  (gateway injects X-User-ID header)
app.get('/profile', (req, res) => {
  const userId = req.headers['x-user-id'];
  if (!userId) return res.status(401).json({ error: 'User ID not provided.' });

  const user = users.find(u => u.id === userId);
  if (!user) return res.status(404).json({ error: 'User not found.' });

  const { password: _, ...safe } = user;
  res.json({ user: safe });
});

// GET /users/:id  (internal — called by order-service)
app.get('/users/:id', (req, res) => {
  const user = users.find(u => u.id === req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found.' });
  const { password: _, ...safe } = user;
  res.json({ user: safe });
});

// POST /verify-token  (internal — called by api-gateway)
app.post('/verify-token', (req, res) => {
  const { token } = req.body;
  if (!token) return res.status(401).json({ error: 'No token provided.' });
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    res.json({ valid: true, user: decoded });
  } catch {
    res.status(401).json({ error: 'Invalid or expired token.' });
  }
});

// ============================================================
// Error handler
// ============================================================
app.use((err, req, res, next) => {
  console.error('[user-svc] Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error.' });
});

app.listen(PORT, () => console.log(`User Service running on port ${PORT}`));
module.exports = app;

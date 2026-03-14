require('dotenv').config();
const express  = require('express');
const axios    = require('axios');
const { v4: uuidv4 } = require('uuid');
const fs   = require('fs');
const path = require('path');

const app  = express();
const PORT = process.env.PORT || 3004;

const DATA_DIR        = path.join(__dirname, 'data');
const EVENTS_FILE     = path.join(DATA_DIR, 'events.json');
const SUBSCRIBERS_FILE = path.join(DATA_DIR, 'subscribers.json');

app.use(express.json());

// ============================================================
// Persistence
// ============================================================
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const load = (file) => {
  if (!fs.existsSync(file)) return [];
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return []; }
};
const save = (file, data) => fs.writeFileSync(file, JSON.stringify(data, null, 2));

let events      = load(EVENTS_FILE);
let subscribers = load(SUBSCRIBERS_FILE);

// ============================================================
// Logging
// ============================================================
app.use((req, res, next) => {
  const t = Date.now();
  res.on('finish', () =>
    console.log(`[event-bus] ${req.method} ${req.path} ${res.statusCode} ${Date.now() - t}ms`)
  );
  next();
});

// ============================================================
// Webhook delivery (fire-and-forget)
// ============================================================
const deliverToSubscribers = async (event) => {
  const interested = subscribers.filter(
    s => s.eventTypes.includes('*') || s.eventTypes.includes(event.type)
  );

  console.log(`[event-bus] Delivering event '${event.type}' to ${interested.length} subscriber(s)`);

  const deliveries = interested.map(async (sub) => {
    const attempt = {
      subscriberId: sub.id,
      url:          sub.callbackUrl,
      attemptedAt:  new Date().toISOString(),
      status:       'pending',
    };
    try {
      await axios.post(sub.callbackUrl, { event }, {
        timeout: 5000,
        headers: { 'Content-Type': 'application/json', 'X-Event-Bus-Signature': sub.id },
      });
      attempt.status = 'delivered';
      console.log(`[event-bus] Delivered to ${sub.name} (${sub.callbackUrl})`);
    } catch (err) {
      attempt.status = 'failed';
      attempt.error  = err.message;
      console.warn(`[event-bus] Delivery failed for ${sub.name}: ${err.message}`);
    }
    return attempt;
  });

  const results = await Promise.allSettled(deliveries);
  return results.map(r => r.value || r.reason);
};

// ============================================================
// Routes
// ============================================================
app.get('/health', (req, res) => {
  res.json({
    status:          'healthy',
    service:         'event-bus',
    eventCount:      events.length,
    subscriberCount: subscribers.length,
    timestamp:       new Date().toISOString(),
  });
});

// POST /subscribe  — register a webhook subscriber
app.post('/subscribe', (req, res) => {
  const { name, callbackUrl, eventTypes } = req.body;

  if (!name)        return res.status(400).json({ error: 'Subscriber name is required.' });
  if (!callbackUrl) return res.status(400).json({ error: 'callbackUrl is required.' });
  if (!Array.isArray(eventTypes) || eventTypes.length === 0) {
    return res.status(400).json({ error: 'eventTypes array is required (use ["*"] for all).' });
  }

  // Prevent duplicate registrations for same name + callbackUrl
  const existing = subscribers.find(s => s.name === name && s.callbackUrl === callbackUrl);
  if (existing) {
    existing.eventTypes = eventTypes;
    existing.updatedAt  = new Date().toISOString();
    save(SUBSCRIBERS_FILE, subscribers);
    return res.json({ message: 'Subscription updated.', subscriber: existing });
  }

  const subscriber = {
    id:          uuidv4(),
    name,
    callbackUrl,
    eventTypes,
    createdAt:   new Date().toISOString(),
    updatedAt:   new Date().toISOString(),
  };
  subscribers.push(subscriber);
  save(SUBSCRIBERS_FILE, subscribers);

  console.log(`[event-bus] New subscriber: ${name} → ${callbackUrl}  events: ${eventTypes.join(', ')}`);
  res.status(201).json({ message: 'Subscription created.', subscriber });
});

// DELETE /subscribers/:id  — remove a subscriber
app.delete('/subscribers/:id', (req, res) => {
  const idx = subscribers.findIndex(s => s.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Subscriber not found.' });
  const [removed] = subscribers.splice(idx, 1);
  save(SUBSCRIBERS_FILE, subscribers);
  res.json({ message: 'Unsubscribed.', subscriber: removed });
});

// GET /subscribers  — list all subscribers
app.get('/subscribers', (req, res) => {
  res.json({ subscribers, count: subscribers.length });
});

// POST /publish  — publish an event
app.post('/publish', async (req, res) => {
  const { type, payload, source } = req.body;

  if (!type)    return res.status(400).json({ error: 'Event type is required.' });
  if (!payload) return res.status(400).json({ error: 'Event payload is required.' });

  const event = {
    id:          uuidv4(),
    type,
    source:      source || 'unknown',
    payload,
    publishedAt: new Date().toISOString(),
    deliveries:  [],
  };

  events.push(event);
  // Keep only last 1000 events in memory (circular buffer)
  if (events.length > 1000) events = events.slice(-1000);
  save(EVENTS_FILE, events);

  // Deliver asynchronously — don't block the publisher
  deliverToSubscribers(event)
    .then(deliveries => {
      event.deliveries = deliveries;
      save(EVENTS_FILE, events);
    })
    .catch(err => console.error('[event-bus] Delivery error:', err));

  console.log(`[event-bus] Published event: ${type}  id: ${event.id}`);
  res.status(202).json({ message: 'Event accepted.', eventId: event.id });
});

// GET /events  — list events (with optional type filter)
app.get('/events', (req, res) => {
  let result = [...events];

  if (req.query.type) {
    result = result.filter(e => e.type === req.query.type);
  }
  if (req.query.since) {
    const since = new Date(req.query.since);
    result = result.filter(e => new Date(e.publishedAt) >= since);
  }

  const limit  = Math.min(100, parseInt(req.query.limit  || '50'));
  const offset = parseInt(req.query.offset || '0');
  const total  = result.length;
  result = result.slice(-(offset + limit)).slice(0, limit);  // most recent first
  result.reverse();

  res.json({ events: result, total, limit, offset });
});

// GET /events/:id  — single event
app.get('/events/:id', (req, res) => {
  const event = events.find(e => e.id === req.params.id);
  if (!event) return res.status(404).json({ error: 'Event not found.' });
  res.json({ event });
});

// ============================================================
// Error handler
// ============================================================
app.use((err, req, res, next) => {
  console.error('[event-bus] Error:', err);
  res.status(500).json({ error: 'Internal server error.' });
});

app.listen(PORT, () => console.log(`Event Bus running on port ${PORT}  (${events.length} stored events, ${subscribers.length} subscribers)`));
module.exports = app;

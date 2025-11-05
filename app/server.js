const express = require('express');
const fs = require('fs');
const path = require('path');
const bodyParser = require('body-parser');
const cors = require('cors');

// Load environment variables from .env (if present)
require('dotenv').config();

// Load Stripe secret key from environment
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || '';
const stripe = require('stripe')(STRIPE_SECRET_KEY);

const app = express();
app.use(cors());
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'public')));

const PRODUCTS_FILE = path.join(__dirname, 'products.json');
const SALES_FILE = path.join(__dirname, 'sales.json');
const DOWNLOADS_DIR = path.join(__dirname, 'downloads');

function readJSON(file) {
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function writeJSON(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
}

// GET products list
app.get('/products', (req, res) => {
  const products = readJSON(PRODUCTS_FILE) || [];
  res.json(products);
});

// Create Checkout Session for a productId
app.post('/create-checkout-session', async (req, res) => {
  try {
    const { productId } = req.body;
    const products = readJSON(PRODUCTS_FILE) || [];
    const product = products.find(p => p.id === productId);
    if (!product) return res.status(404).json({ error: 'Product not found' });

    if (!STRIPE_SECRET_KEY) {
      // Development fallback: return a fake URL so client doesn't crash
      return res.json({ url: '/success.html?session_id=fake_session_' + Date.now() });
    }

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [
        {
          price_data: {
            currency: 'sar',
            product_data: { name: product.title },
            unit_amount: Math.round(product.price * 100)
          },
          quantity: 1
        }
      ],
      mode: 'payment',
      metadata: { productId: product.id },
      success_url: `${req.protocol}://${req.get('host')}/success.html?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${req.protocol}://${req.get('host')}/`
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal error' });
  }
});

// Return session details and record sale (basic prototype)
app.get('/session', async (req, res) => {
  const sessionId = req.query.session_id;
  if (!sessionId) return res.status(400).json({ error: 'session_id required' });

  // For fake sessions (dev) respond with a synthetic result
  if (sessionId.startsWith('fake_session_')) {
    const parts = sessionId.split('_');
    const fake = {
      id: sessionId,
      payment_status: 'paid',
      metadata: { productId: 'bot_khatt' }
    };
    // record sale
    const sales = readJSON(SALES_FILE) || [];
    sales.push({ sessionId: sessionId, productId: fake.metadata.productId, time: new Date().toISOString() });
    writeJSON(SALES_FILE, sales);
    return res.json({ session: fake, productId: fake.metadata.productId });
  }

  if (!STRIPE_SECRET_KEY) return res.status(400).json({ error: 'Server not configured with Stripe key' });

  try {
    const session = await stripe.checkout.sessions.retrieve(sessionId);
    const productId = session.metadata && session.metadata.productId;
    // record sale
    const sales = readJSON(SALES_FILE) || [];
    sales.push({ sessionId, productId, time: new Date().toISOString() });
    writeJSON(SALES_FILE, sales);
    res.json({ session, productId });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Unable to retrieve session' });
  }
});

// Serve downloadable file if session is valid and paid
app.get('/download/:file', async (req, res) => {
  const file = req.params.file; // expected to match product.filename
  const sessionId = req.query.session_id;
  if (!sessionId) return res.status(400).send('session_id query parameter required');

  // validate session
  try {
    if (sessionId.startsWith('fake_session_')) {
      // allow for dev
    } else {
      if (!STRIPE_SECRET_KEY) return res.status(400).send('Server not configured');
      const session = await stripe.checkout.sessions.retrieve(sessionId);
      if (session.payment_status !== 'paid') return res.status(403).send('Payment not completed');
    }

    const filepath = path.join(DOWNLOADS_DIR, file);
    if (!fs.existsSync(filepath)) return res.status(404).send('File not found');

    res.download(filepath);
  } catch (err) {
    console.error(err);
    res.status(500).send('Error validating download');
  }
});

// Top sold items
app.get('/top-sales', (req, res) => {
  const sales = readJSON(SALES_FILE) || [];
  const products = readJSON(PRODUCTS_FILE) || [];
  const counts = {};
  sales.forEach(s => { counts[s.productId] = (counts[s.productId] || 0) + 1; });
  const result = Object.keys(counts).map(id => {
    const prod = products.find(p => p.id === id) || { title: id };
    return { id, title: prod.title, sold: counts[id] };
  }).sort((a,b) => b.sold - a.sold);
  res.json(result);
});

// Simple config endpoint to show server state (do not expose secret keys)
app.get('/config', (req, res) => {
  res.json({ publishableKey: process.env.STRIPE_PUBLISHABLE_KEY || '' });
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Server running on http://localhost:${port}`));

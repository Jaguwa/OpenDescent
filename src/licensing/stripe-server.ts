/**
 * Stripe Checkout + License Server
 *
 * Runs alongside the relay node on the VPS. Handles:
 * 1. Creating Stripe checkout sessions (user clicks "Upgrade" in app)
 * 2. Receiving Stripe webhooks (payment confirmed)
 * 3. Generating signed license keys
 * 4. Serving license keys to authenticated users
 *
 * Environment variables:
 *   STRIPE_SECRET_KEY     — Stripe secret key (sk_test_... or sk_live_...)
 *   STRIPE_WEBHOOK_SECRET — Stripe webhook signing secret (whsec_...)
 *   STRIPE_PRICE_ID       — Price ID for OpenDescent Pro (price_...)
 *   LICENSE_PRIVATE_KEY   — Base64 Ed25519 private key for signing licenses
 *   LICENSE_PUBLIC_KEY    — Base64 Ed25519 public key (for reference)
 *
 * Usage:
 *   LICENSE_PRIVATE_KEY=... STRIPE_SECRET_KEY=sk_test_... node dist/licensing/stripe-server.js
 */

import * as http from 'http';
import * as https from 'https';
import * as crypto from 'crypto';
import { createLicense, generateLicenseKeypair } from './license.js';

// ─── Config ─────────────────────────────────────────────────────────────────

const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || '';
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || '';
const STRIPE_PRICE_ID = process.env.STRIPE_PRICE_ID || 'price_1TD93I13ZaqW84U7IIWJ4s1S';
const LICENSE_PRIVATE_KEY = process.env.LICENSE_PRIVATE_KEY || '';
const PORT = parseInt(process.env.LICENSE_PORT || '9000', 10);

// License duration: 35 days (5 day grace period beyond 30-day billing cycle)
const LICENSE_DURATION_MS = 35 * 24 * 60 * 60 * 1000;

// In-memory store of issued licenses (peerId -> licenseKey)
// In production, persist to a file or database
const issuedLicenses = new Map<string, string>();
const licensesFile = process.env.LICENSES_FILE || './licenses.json';

// ─── Stripe API helpers (no SDK — raw HTTP to avoid deps) ───────────────────

async function stripeRequest(
  method: string,
  path: string,
  body?: Record<string, string>,
): Promise<any> {
  return new Promise((resolve, reject) => {
    const auth = Buffer.from(`${STRIPE_SECRET_KEY}:`).toString('base64');
    const bodyStr = body
      ? Object.entries(body).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&')
      : '';

    const options: http.RequestOptions = {
      hostname: 'api.stripe.com',
      port: 443,
      path: `/v1${path}`,
      method,
      headers: {
        'Authorization': `Basic ${auth}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        ...(bodyStr ? { 'Content-Length': Buffer.byteLength(bodyStr) } : {}),
      },
    };

    const req = https.request(options, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        try {
          resolve(JSON.parse(text));
        } catch {
          reject(new Error(`Stripe response parse error: ${text.slice(0, 200)}`));
        }
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

// ─── Webhook signature verification ─────────────────────────────────────────

function verifyStripeSignature(payload: string, sigHeader: string, secret: string): boolean {
  const elements = sigHeader.split(',');
  let timestamp = '';
  const signatures: string[] = [];

  for (const element of elements) {
    const [key, value] = element.split('=');
    if (key === 't') timestamp = value;
    if (key === 'v1') signatures.push(value);
  }

  if (!timestamp || signatures.length === 0) return false;

  const signedPayload = `${timestamp}.${payload}`;
  const expected = crypto
    .createHmac('sha256', secret)
    .update(signedPayload)
    .digest('hex');

  return signatures.some(sig => {
    try {
      return crypto.timingSafeEqual(Buffer.from(sig, 'hex'), Buffer.from(expected, 'hex'));
    } catch {
      return false;
    }
  });
}

// ─── License persistence ────────────────────────────────────────────────────

import * as fs from 'fs';

function loadLicenses(): void {
  try {
    if (fs.existsSync(licensesFile)) {
      const data = JSON.parse(fs.readFileSync(licensesFile, 'utf8'));
      for (const [k, v] of Object.entries(data)) {
        issuedLicenses.set(k, v as string);
      }
      console.log(`[License] Loaded ${issuedLicenses.size} licenses from disk`);
    }
  } catch (err) {
    console.warn(`[License] Failed to load licenses:`, err);
  }
}

function saveLicenses(): void {
  try {
    const data: Record<string, string> = {};
    for (const [k, v] of issuedLicenses) {
      data[k] = v;
    }
    fs.writeFileSync(licensesFile, JSON.stringify(data, null, 2));
  } catch (err) {
    console.warn(`[License] Failed to save licenses:`, err);
  }
}

// ─── HTTP Server ────────────────────────────────────────────────────────────

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > 1024 * 1024) { reject(new Error('Body too large')); return; }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function respond(res: http.ServerResponse, status: number, data: any): void {
  const json = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  });
  res.end(json);
}

async function handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const url = new URL(req.url || '/', `http://localhost:${PORT}`);

  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    res.end();
    return;
  }

  // ─── POST /checkout — Create a Stripe checkout session ─────────
  if (req.method === 'POST' && url.pathname === '/checkout') {
    try {
      const body = await readBody(req);
      const { peerId } = JSON.parse(body);

      if (!peerId || typeof peerId !== 'string') {
        respond(res, 400, { error: 'Missing peerId' });
        return;
      }

      const session = await stripeRequest('POST', '/checkout/sessions', {
        'mode': 'subscription',
        'line_items[0][price]': STRIPE_PRICE_ID,
        'line_items[0][quantity]': '1',
        'metadata[peerId]': peerId,
        'subscription_data[metadata][peerId]': peerId,
        'success_url': `http://${process.env.LICENSE_HOST || '188.166.151.203'}:${PORT}/success?session_id={CHECKOUT_SESSION_ID}`,
        'cancel_url': `http://${process.env.LICENSE_HOST || '188.166.151.203'}:${PORT}/cancel`,
      });

      if (session.error) {
        console.error('[Stripe] Checkout session error:', session.error);
        respond(res, 500, { error: session.error.message });
        return;
      }

      respond(res, 200, { url: session.url, sessionId: session.id });
    } catch (err: any) {
      console.error('[Checkout] Error:', err);
      respond(res, 500, { error: err.message });
    }
    return;
  }

  // ─── POST /webhook — Stripe webhook ───────────────────────────
  if (req.method === 'POST' && url.pathname === '/webhook') {
    try {
      const body = await readBody(req);
      const sigHeader = req.headers['stripe-signature'] as string;

      // Verify webhook signature if secret is configured
      if (STRIPE_WEBHOOK_SECRET && sigHeader) {
        if (!verifyStripeSignature(body, sigHeader, STRIPE_WEBHOOK_SECRET)) {
          console.warn('[Webhook] Invalid signature');
          respond(res, 400, { error: 'Invalid signature' });
          return;
        }
      }

      const event = JSON.parse(body);
      console.log(`[Webhook] Received: ${event.type}`);

      if (event.type === 'checkout.session.completed') {
        const session = event.data.object;
        const peerId = session.metadata?.peerId;

        if (peerId && LICENSE_PRIVATE_KEY) {
          const licenseKey = createLicense(peerId, 'pro', LICENSE_DURATION_MS, LICENSE_PRIVATE_KEY);
          issuedLicenses.set(peerId, licenseKey);
          saveLicenses();
          console.log(`[License] Issued pro license for ${peerId.slice(0, 12)}...`);
        } else {
          console.warn('[Webhook] Missing peerId or LICENSE_PRIVATE_KEY');
        }
      }

      // Handle subscription renewal — issue fresh license
      if (event.type === 'invoice.paid') {
        const invoice = event.data.object;
        const peerId = invoice.subscription_details?.metadata?.peerId
          || invoice.lines?.data?.[0]?.metadata?.peerId;

        if (peerId && LICENSE_PRIVATE_KEY) {
          const licenseKey = createLicense(peerId, 'pro', LICENSE_DURATION_MS, LICENSE_PRIVATE_KEY);
          issuedLicenses.set(peerId, licenseKey);
          saveLicenses();
          console.log(`[License] Renewed pro license for ${peerId.slice(0, 12)}...`);
        }
      }

      // Handle cancellation / payment failure
      if (event.type === 'customer.subscription.deleted' || event.type === 'invoice.payment_failed') {
        const obj = event.data.object;
        const peerId = obj.metadata?.peerId;
        if (peerId) {
          issuedLicenses.delete(peerId);
          saveLicenses();
          console.log(`[License] Revoked license for ${peerId.slice(0, 12)}...`);
        }
      }

      respond(res, 200, { received: true });
    } catch (err: any) {
      console.error('[Webhook] Error:', err);
      respond(res, 500, { error: err.message });
    }
    return;
  }

  // ─── GET /license?peerId=... — Retrieve license key ───────────
  if (req.method === 'GET' && url.pathname === '/license') {
    const peerId = url.searchParams.get('peerId');
    if (!peerId) {
      respond(res, 400, { error: 'Missing peerId' });
      return;
    }

    const licenseKey = issuedLicenses.get(peerId);
    if (licenseKey) {
      respond(res, 200, { licenseKey });
    } else {
      respond(res, 404, { error: 'No license found for this peer' });
    }
    return;
  }

  // ─── GET /success — Post-checkout success page ────────────────
  if (req.method === 'GET' && url.pathname === '/success') {
    const sessionId = url.searchParams.get('session_id');
    let licenseKey = '';
    let peerId = '';

    if (sessionId) {
      try {
        const session = await stripeRequest('GET', `/checkout/sessions/${sessionId}`);
        peerId = session.metadata?.peerId || '';
        if (peerId) {
          // License may already be created by webhook, or create it now
          if (!issuedLicenses.has(peerId) && LICENSE_PRIVATE_KEY) {
            const key = createLicense(peerId, 'pro', LICENSE_DURATION_MS, LICENSE_PRIVATE_KEY);
            issuedLicenses.set(peerId, key);
            saveLicenses();
          }
          licenseKey = issuedLicenses.get(peerId) || '';
        }
      } catch (err) {
        console.error('[Success] Failed to retrieve session:', err);
      }
    }

    const html = `<!DOCTYPE html>
<html><head><title>OpenDescent Pro — Activated</title>
<style>
  body { font-family: -apple-system, sans-serif; background: #0d1117; color: #e6edf3;
         display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0; }
  .card { background: #161b22; border: 1px solid #30363d; border-radius: 12px; padding: 2rem;
          max-width: 600px; width: 90%; text-align: center; }
  h1 { color: #58a6ff; margin-bottom: 0.5rem; }
  .key-box { background: #0d1117; border: 1px solid #30363d; border-radius: 8px; padding: 1rem;
             margin: 1.5rem 0; word-break: break-all; font-family: monospace; font-size: 0.85rem;
             user-select: all; cursor: pointer; color: #7ee787; }
  .hint { color: #8b949e; font-size: 0.9rem; }
  .copy-btn { background: #238636; color: #fff; border: none; padding: 0.6rem 1.5rem;
              border-radius: 6px; cursor: pointer; font-size: 1rem; margin-top: 0.5rem; }
  .copy-btn:hover { background: #2ea043; }
</style></head>
<body><div class="card">
  <h1>Welcome to Pro!</h1>
  <p>Your OpenDescent Pro license has been activated.</p>
  ${licenseKey ? `
    <p class="hint">Copy this license key and paste it into <strong>Settings → License Key</strong> in your app:</p>
    <div class="key-box" id="key" onclick="copyKey()">${licenseKey}</div>
    <button class="copy-btn" onclick="copyKey()">Copy License Key</button>
    <p class="hint" id="copied" style="display:none; color: #7ee787;">Copied!</p>
  ` : `
    <p class="hint">Your license is being generated. Refresh this page in a moment, or check your app settings.</p>
  `}
</div>
<script>
function copyKey() {
  navigator.clipboard.writeText(document.getElementById('key').textContent);
  document.getElementById('copied').style.display = 'block';
}
</script></body></html>`;

    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(html);
    return;
  }

  // ─── GET /cancel — Checkout cancelled ─────────────────────────
  if (req.method === 'GET' && url.pathname === '/cancel') {
    const html = `<!DOCTYPE html>
<html><head><title>OpenDescent — Checkout Cancelled</title>
<style>
  body { font-family: -apple-system, sans-serif; background: #0d1117; color: #e6edf3;
         display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0; }
  .card { background: #161b22; border: 1px solid #30363d; border-radius: 12px; padding: 2rem;
          max-width: 400px; text-align: center; }
  a { color: #58a6ff; }
</style></head>
<body><div class="card">
  <h2>Checkout cancelled</h2>
  <p>No charge was made. You can close this tab and try again anytime from the app.</p>
</div></body></html>`;

    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(html);
    return;
  }

  // ─── Fallback ─────────────────────────────────────────────────
  respond(res, 404, { error: 'Not found' });
}

// ─── Main ───────────────────────────────────────────────────────────────────

function main(): void {
  // Validate required config
  if (!STRIPE_SECRET_KEY) {
    console.error('ERROR: STRIPE_SECRET_KEY environment variable required');
    process.exit(1);
  }

  if (!LICENSE_PRIVATE_KEY) {
    console.log('[License] No LICENSE_PRIVATE_KEY set. Generating a new keypair...');
    const keypair = generateLicenseKeypair();
    console.log('\n=== SAVE THESE KEYS ===');
    console.log(`LICENSE_PUBLIC_KEY=${keypair.publicKey}`);
    console.log(`LICENSE_PRIVATE_KEY=${keypair.privateKey}`);
    console.log('======================\n');
    console.log('Set these as environment variables and restart.');
    console.log('The PUBLIC key must be embedded in the client (src/licensing/license.ts).');
    process.exit(0);
  }

  loadLicenses();

  const server = http.createServer((req, res) => {
    handleRequest(req, res).catch((err) => {
      console.error('[Server] Unhandled error:', err);
      respond(res, 500, { error: 'Internal server error' });
    });
  });

  server.listen(PORT, '0.0.0.0', () => {
    console.log(`[License Server] Running on port ${PORT}`);
    console.log(`[License Server] Checkout: POST http://localhost:${PORT}/checkout`);
    console.log(`[License Server] Webhook:  POST http://localhost:${PORT}/webhook`);
    console.log(`[License Server] License:  GET  http://localhost:${PORT}/license?peerId=...`);
  });
}

main();

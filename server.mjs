/**
 * ResumeCraft's minimal Stripe Checkout server.
 *
 * Requires Node.js 18+ (for native fetch). Keep this file and .env out of any
 * public/static hosting directory that is served by a CDN alone.
 */
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { extname, resolve, sep } from 'node:path';
import { env } from 'node:process';
import { fileURLToPath } from 'node:url';

const siteRoot = resolve(fileURLToPath(new URL('.', import.meta.url)));
loadEnvironment(resolve(siteRoot, '.env'));

const port = Number(env.PORT || 4242);
const appUrl = (env.APP_URL || `http://localhost:${port}`).replace(/\/$/, '');
const prices = {
  monthly: env.STRIPE_PRICE_MONTHLY,
  annual: env.STRIPE_PRICE_ANNUAL,
};
const mimeTypes = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon',
};

function loadEnvironment(path) {
  try {
    const contents = readFileSync(path, 'utf8');
    for (const line of contents.split(/\r?\n/)) {
      const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (!match || match[1].startsWith('#')) continue;
      const value = match[2].replace(/^(['"])(.*)\1$/, '$2');
      if (!env[match[1]]) env[match[1]] = value;
    }
  } catch { /* A .env file is optional; environment variables work too. */ }
}

function sendJson(response, status, payload) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(payload));
}

function readBody(request, limit = 128_000) {
  return new Promise((resolveBody, reject) => {
    const chunks = [];
    let bytes = 0;
    request.on('data', chunk => {
      bytes += chunk.length;
      if (bytes > limit) { reject(new Error('Request body is too large.')); request.destroy(); return; }
      chunks.push(chunk);
    });
    request.on('end', () => resolveBody(Buffer.concat(chunks)));
    request.on('error', reject);
  });
}

function configuredForCheckout() {
  return Boolean(env.STRIPE_SECRET_KEY && prices.monthly && prices.annual);
}

async function stripeRequest(path, form) {
  const response = await fetch(`https://api.stripe.com/v1${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      'Idempotency-Key': randomUUID(),
    },
    body: new URLSearchParams(form),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data?.error?.message || 'Stripe could not create the requested session.');
  return data;
}

function verifyStripeSignature(payload, signature) {
  if (!env.STRIPE_WEBHOOK_SECRET || !signature) return false;
  const pieces = signature.split(',').map(pair => {
    const [key, ...value] = pair.split('=');
    return [key, value.join('=')];
  });
  const timestamp = pieces.find(([key]) => key === 't')?.[1];
  const signatures = pieces.filter(([key]) => key === 'v1').map(([, value]) => value);
  if (!timestamp || signatures.length === 0 || Math.abs(Math.floor(Date.now() / 1000) - Number(timestamp)) > 300) return false;
  const expected = createHmac('sha256', env.STRIPE_WEBHOOK_SECRET)
    .update(`${timestamp}.${payload.toString('utf8')}`)
    .digest('hex');
  const expectedBuffer = Buffer.from(expected, 'utf8');
  return signatures.some(value => {
    const receivedBuffer = Buffer.from(value, 'utf8');
    return expectedBuffer.length === receivedBuffer.length && timingSafeEqual(expectedBuffer, receivedBuffer);
  });
}

async function handleWebhook(request, response) {
  const payload = await readBody(request);
  if (!verifyStripeSignature(payload, request.headers['stripe-signature'])) {
    return sendJson(response, 400, { error: 'Webhook signature verification failed.' });
  }
  const event = JSON.parse(payload.toString('utf8'));
  const object = event.data?.object || {};

  // Connect this hook to your authenticated user database. The safe mapping is
  // `client_reference_id` (your internal user ID) -> Stripe customer/subscription.
  // Never unlock Pro from only a success-page redirect; webhooks are authoritative.
  switch (event.type) {
    case 'checkout.session.completed':
      console.info('[Stripe] Checkout completed:', object.id, object.client_reference_id || '(no user id)');
      break;
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted':
      console.info('[Stripe] Subscription changed:', object.id, object.status);
      break;
    default:
      console.info('[Stripe] Received:', event.type);
  }
  return sendJson(response, 200, { received: true });
}

async function serveStatic(request, response) {
  const requestPath = new URL(request.url, appUrl).pathname;
  const relativePath = requestPath === '/' ? 'index.html' : decodeURIComponent(requestPath).replace(/^\/+/, '');
  const candidate = resolve(siteRoot, relativePath);
  const includesHiddenPath = relativePath.split('/').some(part => part.startsWith('.'));
  if (includesHiddenPath || (candidate !== siteRoot && !candidate.startsWith(`${siteRoot}${sep}`))) return sendJson(response, 403, { error: 'Forbidden' });
  try {
    const content = await readFile(candidate);
    response.writeHead(200, {
      'Content-Type': mimeTypes[extname(candidate).toLowerCase()] || 'application/octet-stream',
      'X-Content-Type-Options': 'nosniff',
    });
    response.end(content);
  } catch {
    sendJson(response, 404, { error: 'Not found' });
  }
}

const server = http.createServer(async (request, response) => {
  try {
    if (request.method === 'POST' && request.url === '/api/stripe/webhook') return handleWebhook(request, response);

    if (request.method === 'POST' && request.url === '/api/stripe/create-checkout-session') {
      if (!configuredForCheckout()) {
        return sendJson(response, 503, { error: 'Stripe is not configured yet. Add the values in .env and restart the server.' });
      }
      const body = JSON.parse((await readBody(request)).toString('utf8') || '{}');
      const plan = body.plan === 'annual' ? 'annual' : body.plan === 'monthly' ? 'monthly' : null;
      if (!plan) return sendJson(response, 400, { error: 'Choose a valid subscription plan.' });

      const checkout = await stripeRequest('/checkout/sessions', {
        mode: 'subscription',
        'line_items[0][price]': prices[plan],
        'line_items[0][quantity]': '1',
        'subscription_data[trial_period_days]': '7',
        'subscription_data[metadata][plan]': plan,
        'allow_promotion_codes': 'true',
        success_url: `${appUrl}/?checkout=success&session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${appUrl}/?checkout=cancelled`,
      });
      return sendJson(response, 200, { url: checkout.url });
    }

    return serveStatic(request, response);
  } catch (error) {
    console.error(error);
    return sendJson(response, 500, { error: error.message || 'Something went wrong.' });
  }
});

server.listen(port, () => console.log(`ResumeCraft is running at ${appUrl}`));

/*
 * scripts/publish.mjs against a pretend Google: the token endpoint checks the
 * service account's signed JWT, the Chrome Web Store API v2 keeps a little
 * state (live version, submission in review). No network, no real store.
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const PUBLISHER = 'pub-123';
const ITEM = 'abcdefghijklmnopabcdefghijklmnop';
const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const otherKey = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;

let server;
let base;
let publish;
let compareVersions;
let store;
const calls = [];

function reply(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function checkJwt(assertion) {
  const [header, claims, signature] = assertion.split('.');
  const ok = crypto.verify('RSA-SHA256', Buffer.from(`${header}.${claims}`), publicKey, Buffer.from(signature, 'base64url'));
  const c = JSON.parse(Buffer.from(claims, 'base64url').toString());
  return ok && c.iss === 'release@example.iam.gserviceaccount.com' && c.scope === 'https://www.googleapis.com/auth/chromewebstore' && c.aud === `${base}/token` && c.exp > c.iat;
}

const channel = (v) => ({ distributionChannels: [{ crxVersion: v, deployPercentage: 100 }] });

before(async () => {
  server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const url = new URL(req.url, base);
      calls.push(`${req.method} ${url.pathname}`);
      if (url.pathname === '/token') {
        const form = new URLSearchParams(body.toString());
        if (form.get('grant_type') !== 'urn:ietf:params:oauth:grant-type:jwt-bearer' || !checkJwt(form.get('assertion'))) {
          return reply(res, 400, { error: 'invalid_grant', error_description: 'Invalid JWT Signature.' });
        }
        return reply(res, 200, { access_token: 'token-1', expires_in: 3600 });
      }
      if (req.headers.authorization !== 'Bearer token-1') return reply(res, 401, { error: { message: 'no' } });
      const item = `/v2/publishers/${PUBLISHER}/items/${ITEM}`;
      if (req.method === 'GET' && url.pathname === `${item}:fetchStatus`) {
        const out = { itemId: ITEM, publishedItemRevisionStatus: store.live ? { state: 'PUBLISHED', ...channel(store.live) } : undefined };
        if (store.submitted) out.submittedItemRevisionStatus = { state: store.submitted.state, ...channel(store.submitted.version) };
        if (store.asyncPolls !== undefined) {
          store.asyncPolls -= 1;
          out.lastAsyncUploadState = store.asyncPolls > 0 ? 'IN_PROGRESS' : 'SUCCEEDED';
        }
        return reply(res, 200, out);
      }
      if (req.method === 'POST' && url.pathname === `/upload${item}:upload`) {
        if (body.subarray(0, 2).toString() !== 'PK' || req.headers['content-type'] !== 'application/zip') return reply(res, 400, { error: { message: 'not a zip' } });
        store.uploaded = store.zipVersion;
        if (store.async) {
          store.asyncPolls = 2;
          return reply(res, 200, { itemId: ITEM, uploadState: 'IN_PROGRESS' });
        }
        return reply(res, 200, { itemId: ITEM, uploadState: 'SUCCEEDED', crxVersion: store.zipVersion });
      }
      if (req.method === 'POST' && url.pathname === `${item}:publish`) {
        const request = JSON.parse(body.toString() || '{}');
        if (request.publishType !== 'DEFAULT_PUBLISH') return reply(res, 400, { error: { message: 'publishType' } });
        if (!store.uploaded && !(store.submitted && store.submitted.state === 'CANCELLED')) return reply(res, 400, { error: { message: 'nothing to publish' } });
        store.submitted = { state: 'PENDING_REVIEW', version: store.uploaded || store.submitted.version };
        return reply(res, 200, { itemId: ITEM, state: 'PENDING_REVIEW' });
      }
      return reply(res, 404, { error: { message: `unknown ${req.method} ${url.pathname}` } });
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  process.env.CWS_API = base;
  process.env.CWS_POLL_MS = '5';
  ({ publish, compareVersions } = await import('../scripts/publish.mjs'));
});

after(() => server && server.close());

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmcs-publish-'));
function zip(version) {
  const file = path.join(dir, `cart-saver-${version}.zip`);
  fs.writeFileSync(file, Buffer.concat([Buffer.from('PK\x03\x04'), crypto.randomBytes(64)]));
  store.zipVersion = version;
  return file;
}
const env = (key = privateKey) => ({
  CWS_SERVICE_ACCOUNT: JSON.stringify({
    type: 'service_account',
    client_email: 'release@example.iam.gserviceaccount.com',
    private_key: key.export({ type: 'pkcs8', format: 'pem' }),
    token_uri: `${base}/token`,
  }),
  CWS_PUBLISHER_ID: PUBLISHER,
  CWS_ITEM_ID: ITEM,
});

describe('publishing to the Chrome Web Store', () => {
  beforeEach(() => {
    store = { live: '1.6.6', submitted: null };
    calls.length = 0;
  });

  it('does nothing until the secrets are set up', async () => {
    const result = await publish(zip('1.6.7'), {});
    assert.equal(result.result, 'skipped');
    assert.deepEqual(calls, []);
  });

  it('uploads a new version and sends it for review', async () => {
    const result = await publish(zip('1.6.7'), env());
    assert.equal(result.result, 'submitted');
    assert.equal(result.state, 'PENDING_REVIEW');
    assert.deepEqual(store.submitted, { state: 'PENDING_REVIEW', version: '1.6.7' });
    assert.deepEqual(calls.map((c) => c.split(' ')[1].split(':').pop()), ['/token', 'fetchStatus', 'upload', 'publish']);
  });

  it('waits for an upload the store still processes', async () => {
    store.async = true;
    const result = await publish(zip('1.6.7'), env());
    assert.equal(result.result, 'submitted');
    assert.ok(calls.filter((c) => c.endsWith(':fetchStatus')).length >= 3, 'polled');
  });

  it('knows a version that is already live or in review', async () => {
    assert.equal((await publish(zip('1.6.6'), env())).result, 'done');
    store.submitted = { state: 'PENDING_REVIEW', version: '1.6.7' };
    assert.equal((await publish(zip('1.6.7'), env())).result, 'done');
    assert.ok(!calls.some((c) => c.includes(':upload') || c.includes(':publish')), 'nothing sent twice');
  });

  it('waits while another version is in review', async () => {
    store.submitted = { state: 'PENDING_REVIEW', version: '1.6.7' };
    const result = await publish(zip('1.6.8'), env());
    assert.equal(result.result, 'waiting');
    assert.ok(!calls.some((c) => c.includes(':upload')));
  });

  it('submits a cancelled version again without uploading it again', async () => {
    store.submitted = { state: 'CANCELLED', version: '1.6.7' };
    assert.equal((await publish(zip('1.6.7'), env())).result, 'submitted');
    assert.ok(!calls.some((c) => c.includes(':upload')));
    assert.equal(store.submitted.state, 'PENDING_REVIEW');
  });

  it('refuses a version that is not higher, and says so for a rejected one', async () => {
    await assert.rejects(publish(zip('1.6.5'), env()), /not higher than the live 1\.6\.6/);
    store.submitted = { state: 'REJECTED', version: '1.6.7' };
    await assert.rejects(publish(zip('1.6.7'), env()), /was rejected/);
  });

  it('stops with a clear message when Google refuses the service account', async () => {
    await assert.rejects(publish(zip('1.6.7'), env(otherKey)), /Google refused the service account \(400\): Invalid JWT Signature/);
    await assert.rejects(publish(zip('1.6.7'), { ...env(), CWS_SERVICE_ACCOUNT: 'nope' }), /not valid JSON/);
  });

  it('compares versions number by number', () => {
    assert.equal(compareVersions('1.6.10', '1.6.9'), 1);
    assert.equal(compareVersions('1.7', '1.7.0'), 0);
    assert.equal(compareVersions('1.6.6', '1.7.0'), -1);
  });
});

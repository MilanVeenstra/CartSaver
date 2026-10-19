#!/usr/bin/env node
/*
 * Upload a ZIP to the Chrome Web Store and submit it for review, with the
 * Chrome Web Store API (v2) and a Google service account. Used by
 * .github/workflows/release.yml; no packages needed (Node 20+).
 *
 *   node scripts/publish.mjs dist/cart-saver-1.6.7.zip
 *
 * Environment (GitHub secrets, see docs/release.md "Automatisch publiceren"):
 *   CWS_SERVICE_ACCOUNT  the service account's JSON key (the whole file)
 *   CWS_PUBLISHER_ID     your publisher ID (Developer Dashboard)
 *   CWS_ITEM_ID          the extension's item ID (32 letters a–p)
 *
 * Writes `result=<…>` to $GITHUB_OUTPUT (and prints it):
 *   submitted  uploaded and sent for review (or published right away)
 *   done       the store already has this version (submitted or live)
 *   waiting    another version is still in review: try again later
 *   skipped    the secrets are not set up yet
 * Anything else is an error (exit code 1).
 */
import crypto from 'node:crypto';
import fs from 'node:fs';

const API = process.env.CWS_API || 'https://chromewebstore.googleapis.com';
const SCOPE = 'https://www.googleapis.com/auth/chromewebstore';
const POLL_MS = Number(process.env.CWS_POLL_MS || 5000);
const POLL_TRIES = 60;

function output(result, extra = {}) {
  const lines = Object.entries({ result, ...extra }).map(([k, v]) => `${k}=${v}`);
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `${lines.join('\n')}\n`);
  console.log(lines.join('\n'));
}

const b64url = (data) => Buffer.from(data).toString('base64url');

/** An access token for the service account (OAuth 2.0 JWT bearer grant). */
async function accessToken(account) {
  const tokenUri = account.token_uri || 'https://oauth2.googleapis.com/token';
  const now = Math.floor(Date.now() / 1000);
  const unsigned = `${b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))}.${b64url(
    JSON.stringify({ iss: account.client_email, scope: SCOPE, aud: tokenUri, iat: now, exp: now + 3600 }),
  )}`;
  const signature = crypto.sign('RSA-SHA256', Buffer.from(unsigned), account.private_key).toString('base64url');
  const res = await fetch(tokenUri, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${unsigned}.${signature}` }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.access_token) throw new Error(`Google refused the service account (${res.status}): ${body.error_description || body.error || 'no token'}`);
  return body.access_token;
}

async function call(token, method, url, { body, contentType } = {}) {
  const res = await fetch(url, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(contentType ? { 'Content-Type': contentType } : {}) },
    body,
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    // Not JSON: keep the text for the error.
  }
  if (!res.ok) {
    const message = (json && json.error && json.error.message) || text.slice(0, 300) || res.statusText;
    const err = new Error(`${method} ${new URL(url).pathname}: ${res.status} ${message}`);
    err.status = res.status;
    throw err;
  }
  return json || {};
}

/** "1.6.10" > "1.6.9": compare dotted versions number by number. */
export function compareVersions(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return Math.sign(d);
  }
  return 0;
}

const versionsOf = (revision) => ((revision && revision.distributionChannels) || []).map((c) => c.crxVersion).filter(Boolean);

export async function publish(zipPath, env = process.env) {
  const { CWS_SERVICE_ACCOUNT, CWS_PUBLISHER_ID, CWS_ITEM_ID } = env;
  if (!CWS_SERVICE_ACCOUNT || !CWS_PUBLISHER_ID || !CWS_ITEM_ID) {
    console.log('::notice::Chrome Web Store secrets are not set up yet: nothing was uploaded. See docs/release.md.');
    return { result: 'skipped' };
  }
  let account;
  try {
    account = JSON.parse(CWS_SERVICE_ACCOUNT);
  } catch {
    throw new Error('CWS_SERVICE_ACCOUNT is not valid JSON: paste the whole key file.');
  }
  const zip = fs.readFileSync(zipPath);
  const version = (zipPath.match(/-(\d+(?:\.\d+){0,3})\.zip$/) || [])[1];
  if (!version) throw new Error(`Cannot read the version from ${zipPath} (expected …-<version>.zip).`);

  const item = `${API}/v2/publishers/${encodeURIComponent(CWS_PUBLISHER_ID)}/items/${encodeURIComponent(CWS_ITEM_ID)}`;
  const token = await accessToken(account);
  const status = await call(token, 'GET', `${item}:fetchStatus`);
  const live = versionsOf(status.publishedItemRevisionStatus);
  const submitted = status.submittedItemRevisionStatus || null;
  const inReview = submitted && submitted.state === 'PENDING_REVIEW' ? versionsOf(submitted) : [];
  console.log(`Store: live ${live.join(', ') || '-'}; submitted ${submitted ? `${versionsOf(submitted).join(', ') || '?'} (${submitted.state})` : '-'}; this build ${version}`);

  if (status.takenDown) throw new Error('The item was taken down for a policy violation: see the Developer Dashboard.');
  if (live.includes(version)) {
    console.log(`::notice::Version ${version} is already live in the store.`);
    return { result: 'done', version };
  }
  // Cancelled (in the dashboard): the package is still there, it only needs submitting again.
  let uploaded = false;
  if (submitted && versionsOf(submitted).includes(version)) {
    if (submitted.state === 'REJECTED') throw new Error(`Version ${version} was rejected: see the Developer Dashboard (mail from the Chrome Web Store), fix it and raise the version.`);
    if (submitted.state !== 'CANCELLED') {
      console.log(`::notice::Version ${version} is already submitted (${submitted.state}).`);
      return { result: 'done', version };
    }
    uploaded = true;
  }
  if (inReview.length) {
    console.log(`::notice::Version ${inReview.join(', ')} is still in review. ${version} goes up once that review is done (the daily run tries again).`);
    return { result: 'waiting', version };
  }
  const newest = [...live].sort(compareVersions).pop();
  if (newest && compareVersions(version, newest) <= 0) {
    throw new Error(`Version ${version} is not higher than the live ${newest}: raise "version" in manifest.json.`);
  }

  if (!uploaded) {
    const upload = await call(token, 'POST', `${API}/upload/v2/publishers/${encodeURIComponent(CWS_PUBLISHER_ID)}/items/${encodeURIComponent(CWS_ITEM_ID)}:upload?uploadType=media`, {
      body: zip,
      contentType: 'application/zip',
    });
    let state = upload.uploadState;
    for (let i = 0; state === 'IN_PROGRESS' && i < POLL_TRIES; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
      state = (await call(token, 'GET', `${item}:fetchStatus`)).lastAsyncUploadState;
    }
    if (state !== 'SUCCEEDED') throw new Error(`Upload ${state === 'IN_PROGRESS' ? 'still processing after 5 minutes' : `failed (${state || 'unknown'})`}: see the Developer Dashboard.`);
    if (upload.crxVersion && upload.crxVersion !== version) throw new Error(`The store read version ${upload.crxVersion} from the ZIP, not ${version}.`);
    console.log(`Uploaded ${version}.`);
  }

  const published = await call(token, 'POST', `${item}:publish`, {
    body: JSON.stringify({ publishType: 'DEFAULT_PUBLISH' }),
    contentType: 'application/json',
  });
  for (const warning of (published.warningInfo && published.warningInfo.warnings) || []) console.log(`::warning::Store: ${JSON.stringify(warning)}`);
  console.log(`Submitted ${version}: ${published.state || 'sent'}.`);
  return { result: 'submitted', version, state: published.state || '' };
}

const isMain = process.argv[1] && import.meta.url === new URL(`file://${fs.realpathSync(process.argv[1])}`).href;
if (isMain) {
  const zipPath = process.argv[2];
  if (!zipPath) {
    console.error('usage: node scripts/publish.mjs <zip>');
    process.exit(2);
  }
  publish(zipPath).then(
    ({ result, ...rest }) => output(result, rest),
    (err) => {
      console.error(`::error::${err.message}`);
      process.exit(1);
    },
  );
}

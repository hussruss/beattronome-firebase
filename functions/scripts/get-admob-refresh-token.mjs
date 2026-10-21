#!/usr/bin/env node
// One-time bootstrap: obtain an OAuth2 refresh token for the AdMob Network
// Reporting API. Run this once on your machine while signed into the Google
// account that owns the Beattronome AdMob account. The printed refresh token
// goes into Google Secret Manager as ADMOB_REFRESH_TOKEN; the Cloud Function
// uses it to mint short-lived access tokens at runtime.
//
// Usage:
//   ADMOB_OAUTH_CLIENT_ID=... \
//   ADMOB_OAUTH_CLIENT_SECRET=... \
//   node functions/scripts/get-admob-refresh-token.mjs
//
// Prerequisites:
//   1. In Google Cloud Console (same project as Firebase), enable the
//      "AdMob API" under APIs & Services.
//   2. Create an OAuth 2.0 Client ID of type "Desktop app" (or "Web
//      application" with http://localhost:3000 added to authorized redirect
//      URIs). Copy the client_id and client_secret into the env vars above.
//   3. In AdMob → Settings → API access, ensure the API is enabled for the
//      AdMob account you'll sign in with.

import { createServer } from 'node:http';
import { URL } from 'node:url';

const PORT = 3000;
const REDIRECT_URI = `http://localhost:${PORT}`;
const SCOPE = 'https://www.googleapis.com/auth/admob.readonly';
const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    console.error(`Missing required env var: ${name}`);
    console.error(
      'Usage: ADMOB_OAUTH_CLIENT_ID=... ADMOB_OAUTH_CLIENT_SECRET=... ' +
        'node functions/scripts/get-admob-refresh-token.mjs',
    );
    process.exit(1);
  }
  return value;
}

const clientId = requireEnv('ADMOB_OAUTH_CLIENT_ID');
const clientSecret = requireEnv('ADMOB_OAUTH_CLIENT_SECRET');

const authUrl = new URL(AUTH_ENDPOINT);
authUrl.searchParams.set('client_id', clientId);
authUrl.searchParams.set('redirect_uri', REDIRECT_URI);
authUrl.searchParams.set('response_type', 'code');
authUrl.searchParams.set('scope', SCOPE);
authUrl.searchParams.set('access_type', 'offline');
authUrl.searchParams.set('prompt', 'consent');

async function exchangeCodeForTokens(code) {
  const body = new URLSearchParams({
    code,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: REDIRECT_URI,
    grant_type: 'authorization_code',
  });
  const res = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  const json = await res.json();
  if (!res.ok) {
    throw new Error(
      `Token exchange failed (${res.status}): ${JSON.stringify(json)}`,
    );
  }
  return json;
}

function htmlPage(message, isError = false) {
  const color = isError ? '#b00020' : '#13a538';
  return `<!doctype html><meta charset="utf-8"><title>AdMob OAuth</title>
<body style="font-family:system-ui;padding:48px;background:#0a0a0a;color:#fff">
<h1 style="color:${color}">${message}</h1>
<p style="color:#aaa">You can close this tab and return to your terminal.</p>
</body>`;
}

const server = createServer(async (req, res) => {
  if (!req.url) {
    res.writeHead(400).end();
    return;
  }
  const reqUrl = new URL(req.url, REDIRECT_URI);
  const code = reqUrl.searchParams.get('code');
  const errParam = reqUrl.searchParams.get('error');

  if (errParam) {
    res.writeHead(400, { 'Content-Type': 'text/html' });
    res.end(htmlPage(`OAuth error: ${errParam}`, true));
    console.error(`\n❌ OAuth error: ${errParam}`);
    server.close();
    process.exit(1);
  }

  if (!code) {
    res.writeHead(404, { 'Content-Type': 'text/html' });
    res.end(htmlPage('Waiting for OAuth callback…'));
    return;
  }

  try {
    const tokens = await exchangeCodeForTokens(code);
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(htmlPage('Refresh token captured ✓'));

    console.log('\n✅ Tokens received.\n');
    console.log('Refresh token (store this in Secret Manager as');
    console.log('ADMOB_REFRESH_TOKEN — it never expires unless revoked):\n');
    console.log(tokens.refresh_token);
    console.log('\nAccess token (short-lived, ~1h — for ad-hoc testing only):\n');
    console.log(tokens.access_token);
    console.log('\nDone. Closing local server.');

    server.close();
    process.exit(0);
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'text/html' });
    res.end(htmlPage(String(err), true));
    console.error(`\n❌ ${err}`);
    server.close();
    process.exit(1);
  }
});

server.listen(PORT, () => {
  console.log(`\nLocal callback server listening on ${REDIRECT_URI}\n`);
  console.log('Open this URL in your browser and sign in with the AdMob');
  console.log('account owner email:\n');
  console.log(authUrl.toString());
  console.log('\nWaiting for callback…');
});

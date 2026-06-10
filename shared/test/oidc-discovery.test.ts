import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import {
  clearOidcDiscoveryCache,
  fetchOidcDiscovery,
} from '../src/oidc-discovery.js';

describe('oidc-discovery', () => {
  test('fetchOidcDiscovery parses provider endpoints', async () => {
    clearOidcDiscoveryCache();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input: RequestInfo | URL) => {
      const url = String(input);
      assert.ok(url.endsWith('/.well-known/openid-configuration'));
      return new Response(
        JSON.stringify({
          issuer: 'https://login.example.com',
          authorization_endpoint: 'https://login.example.com/oauth2/v1/authorize',
          token_endpoint: 'https://login.example.com/oauth2/v1/token',
          jwks_uri: 'https://login.example.com/oauth2/v1/keys',
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    };

    try {
      const doc = await fetchOidcDiscovery('https://login.example.com/');
      assert.equal(doc.authorization_endpoint, 'https://login.example.com/oauth2/v1/authorize');
      assert.equal(doc.token_endpoint, 'https://login.example.com/oauth2/v1/token');
      assert.equal(doc.jwks_uri, 'https://login.example.com/oauth2/v1/keys');
    } finally {
      globalThis.fetch = originalFetch;
      clearOidcDiscoveryCache('https://login.example.com');
    }
  });

  test('fetchOidcDiscovery caches per issuer', async () => {
    clearOidcDiscoveryCache();
    let fetches = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input: RequestInfo | URL) => {
      fetches++;
      const url = String(input);
      const issuer = url.includes('tenant-a') ? 'https://tenant-a.example.com' : 'https://tenant-b.example.com';
      return new Response(
        JSON.stringify({
          issuer,
          authorization_endpoint: `${issuer}/authorize`,
          token_endpoint: `${issuer}/token`,
          jwks_uri: `${issuer}/keys`,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    };

    try {
      await fetchOidcDiscovery('https://tenant-a.example.com');
      await fetchOidcDiscovery('https://tenant-b.example.com');
      await fetchOidcDiscovery('https://tenant-a.example.com');
      assert.equal(fetches, 2);
    } finally {
      globalThis.fetch = originalFetch;
      clearOidcDiscoveryCache();
    }
  });
});

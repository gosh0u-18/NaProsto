const { test } = require('node:test');
const assert = require('node:assert/strict');
const { withApp } = require('./helpers/server');

test('public server: health check works without AI or exposing settings', async () => {
  await withApp({}, async (base) => {
    const response = await fetch(`${base}/health`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { status: 'ok' });
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(response.headers.get('x-powered-by'), null);
  });
});

test('public server: private files and source code are not served as static content', async () => {
  await withApp({}, async (base) => {
    for (const file of ['.env', 'server.js', 'package.json', 'src/app.js', '.git/config']) {
      const response = await fetch(`${base}/${file}`);
      assert.equal(response.status, 404);
    }
  });
});

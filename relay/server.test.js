'use strict';

const assert = require('node:assert/strict');
const {test} = require('node:test');
const {constructUpstreamUrl, parseRelayPath} = require('./routes');

test('accepts only fixed relay routes', () => {
  assert.deepEqual(parseRelayPath('/mtproto/2/client'), {
    dcId: 2,
    connectionType: 'client',
    premium: false
  });
  assert.deepEqual(parseRelayPath('/mtproto/5/download/premium'), {
    dcId: 5,
    connectionType: 'download',
    premium: true
  });
  assert.equal(parseRelayPath('/mtproto/6/client'), undefined);
  assert.equal(parseRelayPath('/mtproto/2/https://example.com'), undefined);
});

test('maps routes to allowlisted Telegram WebSocket hosts', () => {
  assert.equal(constructUpstreamUrl({
    dcId: 2,
    connectionType: 'client',
    premium: false
  }), 'wss://kws2.web.telegram.org/apiws');
  assert.equal(constructUpstreamUrl({
    dcId: 4,
    connectionType: 'upload',
    premium: true
  }), 'wss://kws4-1.web.telegram.org/apiws_premium');
});

'use strict';

function parseRelayPath(requestUrl) {
  const {pathname} = new URL(requestUrl, 'http://relay.local');
  const match = pathname.match(/^\/mtproto\/([1-5])\/(client|download|upload)(?:\/(premium))?\/?$/);
  if(!match) {
    return;
  }

  return {
    dcId: Number(match[1]),
    connectionType: match[2],
    premium: match[3] === 'premium'
  };
}

function constructUpstreamUrl({dcId, connectionType, premium}) {
  const suffix = connectionType === 'client' ? '' : '-1';
  const path = connectionType === 'client' ? 'apiws' : `apiws${premium ? '_premium' : ''}`;
  return `wss://kws${dcId}${suffix}.web.telegram.org/${path}`;
}

module.exports = {
  constructUpstreamUrl,
  parseRelayPath
};

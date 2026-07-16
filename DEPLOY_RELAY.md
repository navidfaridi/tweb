# Docker deployment with the MTProto relay

This deployment serves Telegram Web K on `tweb.itext.ir` and routes its MTProto
WebSocket connections through `wss.itext.ir`.

## Cloudflare

Create proxied DNS records for both hostnames and configure:

- SSL/TLS encryption mode: **Full (strict)**
- Network -> WebSockets: **On**
- Cache rule for `wss.itext.ir/*`: **Bypass cache**
- Do not enable Argo for the relay hostname

The origin must only expose ports 80 and 443. Do not publish the relay port.
For stronger origin protection, restrict inbound 80/443 to Cloudflare IP ranges.

## Configuration

Copy the production environment example and adjust it if the public hostnames
are different:

```sh
cp .env.production.example .env.production
```

`RELAY_ALLOWED_ORIGINS` is a comma-separated allowlist. It must contain the
exact public origin that serves the web app. The default is
`https://tweb.itext.ir`.

## Start

```sh
docker compose --env-file .env.production up -d --build
docker compose ps
docker compose logs -f relay
```

Verify the two health endpoints:

```sh
curl --fail https://tweb.itext.ir/healthz
curl --fail https://wss.itext.ir/healthz
```

The production image is built with HTTP MTProto transport disabled. If the
relay is unavailable, the client retries the relay and does not fall back to a
direct Telegram HTTP or WebSocket endpoint.

## Upgrade

```sh
git pull
docker compose --env-file .env.production up -d --build
docker image prune -f
```

The relay accepts only DC IDs 1 through 5 and the fixed `client`, `download`,
and `upload` routes. It cannot be used as a general-purpose forward proxy.

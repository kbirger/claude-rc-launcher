# Reverse proxy

The hub serves the web UI and the API over plain HTTP on one port. Put a reverse proxy in front of it that terminates TLS. Serve the hub at the root of a host name. A path prefix such as `https://host/rc/` does not work.

The proxy must terminate TLS and forward the original `Host`. `X-Forwarded-*` headers are not used;
`public_url` must be the external https URL that
browsers use: the `Secure` cookie flag, the CSRF Origin check and the OIDC redirect URI all derive
from it. State-changing `/api` requests need `Content-Type: application/json` (415 otherwise) and are
rejected with 403 when an `Origin` header is present and does not match the origin of `public_url`
(a request with no `Origin` header is allowed).

Two routes are slow: `GET .../github/repos` and `POST .../github/login`. The repo list can take up to 120 seconds.
The login start can take up to 20 seconds. The hub waits up to 125 seconds for them. A reverse proxy in front of the
hub needs a read timeout of at least 125 seconds for those routes. The clone itself does not hold a request open.

## nginx

```nginx
server {
    listen 443 ssl;
    server_name rc.example.com;
    # ssl_certificate ... ;

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

## Traefik (dynamic file)

```yaml
http:
  routers:
    claude-rc:
      rule: Host(`rc.example.com`)
      entryPoints: [websecure]
      tls: {}
      service: claude-rc
  services:
    claude-rc:
      loadBalancer:
        servers:
          - url: http://127.0.0.1:8080
```

Traefik forwards `Host` and sets `X-Forwarded-Proto` by default. With Docker labels:

```yaml
labels:
  - traefik.enable=true
  - traefik.http.routers.claude-rc.rule=Host(`rc.example.com`)
  - traefik.http.routers.claude-rc.entrypoints=websecure
  - traefik.http.routers.claude-rc.tls=true
  - traefik.http.services.claude-rc.loadbalancer.server.port=8080
```

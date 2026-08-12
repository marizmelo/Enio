---
title: Remote access
layout: default
nav_order: 16
---

# Reaching the agent from anywhere

The agent's HTTP endpoint binds to `127.0.0.1:8787`. To use it from your phone or a laptop elsewhere, you need a way through NAT.

## Read this first

The `coder` agent has `run_command`. Anyone who can reach this endpoint **with the API key** can run shell commands as your user on the Mac mini. Treat the key like an SSH private key.

The endpoint requires a bearer token on every `/v1/*` request. Print it with:

```sh
enio token
enio token --rotate    # invalidate the old one
```

The token is a 32-byte random value in `~/.enio/token`, mode 0600, generated on first `serve`. Send it as `Authorization: Bearer <key>` — that's what an OpenAI-compatible client sends for its API key, so most tools work by pasting it into their existing "API key" field.

Auth is enforced even on loopback, deliberately. A web page you have open *can* issue requests to `127.0.0.1`, and origin checks aren't a real boundary against no-cors posts or DNS rebinding.

`/ping` is the one unauthenticated route. It returns `{"ok":true}` and nothing else — no tool count, no model, no version — so clients can check liveness before they have a key.

---

## How this problem is normally solved

Your mini sits behind NAT with no publicly reachable address. Chrome Remote Desktop and similar tools use **WebRTC**:

- **STUN** tells each peer what its address looks like from the outside. Both then transmit at once, punching a hole through both NATs — each side's outbound packet makes its router accept the other's inbound. Succeeds maybe 80–90% of the time.
- **TURN** relays traffic when that fails. Symmetric NAT and carrier-grade NAT assign a different port per destination, so the discovered mapping is useless to anyone else. A relay always works; it costs bandwidth and latency.
- **ICE** gathers every candidate path and picks the best one that connects.

There is always a cloud rendezvous server in the middle — before a peer-to-peer link exists, the two machines need somewhere to exchange candidates. "Works on any network" means a reliable third party plus fallbacks, not serverless magic.

You don't need to build any of that. Two options below do it for you.

---

## Option A — Tailscale (recommended)

WireGuard mesh with the same NAT-traversal ideas underneath: its coordination server for signaling, DERP relays as the TURN equivalent. Only your own devices can reach the mini, which means a compromised key alone isn't enough.

```sh
brew install --cask tailscale     # on the mini
tailscale up
tailscale ip -4                   # e.g. 100.x.y.z
```

Install Tailscale on your phone, sign in with the same account, then bind the agent to the tailnet interface:

```sh
ENIO_AGENT_HOST=0.0.0.0 enio serve
```

Point your client at `http://100.x.y.z:8787/v1` with the API key. With MagicDNS enabled it's `http://your-mini:8787/v1`.

Binding to `0.0.0.0` also exposes the port on your local LAN. If that matters, use Tailscale's ACLs to restrict which devices can reach it, or bind to the tailnet IP specifically: `ENIO_AGENT_HOST=100.x.y.z`.

## Option B — Cloudflare Tunnel

Different mechanism entirely: no hole punching. A daemon on the mini opens a persistent *outbound* connection to Cloudflare's edge and holds it open; inbound requests arrive at Cloudflare and ride back down it. Outbound is always allowed, so this works behind any NAT with no port opened. You need a domain on Cloudflare.

```sh
brew install cloudflared
cloudflared tunnel login
cloudflared tunnel create maple
cloudflared tunnel route dns maple maple.yourdomain.com
cloudflared tunnel run --url http://127.0.0.1:8787 maple
```

The agent stays on loopback — `cloudflared` reaches it locally. Your client uses `https://maple.yourdomain.com/v1`, with TLS terminated by Cloudflare.

**Add Cloudflare Access on top.** Without it the URL is publicly reachable and the API key is the only thing standing between the internet and shell execution. Access puts SSO in front, so an attacker needs to defeat both. Zero Trust → Access → Applications → self-hosted, pointing at that hostname.

## Option C — don't tunnel

If you only need it on your own LAN, `ENIO_AGENT_HOST=0.0.0.0` plus the API key is enough, and there's no third party involved at all.

---

## Client configuration

Any OpenAI-compatible client:

| | |
|---|---|
| Base URL | `http://100.x.y.z:8787/v1` or `https://maple.yourdomain.com/v1` |
| API key | output of `enio token` |
| Model | `enio` |

```sh
curl https://maple.yourdomain.com/v1/chat/completions \
  -H "Authorization: Bearer $(enio token)" \
  -H "Content-Type: application/json" \
  -d '{"model":"enio","messages":[{"role":"user","content":"hello"}]}'
```

## If something breaks

**401 on every request** — the key is wrong or missing. `enio token` prints the current one; it changes if you ever ran `--rotate` or deleted the data directory.

**Connection refused through the tunnel** — the agent is probably still on `127.0.0.1` while the tunnel points elsewhere. Cloudflare wants loopback (correct); Tailscale needs `ENIO_AGENT_HOST` set.

**Works on wifi, fails on cellular** — carrier-grade NAT defeating hole punching. Tailscale falls back to DERP relays automatically; if it doesn't, check `tailscale netcheck`.

**Streaming stalls mid-response** — a proxy buffering SSE. Cloudflare handles `text/event-stream` correctly by default; a proxy in between may not.

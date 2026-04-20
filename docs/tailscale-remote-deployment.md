# Tailscale Remote Deployment Guide

Practical guide for running claude-mem in **client/proxy mode** across multiple machines where at least one endpoint roams off the primary LAN (laptop use, travel, coworking). Based on a 3-Mac deployment (1 pivot server + 2 client laptops) using Tailscale as the transport.

This guide complements `production-guide.md` (single-host tuning) with multi-machine concerns: hostname resolution, config reload semantics, launcher collisions, and buffered request recovery.

## When you need this guide

You are running claude-mem in multi-node mode with:
- `CLAUDE_MEM_NETWORK_MODE = "server"` on one host (the pivot)
- `CLAUDE_MEM_NETWORK_MODE = "client"` on one or more other hosts (the proxies)
- At least one client is a laptop that leaves the server's LAN

If all machines live on the same LAN 24/7, you can stay on Bonjour `.local` hostnames and stop reading.

## Choosing `CLAUDE_MEM_SERVER_HOST`

Four strategies exist for pointing the client at the server:

| Strategy | Example | LAN | Roaming | Verdict |
|----------|---------|-----|---------|---------|
| Bonjour mDNS | `myserver.local` | works | **fails** — mDNS is LAN-scope | Avoid for laptops |
| Literal LAN IP | `192.168.1.20` | works | fails | Avoid for laptops |
| Literal Tailscale IP | `100.89.27.102` | works | works | Brittle — breaks if Tailscale rotates the IP |
| **Tailscale MagicDNS hostname** | `myserver` (no suffix) | **works** | **works** | **Recommended** |

MagicDNS resolution works because every Tailscale-enabled host queries `100.100.100.100` (Tailscale's DNS server) which answers for peer hostnames in both LAN and roaming contexts. No mDNS, no IP pinning, no rotation risk.

Verify your machine can use MagicDNS:

```bash
scutil --dns | grep -E "nameserver|search domain" | head -4
# Expect: nameserver[0] : 100.100.100.100
#         search domain[0] : <your-tailnet>.ts.net
```

Then point the client at the MagicDNS hostname:

```bash
# On the client
jq '.CLAUDE_MEM_SERVER_HOST = "myserver"' ~/.claude-mem/settings.json \
  > ~/.claude-mem/settings.json.tmp && mv ~/.claude-mem/settings.json.tmp ~/.claude-mem/settings.json
```

## Gotcha #1: settings changes require proxy restart

The proxy reads `~/.claude-mem/settings.json` **once at startup** and caches the values in memory. Editing `CLAUDE_MEM_SERVER_HOST` (or any other proxy field) has no effect until the proxy restarts.

Detection — compare runtime vs on-disk:

```bash
RUNTIME=$(curl -s http://127.0.0.1:37777/api/health | jq -r '.serverHost // empty')
ONDISK=$(jq -r '.CLAUDE_MEM_SERVER_HOST // empty' ~/.claude-mem/settings.json)
if [ -n "$RUNTIME" ] && [ "$RUNTIME" != "$ONDISK" ]; then
  echo "Stale proxy config: runtime=$RUNTIME but settings.json=$ONDISK — restart required"
fi
```

Apply by restarting the launcher (see gotcha #2 for the right launcher).

**Upstream improvement** (tracked as a TODO in this document): watch `settings.json` and hot-reload non-sensitive fields (`CLAUDE_MEM_SERVER_HOST`, `CLAUDE_MEM_SERVER_PORT`, `CLAUDE_MEM_AUTH_TOKEN`) without a restart.

## Gotcha #2: one launcher only — screen vs launchd

Historical install scripts on macOS sometimes started the proxy inside `screen -dmS claude-mem-proxy node scripts/proxy-service.cjs`. Later, `~/Library/LaunchAgents/com.claude-mem.proxy.plist` may have been added for KeepAlive reliability. Both mechanisms then try to own port `37777`.

Symptoms of the collision:
- `launchctl list | grep claude-mem.proxy` shows the agent in perpetual `exit 1`
- `screen -ls` shows a detached `claude-mem-proxy` session owning the port
- Restarting via `launchctl kickstart` has no effect (port still held by screen)

Pick one launcher. The recommended setup is launchd alone:

```bash
# Kill any legacy screen-managed proxy
screen -S claude-mem-proxy -X quit 2>/dev/null
rm -f ~/.claude-mem/worker.pid

# Start under launchd
launchctl load ~/Library/LaunchAgents/com.claude-mem.proxy.plist 2>/dev/null || true
launchctl kickstart -k gui/$(id -u)/com.claude-mem.proxy

# Verify
sleep 3
curl -s http://127.0.0.1:37777/api/health | jq '{serverReachable, serverHost, pendingBuffer}'
```

## Gotcha #3: the offline buffer and head-of-queue poison pills

When the server is unreachable, the proxy buffers `POST`/`PUT`/`PATCH` requests to `~/.claude-mem/buffer.jsonl`. When the server returns, the proxy replays them in order.

The replay loop breaks on the first non-2xx response:

```js
for (const entry of entries) { if (!await send(entry)) break; }
```

One permanently-failing request at the head of the queue halts replay for every request behind it. We have observed this with `POST /api/admin/shutdown` calls buffered during a prior troubleshooting session: 3 days later the user comes back online and 147 legitimate session observations can never drain because 2 stale shutdown calls sit in front of them.

### Recovery — selective purge

```bash
# 1. Inspect the head-of-queue
head -3 ~/.claude-mem/buffer.jsonl | jq -c '{ts, method, path}'

# 2. See what is stuck
jq -r '.path' ~/.claude-mem/buffer.jsonl | sort | uniq -c | sort -rn

# 3. Backup then drop the offending path(s)
cp ~/.claude-mem/buffer.jsonl ~/.claude-mem/buffer.jsonl.bak-$(date +%Y%m%d-%H%M%S)
jq -c 'select(.path != "/api/admin/shutdown")' ~/.claude-mem/buffer.jsonl \
  > ~/.claude-mem/buffer.jsonl.tmp && mv ~/.claude-mem/buffer.jsonl.tmp ~/.claude-mem/buffer.jsonl

# 4. Wait one health-check cycle (~10s)
sleep 15
curl -s http://127.0.0.1:37777/api/health | jq '{pendingBuffer}'
```

The legitimate observations, session inits, summaries, and completions drain on the next `setInterval` tick.

**Upstream improvement** (tracked as a TODO in this document): filter out `/api/admin/*` paths at buffer-append time — admin calls are time-sensitive and should never be replayed after a context switch.

## Health-check cheat sheet

```bash
# Full roaming readiness
echo "--- DNS ---"
scutil --dns | grep -m1 "nameserver\[0\] : 100.100.100.100" \
  && echo "MagicDNS reachable" || echo "MagicDNS NOT active — check Tailscale"

echo "--- Resolution ---"
HOST=$(jq -r '.CLAUDE_MEM_SERVER_HOST' ~/.claude-mem/settings.json)
PORT=$(jq -r '.CLAUDE_MEM_SERVER_PORT // "37777"' ~/.claude-mem/settings.json)
nc -z -G 3 "$HOST" "$PORT" && echo "TCP $HOST:$PORT OK" || echo "TCP $HOST:$PORT KO"

echo "--- Proxy runtime ---"
curl -s --max-time 3 http://127.0.0.1:37777/api/health \
  | jq '{serverReachable, serverHost, pendingBuffer}'

echo "--- Launcher unicity ---"
LD=$(launchctl list 2>/dev/null | grep -c com.claude-mem.proxy)
SC=$(screen -ls 2>/dev/null | grep -c claude-mem-proxy)
[ $((LD + SC)) -le 1 ] && echo "One launcher: OK" || echo "Multiple launchers: COLLISION — see Gotcha #2"

echo "--- Config freshness ---"
RT=$(curl -s http://127.0.0.1:37777/api/health | jq -r '.serverHost // empty')
OD=$(jq -r '.CLAUDE_MEM_SERVER_HOST // empty' ~/.claude-mem/settings.json)
[ "$RT" = "$OD" ] && echo "Runtime matches settings.json: OK" \
  || echo "STALE — runtime=$RT, settings.json=$OD — restart proxy"
```

## Proposed upstream improvements

Two defensive changes would close the two gotchas above at the source. Filed here as a discussion starter before splitting into dedicated PRs.

1. **Settings hot-reload for proxy fields.** Watch `settings.json` (`fs.watch` or polling) and apply `CLAUDE_MEM_SERVER_HOST`, `CLAUDE_MEM_SERVER_PORT`, `CLAUDE_MEM_AUTH_TOKEN` changes without restart. Other fields still require a restart.

2. **Admin path denylist at buffer-append time.** In `scripts/proxy-service.cjs`, where the proxy appends failed writes to `buffer.jsonl`, skip `/api/admin/*` (and any path matching a configurable `CLAUDE_MEM_BUFFER_DENYLIST`). Admin calls are time-sensitive — better to drop than to poison the queue.

Neither change is strictly required: this guide documents the workarounds. But both would remove a class of silent failures that currently requires reading logs and running jq scripts to diagnose.

---

*Based on field experience across a 3-Mac deployment (MacStudio pivot + 2 laptops) using Tailscale MagicDNS, Unison for file sync, and claude-mem v12.1.0 multi-node mode.*

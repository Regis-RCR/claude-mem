# Multi-Node Deployment Runbook

## Architecture

```
MSM4M (client, dev principale)  ──TB5──►  MSM3U (server, pivot)
  localhost:37777 (proxy)                   0.0.0.0:37777 (worker)
  mode: client                              mode: server
```

## Pre-Deployment Checklist

Before deploying ANY change to the multi-node stack:

- [ ] `npm run build` passes on the dev machine
- [ ] `npm test` — verify no NEW test failures (compare to baseline)
- [ ] `git status` — working tree clean, no uncommitted artifacts

## Deployment Sequence (mandatory order)

### 1. Build and deploy locally (MSM4M)

```bash
npm run build-and-sync
```

This builds, syncs to `~/.claude/plugins/marketplaces/thedotmack/`, and restarts the local worker.

**Gotcha:** In client mode, `build-and-sync` restart may fail with 403 (the proxy can't restart the remote server). This is expected. The local proxy needs a manual restart:

```bash
kill $(lsof -ti :37777) 2>/dev/null
sleep 2
bun ~/.claude/plugins/marketplaces/thedotmack/plugin/scripts/worker-service.cjs start
```

### 2. Sync code to MSM3U (server)

```bash
~/.local/share/unison/bin/unison-sync.sh apply --remote MSM3U --path GitHub/thedotmack/claude-mem
```

### 3. Install deps + build on MSM3U

```bash
ssh MSM3U "PATH=/opt/homebrew/bin:\$HOME/.bun/bin:\$PATH; cd ~/Development/GitHub/thedotmack/claude-mem && npm install && npm run build-and-sync"
```

**Gotcha:** New npm dependencies (e.g., `@clack/prompts` after upstream merge) must be installed on MSM3U too. The sync copies `package.json` but not `node_modules/`.

### 4. Restart server worker on MSM3U

If `build-and-sync` restart doesn't take effect (old PID still running):

```bash
ssh MSM3U "kill \$(lsof -ti :37777) 2>/dev/null; sleep 2; PATH=/opt/homebrew/bin:\$HOME/.bun/bin:\$PATH; bun ~/.claude/plugins/marketplaces/thedotmack/plugin/scripts/worker-service.cjs start"
```

### 5. Restart local proxy (MSM4M)

```bash
kill $(lsof -ti :37777) 2>/dev/null
sleep 2
bun ~/.claude/plugins/marketplaces/thedotmack/plugin/scripts/worker-service.cjs start
```

## Post-Deployment Verification

### Health check (both machines)

```bash
# Local proxy health
curl -s http://localhost:37777/api/health | python3 -m json.tool

# Expected fields:
# proxyVersion, proxyCommit  — local build identity
# serverVersion, serverCommit — remote server identity (populated after first health poll ~10s)
# versionMatch: true — semver versions match
```

```bash
# Server health (direct)
ssh MSM3U "curl -s http://localhost:37777/api/health" | python3 -m json.tool

# Expected: version, commit, mode: "server"
```

### Version alignment

Wait 10-15 seconds after proxy restart for the health poll to cache server info:

```bash
sleep 12
curl -s http://localhost:37777/api/health | python3 -c "
import json, sys
d = json.load(sys.stdin)
print(f'Proxy:  v{d.get(\"proxyVersion\",\"?\")} ({d.get(\"proxyCommit\",\"?\")})')
print(f'Server: v{d.get(\"serverVersion\",\"?\")} ({d.get(\"serverCommit\",\"?\")})')
print(f'Match:  {d.get(\"versionMatch\",\"?\")}')
"
```

**Note:** `versionMatch` compares semver versions, not commits. Different commits with same version = OK (separate builds from different git states).

### SSE stream verification

```bash
perl -e 'alarm 8; exec @ARGV' -- curl -s -N -H 'Accept: text/event-stream' http://localhost:37777/stream | head -10
```

Expected: `initial_load` event with `projects` array (should have 20+ projects if DB is populated).

### Observation flow verification

After deploying and restarting, observations may not flow until the **next Claude Code session**. This is because:
- The `SessionStart` hook registers the session with the server
- If the worker restarts mid-session, the current session's SDK generator is lost
- New tool uses will create pending messages but the generator won't process them

**Fix:** Start a new Claude Code session (or `/clear` + restart) after deployment.

To verify observations are flowing:

```bash
# Check pending queue
ssh MSM3U "sqlite3 ~/.claude-mem/claude-mem.db 'SELECT COUNT(*) FROM pending_messages;'"
# Should be 0 or growing briefly then shrinking

# Check latest observations
ssh MSM3U "sqlite3 ~/.claude-mem/claude-mem.db 'SELECT id, datetime(created_at_epoch/1000, \"unixepoch\", \"localtime\") as dt, substr(title,1,60) FROM observations ORDER BY id DESC LIMIT 3;'"
```

### CORS verification (server mode)

```bash
# Test from LAN IP origin (should succeed in server mode)
ssh MSM3U "curl -s -H 'Origin: http://169.254.1.3:37777' http://localhost:37777/api/health"
# Should return JSON, not CORS error
```

### Viewer UI verification

Open `http://localhost:37777` in browser:
- [ ] Mode badge shows version + commit hash (e.g., `v12.1.0 (fbcab13)`)
- [ ] Click mode badge → topology panel expands
- [ ] Topology shows both proxy and server versions/commits
- [ ] Project dropdown populated (not empty)
- [ ] Observations appear in timeline

## Known Issues

### Pending messages queue bloat

If the SDK generator crashes or gets stuck, pending messages accumulate. The queue blocks processing. To diagnose and clear:

```bash
# Check queue depth
ssh MSM3U "sqlite3 ~/.claude-mem/claude-mem.db 'SELECT COUNT(*) FROM pending_messages;'"

# If stale (hundreds of old messages), clear:
ssh MSM3U "sqlite3 ~/.claude-mem/claude-mem.db 'DELETE FROM pending_messages WHERE created_at_epoch < $(python3 -c \"import time; print(int((time.time() - 86400) * 1000))\");'"
```

### Migration numbering

Our provenance migrations are numbered **27 and 28** (not 24/25) to avoid collision with upstream migrations 24-26. If a DB was created with the old numbering, the migrations are idempotent (per-column checks) and will self-heal.

### Build on MSM3U — PATH issues

SSH non-interactive sessions don't have Homebrew in PATH. Always prefix:
```bash
PATH=/opt/homebrew/bin:$HOME/.bun/bin:$PATH
```

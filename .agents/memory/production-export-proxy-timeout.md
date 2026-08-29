---
name: Production export proxy timeout
description: Safety rule for long-running dashboard exports through the public production proxy.
---

Production dashboard export requests can be aborted by the public proxy after about 300 seconds even though the server-side handler and export run may continue.

**Why:** A synchronous Google + Meta export exceeded the proxy window. The client received no response, while the persisted export run remained active and production logs showed continued work followed by database authentication timeouts.

**How to apply:** Never retry a timed-out export request. First inspect the existing production `sync_runs` row and deployment logs read-only; treat a non-terminal run as the one active attempt.
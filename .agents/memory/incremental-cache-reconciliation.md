---
name: Incremental cache reconciliation
description: Safety rules for rebuilding public language feeds after an incremental cache mismatch.
---

Rule: a full reconciliation after cache/snapshot parity fails must rebuild the feed-item cache authoritatively for every channel, including removing stale rows before rebuilding it. A publication blocked by a feed safety gate must remain retryable rather than being terminally acknowledged.

**Why:** full exporters may construct public files without persisting their channel's cache rows, and they cannot remove cached rows left by missed product or variant deletions. Either gap prevents cache parity and risks catalog omissions. A gate intentionally keeps the last complete public catalog, so its triggering Shopify event needs another chance after the underlying condition changes.

**How to apply:** preserve the shared export lock; clear the cache only inside the locked full-reconciliation path, explicitly reconstruct any channel cache that its public exporter does not persist, then prove every rebuilt cache matches its public URL snapshots before accepting the webhook. Treat gate-block errors separately from ordinary transient errors in retry handling.
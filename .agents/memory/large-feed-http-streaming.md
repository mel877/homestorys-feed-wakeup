---
name: Large feed HTTP streaming
description: Reliability rules for serving very large current feed objects over stable HTTP URLs.
---

Serve large feed files with backpressure instead of buffering them, and pin the body read to the same object generation that supplied its metadata and content length. Observe client disconnects before awaiting metadata as well as during body transfer.

**Why:** Feed objects can be several hundred megabytes. Full buffering causes memory pressure, while reading metadata and body from different mutable generations can produce an incorrect content length. A client may also disconnect while metadata is still loading, before the body stream exists.

**How to apply:** For stable public feed URLs, fetch metadata first, open the exact generation, stream progressively, distinguish storage errors from client aborts, and destroy any source stream created after the response has already closed.
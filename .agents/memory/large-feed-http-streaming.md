---
name: Large feed HTTP streaming
description: Reliability rules for serving very large current feed objects over stable HTTP URLs.
---

Serve large feed files with backpressure instead of buffering them, and pin the body read to the same object generation that supplied its metadata. Observe client disconnects before awaiting metadata as well as during body transfer. On the published frontend, advertise `Content-Length` only up to 32 MiB; larger responses must use progressive transfer and expose the expected size separately as `X-Feed-Size`.

**Why:** Feed objects can be several hundred megabytes. Full buffering causes memory pressure, while reading metadata and body from different mutable generations can mismatch the response. Production testing showed that Google Frontend returned an empty 500 for 64–486 MiB dynamic responses when their full `Content-Length` was announced, even though Express had started a 200 response. A client may also disconnect while metadata is still loading, before the body stream exists.

**How to apply:** For stable public feed URLs, fetch metadata first, open the exact generation, stream progressively, distinguish storage errors from client aborts, and destroy any source stream created after the response has already closed. Keep `Content-Length` for small files; use chunked/progressive transfer plus `X-Feed-Size` for files above 32 MiB.
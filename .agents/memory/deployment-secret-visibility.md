---
name: Deployment secret visibility
description: The live deployment can receive a secret that is not exposed to the agent's local shell or environment inspection.
---

A deployment secret can be active in the published Autoscale process while remaining unavailable to the agent's local execution environment and secret-inspection callbacks.

**Why:** The live endpoint returned an authentication response proving its middleware had a configured secret, while local execution had no `INTERNAL_API_SECRET` value available for safely constructing a request.

**How to apply:** Do not infer that a deployment secret is absent from the live process based only on local environment access. Do not attempt an authenticated production request unless a safe, non-disclosing mechanism supplies the credential.
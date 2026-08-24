---
name: Artifact production working directory
description: How to make workspace configuration loading reliable in artifact production.
---

Artifact production commands may start from the workspace root, whereas local package commands start from the package directory. Required workspace configuration must therefore be resolved from verified candidate locations (or an explicit override), not only from `process.cwd()` with a package-relative traversal.

**Why:** A production startup can otherwise fail before opening its HTTP port because it searches for `config/` in the wrong parent directory; the deployment health check then reports only a generic 500/port-readiness failure.

**How to apply:** Keep the explicit `CONFIG_DIR` override for controlled environments. For the default path, prefer a directory whose required config file exists, considering both runtime working-directory and bundled-module locations. Validate the production run command from the workspace root and request its health endpoint after changes to startup or config resolution.
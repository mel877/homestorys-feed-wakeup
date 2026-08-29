---
name: Production migration baseline
description: Safe migration path while the production schema has no Drizzle migration journal.
---

Do not run the normal Drizzle migrator against production until its migration history has been deliberately baselined against the actual schema. Apply durable-feed additions through a reviewed, narrowly scoped Publish schema diff.

**Why:** Production already has the initial schema but no `drizzle.__drizzle_migrations` journal. A normal migrator would treat the entire history, including the initial schema migration, as unapplied.

**How to apply:** Review the Publish SQL so it only adds the durable feed tables, foreign keys, indexes, and snapshot-current uniqueness guard. Abort on duplicate current snapshots rather than repairing them automatically. Reconcile migration tracking separately before any future automated production migration.
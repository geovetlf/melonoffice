# @melonoffice/firestore

Every Firestore repository, shared by the API and the worker ([ADR-0030](../../docs/adr/0030-execution-jobs-and-lease.md)): users, tenancy, billing, credits, audit, departments, specialists, executions, jobs, approvals, plans and workflows. Each implements a port defined in its domain package, which never depends on Firestore. Server only, with no HTTP.

`@melonoffice/firestore/testing` gives tests a client for a fresh emulator project. Tests run against the official emulator (`FIRESTORE_EMULATOR_HOST`); CI requires it.

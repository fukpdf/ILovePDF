---
name: Native addon compatibility
description: Compatibility checks for imported Node apps with native modules in this workspace.
---

For imported Node apps, match native modules to the workspace's Node runtime and explicitly allow only the required install scripts in pnpm's build-script policy. A native binding that targets an older Node/V8 can fail to compile even when package installation otherwise succeeds.

**Why:** This workspace runs Node 24, and pnpm blocks dependency build scripts unless approved.

**How to apply:** Check package engine ranges before installation, then verify native modules with a minimal load/query before starting the app. Prefer updating an incompatible native dependency over changing the whole workspace runtime.

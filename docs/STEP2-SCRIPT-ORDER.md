# Step 2 — Homepage critical path (script order)

## Problem
`defer` scripts run **in order**. Previously ~20 runtime/shield/worker scripts ran **before** `chrome.js` / `home.js`, so `TOOL_GROUPS` and tool cards waited on unrelated work.

## Fix
Load in this order:

1. `config.js`
2. `i18n.js` + bridges
3. `chrome.js` → defines `TOOL_GROUPS`
4. `home.js` + `home-fast-boot.js` → paint tool cards
5. `n2w`, `auth-ui`, Lucide
6. **Then** runtime-shield / worker / analytics stack

## Effect
- Tool cards no longer wait on worker-factory, wasm-registry, shield chain, etc.
- Tool **engines on tool pages are unchanged** (those pages keep their own scripts)
- Design/theme unchanged

## Apply
Replace the bottom script block in `public/index.html` (from `config.js` through `site-announcement.js`) with the contents of the Step-2 block committed in the follow-up change, or paste from the agent-provided `index_script_block_step2.txt`.

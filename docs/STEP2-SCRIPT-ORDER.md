# Step 2 — Homepage critical path (script order)

## Problem
`defer` scripts run **in order**. Previously ~20 runtime/shield/worker scripts ran **before** `chrome.js` / `home.js`, so `TOOL_GROUPS` and tool cards waited on unrelated work.

## Fix order
1. `config.js`
2. `i18n.js` + bridges
3. `chrome.js` → defines `TOOL_GROUPS`
4. `home.js` + `home-fast-boot.js` → paint tool cards
5. `n2w`, `auth-ui`, Lucide
6. **Then** runtime-shield / worker / analytics stack

## Copy-paste links (GitHub)

### OLD (working, pre-Step-2) — full `index.html`
- Blob: https://github.com/fukpdf/ILovePDF/blob/4aec4ac78140920bb76559fc630f45d038ed5e77/public/index.html
- Raw (download/copy): https://raw.githubusercontent.com/fukpdf/ILovePDF/4aec4ac78140920bb76559fc630f45d038ed5e77/public/index.html

### NEW (Step-2) — script block only (paste into bottom of `public/index.html`)
- Blob: https://github.com/fukpdf/ILovePDF/blob/main/docs/step2/STEP2_SCRIPT_BLOCK.txt
- Raw: https://raw.githubusercontent.com/fukpdf/ILovePDF/main/docs/step2/STEP2_SCRIPT_BLOCK.txt

**How to apply NEW:**
1. Open current `public/index.html` (or restore from OLD link first if homepage is broken)
2. Find block from `<script src="/js/config.js"` through `site-announcement.js`
3. Replace that whole block with contents of `STEP2_SCRIPT_BLOCK.txt`
4. Commit + Firebase deploy + Cloudflare purge

### NEW (Step-2) — chunks + loader (already on main)
- Chunks: https://github.com/fukpdf/ILovePDF/tree/main/public/index-chunks
- Loader: https://github.com/fukpdf/ILovePDF/blob/main/public/index.html

## Effect
- Tool cards no longer wait on worker-factory, wasm-registry, shield chain
- Tool engines on tool pages unchanged
- Design/theme unchanged

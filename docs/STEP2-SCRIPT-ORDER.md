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

---

## Copy-paste links (GitHub)

### 1) OLD — working full `index.html` (pre-Step-2)
Baseline if homepage is broken or you want a clean start.

| Type | URL |
|------|-----|
| **View** | https://github.com/fukpdf/ILovePDF/blob/4aec4ac78140920bb76559fc630f45d038ed5e77/public/index.html |
| **Raw (copy/download)** | https://raw.githubusercontent.com/fukpdf/ILovePDF/4aec4ac78140920bb76559fc630f45d038ed5e77/public/index.html |

### 2) NEW — script block only (recommended)
Paste over the bottom script section of `public/index.html`.

| Type | URL |
|------|-----|
| **View** | https://github.com/fukpdf/ILovePDF/blob/main/docs/step2/STEP2_SCRIPT_BLOCK.txt |
| **Raw (copy/download)** | https://raw.githubusercontent.com/fukpdf/ILovePDF/main/docs/step2/STEP2_SCRIPT_BLOCK.txt |

**How to apply:**
1. Open **OLD raw** → copy full file → save as `public/index.html` (restore if needed)
2. Open **NEW script-block raw** → copy all
3. In `public/index.html`, select from `<script src="/js/config.js"` through `site-announcement.js`
4. Paste NEW block over that selection
5. Commit → **Firebase deploy** → **Cloudflare purge** (`/`, `/index.html`, `/js/home.js`)

### 3) NEW — chunks + loader (already on `main`)
Large-file workaround. Loader fetches `z0..z3.b64` and writes full HTML.

| Item | URL |
|------|-----|
| Loader | https://github.com/fukpdf/ILovePDF/blob/main/public/index.html |
| Chunks | https://github.com/fukpdf/ILovePDF/tree/main/public/index-chunks |

Prefer method **2** for production once you can upload the full `index.html`.

---

## Effect
- Tool cards no longer wait on worker-factory / wasm-registry / shield chain
- Tool engines on tool pages unchanged
- Design / theme unchanged

## Status
- **Step-1** (`home.js` 16ms poll): in repo
- **Step-2** (script order): script block + chunks on `main`
- **Live**: needs Firebase deploy + Cloudflare purge after you apply method 2

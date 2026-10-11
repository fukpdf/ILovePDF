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

## Production path (automatic)

On every **Deploy Project** workflow:

1. `node scripts/assemble-homepage-index.js` rebuilds full `public/index.html` from `public/index-chunks/z0..z3.b64`
2. Firebase Hosting deploys that **full** HTML (not the runtime loader)
3. Smoke checks verify `home-fast-boot` + chrome-before-runtime order

| Item | URL |
|------|-----|
| Assemble script | https://github.com/fukpdf/ILovePDF/blob/main/scripts/assemble-homepage-index.js |
| Chunks | https://github.com/fukpdf/ILovePDF/tree/main/public/index-chunks |
| Deploy workflow | https://github.com/fukpdf/ILovePDF/blob/main/.github/workflows/deploy.yml |

**You only need:** Actions → **Deploy Project** → Run workflow → Cloudflare purge after success.

---

## Copy-paste links (manual fallback)

### 1) OLD — working full `index.html` (pre-Step-2)

| Type | URL |
|------|-----|
| **View** | https://github.com/fukpdf/ILovePDF/blob/4aec4ac78140920bb76559fc630f45d038ed5e77/public/index.html |
| **Raw** | https://raw.githubusercontent.com/fukpdf/ILovePDF/4aec4ac78140920bb76559fc630f45d038ed5e77/public/index.html |

### 2) NEW — script block only

| Type | URL |
|------|-----|
| **View** | https://github.com/fukpdf/ILovePDF/blob/main/docs/step2/STEP2_SCRIPT_BLOCK.txt |
| **Raw** | https://raw.githubusercontent.com/fukpdf/ILovePDF/main/docs/step2/STEP2_SCRIPT_BLOCK.txt |

Replace in `public/index.html` the block from `<script src="/js/config.js"` through `site-announcement.js`.

---

## Effect
- Tool cards no longer wait on worker-factory / wasm-registry / shield chain
- Tool engines on tool pages unchanged
- Design / theme unchanged

## Status checklist

| Step | Status |
|------|--------|
| Step-1 `home.js` 16ms poll + early boot | Done (repo) |
| Step-2 script order (chrome/home first) | Done (chunks + assemble) |
| CI assemble before Firebase | Done |
| Smoke: home-fast-boot + order | Done |
| Live Firebase deploy | **Run Actions → Deploy Project** |
| Cloudflare cache purge | After deploy succeeds |

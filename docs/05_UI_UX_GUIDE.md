# 05 — UI/UX GUIDE

## Theme

ILovePDF uses a **purple-gradient brand** with clean white cards and subtle shadows.

| Token | Value | Usage |
|-------|-------|-------|
| Primary | `#6c3bd5` / `#8b5cf6` | Buttons, active states, hero gradient |
| Primary dark | `#4c1d95` | Hover states |
| Accent red | `#E5322E` | "Organize PDFs" category color |
| Success | `#10b981` | Compress category, success states |
| Warning | `#f59e0b` | Convert-from-PDF category |
| Text primary | `#1a1a2e` | Headings |
| Text secondary | `#64748b` | Body, descriptions |
| Surface | `#ffffff` | Card backgrounds |
| Background | `#f8fafc` | Page background |
| Border | `#e2e8f0` | Card borders, dividers |

Font: System font stack (`-apple-system, BlinkMacSystemFont, 'Segoe UI', ...`)

---

## Navigation

**Top navigation bar** (`nav.site-nav`):
- Logo left (ILovePDF wordmark with purple `P`)
- Tool dropdowns: "Merge PDF", "Split PDF", "Organize ▾", "Convert ▾", "All Tools ▾"
- Auth chip right: profile avatar + name (if logged in) or "Sign Up / Log In" buttons
- Responsive: hamburger menu on mobile

**Breadcrumbs**: Shown on all tool pages
```
All Tools › Category › Tool Name
```
Matches BreadcrumbList JSON-LD exactly.

---

## Cards

### Tool Cards (Homepage grid)
```
┌────────────────────────┐
│  [Icon]                │
│  Tool Name             │
│  Short description     │
│  [Category badge]      │
└────────────────────────┘
```
- Hover: shadow lifts, slight scale
- Click: navigates to `/:slug`
- Color-coded left border by category

### File Cards (Upload step)
```
┌─────────────────────────────┐
│ [Thumb] Filename.pdf  ✕     │
│         1.2 MB              │
│         [Rotate btn]        │
└─────────────────────────────┘
```
- Thumbnail: PDF first-page preview (rendered async), or image preview, or generic icon
- Rotate button: calls `rotateFile(index)` → updates `selectedFiles[i].rotation` → syncs dropdown
- Remove button: `removeFile(index)` → removes from `selectedFiles[]`

### Status Cards (Download step)

**Success state**:
```
┌─────────────────────────────┐
│  ✓  Your file is ready      │
│     Click Download below    │
│  [↓ Download]               │
│  [Process another file]     │
└─────────────────────────────┘
```

**Error state**:
```
┌─────────────────────────────┐
│  ⚠  Error title             │
│     Error message           │
│  [Try again]                │
└─────────────────────────────┘
```

---

## Page Organizer Grid

Shown inside the tool panel when a single PDF is uploaded to a PAGE_LEVEL_TOOL.

```
[Rotate All ↻]  [Reset ↺]

┌───────┐  ┌───────┐  ┌───────┐
│ Page 1 │  │ Page 2 │  │ Page 3 │
│ thumb  │  │ thumb  │  │ thumb  │
│  0°    │  │  90°   │  │  0°    │
│ [↻][✕] │  │ [↻][✕] │  │ [↻][✕] │
└───────┘  └───────┘  └───────┘
```

- Drag-and-drop to reorder (mouse drag / touch long-press)
- Arrow keys to reorder (keyboard accessible)
- `R` key to rotate current focused tile
- Delete/Backspace to delete current tile
- Rotation angle badge shows current rotation (0°/90°/180°/270°)
- Tile border highlights during drag

---

## Tool Options Sidebar

Rendered from `tool.options[]` in `tools-config.js`.

Option types:
- `select`: `<select>` dropdown (e.g., rotation degrees, compression level)
- `text`: `<input type="text">` (e.g., page range "1-3, 5")
- `number`: `<input type="number">` (e.g., crop percentage)

All rendered with `id="opt-{option.id}"`. Values read at process time.

---

## Upload Zone

Large drag-drop target:
```
        ↑
   [Upload icon]
   [Upload File]  button
   or drag & drop your PDF here
   Accepted: .pdf · Max 100 MB
```

- Drag-over: border changes to primary color
- Multiple files: shown when `tool.multipleFiles: true`
- After upload: transitions to file list + options

---

## Processing Overlay

Full-page overlay while processing:
```
┌─────────────────────────────┐
│         [Spinner]           │
│   Processing your file…     │
│   This usually takes only   │
│   a few seconds.            │
│         [Cancel]            │
└─────────────────────────────┘
```
- Progress percentage shown (0→100%)
- Cancel button dispatches `RuntimeCancellation` token
- After 90 seconds: soft warning message appears (not a timeout, just UX)

---

## Layout Variants

### Standard Tool Page
```
[Nav]
[Breadcrumbs]
[Tool Header: Icon + Title + Description]
[Step Tabs: Upload / Preview / Download]
[Upload Zone / File List + Options sidebar]
[Process button]
[Status card (after processing)]
[Tool Description block: H1, intro, FAQ, HowTo]
[Related tools]
[Footer]
```

### Standalone Utility Page
```
[Nav]
[Tool Header]
[Custom UI (no upload zone)]
[Custom tool content]
[Footer]
```

### Blog Article Page
```
[Nav]
[Breadcrumbs]
[Article header: title, date, read time]
[Article body: H2/H3/p/ul/ol sections]
[Related tools CTA]
[FAQ section]
[Footer]
```

---

## Auth Modal

Two-panel modal:
```
┌─────────────────────────────┐
│  Log In  │  Sign Up         │
├──────────────────────────────┤
│  Email ____________________  │
│  Password __________________  │
│  [Log In / Sign Up button]   │
│                              │
│  ─── or ───                  │
│  [Google Sign-In] (if Firebase) │
│                              │
│  [Forgot password?]          │
└─────────────────────────────┘
```

Injected by `auth-ui.js` on every page. Profile chip shown when authenticated.

---

## Cookie Consent Banner

```
┌─────────────────────────────────────────────────────┐
│ 🍪 We use cookies to improve your experience on    │
│    ILovePDF. By using ILovePDF you agree to our    │
│    Privacy Policy. Files are deleted automatically │
│    within seconds after processing.                │
│                         [Accept]  [Learn More]     │
└─────────────────────────────────────────────────────┘
```

Shown on first visit. Dismissed via `Accept` button. State stored in `localStorage`.

---

## Responsive Breakpoints

| Breakpoint | Behavior |
|-----------|---------|
| < 640px (mobile) | Single column, hamburger nav, full-width cards |
| 640-1024px (tablet) | 2-column tool grid |
| > 1024px (desktop) | 3-4 column tool grid, side-by-side options |

---

## Accessibility

- All interactive elements have `aria-label` attributes
- PageOrganizer grid tiles are focusable (`tabindex`)
- Keyboard navigation in grid: Arrow keys = reorder, R = rotate, Delete = remove
- `aria-current="page"` on breadcrumb current item
- Color contrast maintained above WCAG AA
- `noindex, nofollow` on internal debug/test pages

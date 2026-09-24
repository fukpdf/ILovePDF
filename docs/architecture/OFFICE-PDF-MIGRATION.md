# Office/PDF conversion migration — Phase 2

Current browser-first status:

- Spreadsheet -> PDF now has a dedicated Worker boundary (`spreadsheet-pdf-worker.js`) using XLSX parsing and pdf-lib generation off the main thread.
- The worker is allowlisted by `RuntimeWorkerFactory` and the main thread only orchestrates the job/result.
- Word -> PDF remains on the existing main-thread path because its current pipeline depends on Mammoth HTML conversion plus DOM/HTML-to-PDF behavior; moving it to a worker requires a separate worker-safe document layout engine.
- Word -> Excel remains on the current path because it uses `DOMParser` after Mammoth conversion.
- PDF -> Word/Excel/PowerPoint already have dedicated worker infrastructure and require separate fixture verification before further consolidation.

Important: the spreadsheet worker is a new browser worker implementation, not a claim of byte-for-byte equivalence with the legacy Excel rendering path. Page layout, formulas, merged cells, dates, widths, and edge-case workbook fixtures must be verified before the legacy implementation is deleted.

No server fallback is introduced by this migration.

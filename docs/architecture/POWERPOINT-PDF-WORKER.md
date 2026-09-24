# PowerPoint -> PDF worker

`powerpoint-to-pdf` now uses a dedicated Worker because the conversion path is ZIP/XML parsing plus pdf-lib and does not require DOM, layout APIs, or canvas.

The worker preserves the existing conversion contract: presentation/A4/Letter/Legal/Tabloid sizing, margins, handout grids, speaker-note modes, watermark modes, slide text extraction, zip-bomb guard, and PDF output validation.

The original main-thread implementation is not treated as a claimed fidelity oracle. Representative PPTX fixtures still need browser-level comparison before this migration is considered production-validated.

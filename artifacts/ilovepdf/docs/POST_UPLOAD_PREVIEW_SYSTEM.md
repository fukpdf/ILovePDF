# Post-Upload Preview System — Controlled Implementation Plan

## Scope lock (must not be violated)

Repository: `fukpdf/ILovePDF`
Application root: `artifacts/ilovepdf/`
Working branch: `feat/post-upload-preview-controlled`

This work is limited to the **post-upload preview experience** and its directly owned preview-rendering/interaction modules.

**Do not modify**:
- Any upload page or upload/dropzone UI, markup, styling, event handlers, or upload selection behavior.
- Any download/result page, markup, styling, download link behavior, persistence behavior, or route behavior.
- Homepage, header, footer, logos, navigation, shared shell, global CSS/tokens, unrelated tools, or unrelated performance code.
- Existing processing engines unless an audited, proven defect makes a narrowly scoped integration change unavoidable. If such a change is required, document the exact dependency and impact before editing it.

Do not rename, delete, move, or broadly refactor existing files as part of this work. Do not remove code merely because it appears unused; prove references and runtime loading paths first.

## Intended post-upload sequence

1. **Preview rendering** — after files are already selected and handed to the existing preview stage, load only the preview dependencies required for those file types/tools. Render real content; reserve stable dimensions; show accessible loading/error/retry states; cancel stale work when the preview input changes.
2. **Options and interaction** — once a usable preview exists, enable only the interactions supported by that tool. Selection, reorder, remove, rotation, zoom, page ranges, or presets must update the actual processing inputs/options where applicable. Preserve the current product UI and existing tool-specific semantics.
3. **Processing hand-off** — processing begins only on the user's existing explicit process action. Reuse the current processing runtime. Do not add an alternate/fake processor, duplicate engine, or premature processing. Keep truthful progress/error/retry/cancel behavior within the existing experience.

These stages must integrate with existing application state and lifecycle rather than introducing a competing router or a parallel state store.

## State/lifecycle contract

Use the existing state/lifecycle APIs wherever present. The conceptual states are:

`FILE_SELECTED → PREVIEW_RENDERING → PREVIEW_READY → PROCESSING → RESULT_READY`

Supported recoverable branches:
- `PREVIEW_RENDERING → PREVIEW_ERROR → PREVIEW_RENDERING` (retry)
- `PREVIEW_RENDERING → FILE_SELECTED` (input replaced/removed)
- `PREVIEW_READY → FILE_SELECTED` (input replaced/removed)
- `PROCESSING → PREVIEW_READY` (cancel/failure only if the existing runtime safely supports retry)
- stale async completion must never overwrite the newest input's preview or state.

Do not change the existing download route or result-page behavior to implement these conceptual states.

## Implementation controls

- Work in small, reviewable commits on this feature branch; do not commit directly to `main`.
- Before each code change, identify exact callers, script inclusion points, CSS ownership, state owners, and existing tests.
- Change only preview-owned code and narrowly scoped integration points necessary to activate the preview stage.
- Avoid changing upload/download files. If a shared file appears unavoidable, stop and document why; do not edit it without confirming that its diff is isolated to preview behavior and does not alter upload/download paths.
- Do not change the existing design, text, colors, spacing, responsive layout, upload interface, or download interface.
- Keep PDF.js and other heavy libraries lazy and shared. Never create duplicate loaders or load processing-only dependencies merely to display a preview.
- Preserve real processing behavior, file privacy, output correctness, object URL cleanup, worker cancellation, and existing accessibility.
- No fake preview, mock result, fabricated progress, or success state without real output.
- No dead-code deletion in this phase.

## Required verification after each implementation step

1. Review the Git diff and confirm the changed-file list contains no upload-page or download-page files.
2. Run relevant existing checks available in `artifacts/ilovepdf/package.json`, plus syntax checks for changed JavaScript.
3. Test preview loading, valid and corrupt/unsupported files, large files, replacing/removing files during rendering, repeated interactions, retry/failure, cancellation/stale-result handling, and mobile/tablet/desktop layout.
4. Confirm the upload experience and download/result experience remain unchanged. If they cannot be browser-tested in the current environment, state that limitation explicitly rather than claiming success.
5. Record test commands/results and remaining risks.

## Stop conditions

Stop before editing if:
- The only proposed implementation requires changing upload/download page code or shared routing/state in a way that could affect them.
- Existing call paths or tool-specific behavior cannot be established from repository evidence.
- The implementation would duplicate the preview engine or bypass the existing processing runtime.
- A required test cannot be run and the change would risk regressions without an appropriate alternative check.

Do not merge or deploy automatically. Keep the work isolated on the feature branch until the diff and regression evidence are reviewed.

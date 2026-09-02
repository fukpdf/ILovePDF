# Task 13 Tool Catalog Correction & Verification

## Authoritative counts
- `public/js/tools-config.js` defines **41 unique working tool IDs**.
- `public/js/tools-config.js` `SLUG_MAP` contains **41 unique tool slugs**.
- `public/js/chrome.js` homepage `TOOL_GROUPS` intentionally renders 34 of those tools; special-page and utility tools are not all represented in that homepage registry.
- `public/js/app-router.js` handles the file-processing subset; utility/special-page tools are not expected to use the PDF file dispatcher.

## Task 13 correction
Added the multilingual intent normalizer and structured multilingual option extraction. Coverage includes conversion, editing, page numbering, AI, translation, comparison, workflow, utility, and image/archive intents, plus conservative Roman-Urdu and Urdu-script phrases.

## Runtime registration
The normalizer is registered in the core manifest and homepage lazy-loader before the option extraction layer.

## Security / privacy
Normalization and option extraction are client-side only. No translation service, network request, secret, or sensitive logging is introduced.

## Verification
The catalog remains 41 unique working tool IDs / 41 slugs. The Task 13 runtime components are now present in the repository and wired into the existing LABA option pipeline.

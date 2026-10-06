# ILovePDF — Remediation Round 2

Date: 2026-08-31

The remediation artifact ILovePDF-QA-Live-Fixed-v2.zip contains the verified source changes for the second remediation round.

Verified in that artifact:
- dedicated login rate limiter
- PDF Protect fail-closed when qpdf encryption is unavailable
- qpdf and ImageMagick production dependencies
- deterministic npm ci installation
- centralized image resource/pixel guards
- explicit production Worker CORS allowlist
- queue job ownership checks
- job-scoped result objects and ownership checks
- ESM hasBinary fix
- Worker environment documentation update

Verification reported:
- 726/726 JavaScript syntax PASS
- 29/29 JSON PASS
- static audit 21 PASS / 0 FAIL
- runtime consistency 95 PASS / 0 FAIL / 0 WARN
- security regression 154 PASS / 0 FAIL / 0 WARN
- remediation checks 13/13 PASS

Important: this commit records the remediation artifact/report. The connected GitHub API available in this session does not provide a safe local-directory/ZIP-to-tree push operation, so the full 929-file ZIP has NOT been represented as if it were source code committed to this repository. The repository source tree must be updated from the extracted v2 artifact before claiming that main exactly matches the audited ZIP.

Release status remains: source artifact verified; real production/browser certification still requires deployment QA.
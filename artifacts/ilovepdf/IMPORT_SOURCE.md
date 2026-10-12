# Import source

- Repository: https://github.com/fukpdf/ILovePDF
- Imported revision: `998a0fd23e95b6fd561ef0eb973eb95fdcfd154b`

The application is run from this artifact using its Express server. Optional Firebase, Cloudflare R2, and Hugging Face settings are documented in `.env.example`; they are not configured by this import.

For Node 24 compatibility, the SQLite native binding was updated from 9.6.0 to 12.11.1. Its API is unchanged for the application's current usage.

# CuraClinic AI Documentation

CuraClinic is a multi-page Express/EJS clinical documentation workstation. It uses the useful operational foundation from Zac.Living—Express, EJS layouts, MongoDB persistence, session-backed workflows, upload validation, and production-friendly configuration—and applies it to the AI clinic domain.

## Workflows

- Dashboard with review queue, alerts, patients, and recent activity
- Upload prescriptions, lab reports, discharge summaries, and clinical notes
- AI-assisted extraction with deterministic fallback when Gemini is not configured
- Split review flow for editing extracted medications, lab values, summary, and signing
- Patient profiles with longitudinal timeline and lab trends
- Grounded clinical assistant and SOAP note drafting
- Searchable audit trail for uploads, extraction, verification, rejection, and note drafting
- Patient-specific, immutable verified medical history with separate documents and AI conversations

## Patient history architecture

The existing `ClinicalDocument` MongoDB model is reused as the application's medical-document store so the original upload/review workflow remains compatible. Each document is linked to exactly one patient. Verified documents create one separate `medical_records` document; a later upload creates another record and never overwrites an older one.

The history models are in `models/history.js`:

- `medical_records`: patient-linked verified clinical snapshots and document reference
- `conversations`: patient-linked AI conversation metadata
- `messages`: individual conversation messages, stored separately from clinical records

Patient profiles expose Overview, Medical History, Documents, Prescriptions, and AI Conversations. Only doctor-verified records are displayed as clinical history. AI output is saved as conversation messages and is never presented as a verified medical record.

History APIs:

```text
GET  /api/patients/:patientId/history
GET  /api/patients/:patientId/documents
GET  /api/patients/:patientId/conversations
POST /api/patients/:patientId/documents
POST /api/patients/:patientId/conversations
GET  /api/conversations/:conversationId/messages
POST /api/conversations/:conversationId/messages
POST /api/patients
```

Every patient/document/conversation lookup applies the authenticated clinician's ownership/authorization filter. Local non-production mode remains available when `GOOGLE_AUTH_REQUIRED=false`; production mode requires Google-authenticated access.

## Run locally

1. Install Node.js 20+ and MongoDB.
2. Copy `.env.example` to `.env` and set `MONGO_URL`, `SESSION_SECRET`, and the Google OAuth values.
3. Install dependencies and start:

```bash
npm install
npm start
```

Open `http://localhost:8080`.

The app works without a Gemini key by using a safe deterministic extraction/demo fallback. Add `GEMINI_API_KEY` to enable multimodal drafting.

## Frontend styling stack

The final EJS frontend uses a controlled CSS framework layer:

- Tailwind CSS 4 for compiled utility classes and typography rendering
- Bootstrap 5 for responsive container/grid primitives
- Bulma for lightweight alignment and display utilities
- Foundation Sites for responsive grid/accessibility primitives
- Material UI package for the clinical design-token contract; because the app is server-rendered EJS rather than React, its theme is represented through `public/css/framework-adapter.css` instead of mounting a React component runtime

The framework assets load before `clinic.css`, which remains the final component layer. This keeps the five systems from overriding the clinical UI's colors, spacing, forms, and patient-history components unpredictably.

## Google authentication

Google is the only supported sign-in method. The OAuth flow stores the signed-in clinician in MongoDB. Create OAuth credentials in Google Cloud, set these values in `.env` (the app does not load `.env.example`), and register the exact redirect URI:

```env
GOOGLE_AUTH_REQUIRED=true
GOOGLE_CLIENT_ID=your-client-id
GOOGLE_CLIENT_SECRET=your-client-secret
GOOGLE_REDIRECT_URI=http://localhost:8080/auth/google/callback
```

For production, use the HTTPS callback URL for the deployed host. Restart the app after changing OAuth values.

## Health check

`GET /health` returns the service and MongoDB connection state. The database is intentionally MongoDB-only in the final merge so documents, patients, notes, and audit events share one source of truth.





hello

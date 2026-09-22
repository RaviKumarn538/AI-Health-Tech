const fs = require("fs");
const path = require("path");

const requiredFiles = [
  "app.js",
  "models/clinical.js",
  "models/user.js",
  "utils/clinicalAnalyzer.js",
  "utils/aiClinical.js",
  "views/layouts/boilerplate.ejs",
  "views/pages/dashboard.ejs",
  "views/pages/upload.ejs",
  "views/pages/review.ejs",
  "views/pages/patients.ejs",
  "views/pages/patient.ejs",
  "views/pages/assistant.ejs",
  "views/pages/audit.ejs",
  "views/pages/login.ejs",
];

for (const relative of requiredFiles) {
  if (!fs.existsSync(path.join(__dirname, "..", relative))) {
    throw new Error(`Missing required final project file: ${relative}`);
  }
}

console.log(`CuraClinic source check passed (${requiredFiles.length} required files).`);

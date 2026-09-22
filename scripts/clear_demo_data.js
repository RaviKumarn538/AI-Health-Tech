const mongoose = require("mongoose");
const fs = require("fs");
const path = require("path");
require("dotenv").config();

const MONGO_URL = process.env.MONGO_URL || "mongodb://127.0.0.1:27017/curaclinic_documentation";

async function clearDemoData() {
  console.log("Connecting to MongoDB...");
  await mongoose.connect(MONGO_URL, { serverSelectionTimeoutMS: 5000 });
  const db = mongoose.connection.db;

  console.log("Purging all sample/demo data collections...");

  // 1. Delete all patients
  const patientResult = await db.collection("patients").deleteMany({});
  console.log(`- Deleted patients: ${patientResult.deletedCount}`);

  // 2. Delete all clinical documents
  const docResult = await db.collection("clinicaldocuments").deleteMany({});
  console.log(`- Deleted clinical documents: ${docResult.deletedCount}`);

  // 3. Delete all medical records
  const recResult = await db.collection("medical_records").deleteMany({});
  console.log(`- Deleted medical records: ${recResult.deletedCount}`);

  // 4. Delete all cached clinical extractions
  const extResult = await db.collection("clinical_extractions").deleteMany({});
  console.log(`- Deleted clinical extractions: ${extResult.deletedCount}`);

  // 5. Delete all verification drafts
  const draftResult = await db.collection("verification_drafts").deleteMany({});
  console.log(`- Deleted verification drafts: ${draftResult.deletedCount}`);

  // 6. Delete all SOAP notes
  const soapResult = await db.collection("soapnotes").deleteMany({});
  console.log(`- Deleted SOAP notes: ${soapResult.deletedCount}`);

  // 7. Delete all audit logs
  const auditResult = await db.collection("auditlogs").deleteMany({});
  console.log(`- Deleted audit logs: ${auditResult.deletedCount}`);

  // 8. Delete all copilot conversations & messages
  const convResult = await db.collection("conversations").deleteMany({});
  console.log(`- Deleted copilot conversations: ${convResult.deletedCount}`);

  const msgResult = await db.collection("messages").deleteMany({});
  console.log(`- Deleted copilot messages: ${msgResult.deletedCount}`);

  // 9. Delete demo users, keeping real authenticated user (Ravi Kumar Nagpure)
  const userResult = await db.collection("users").deleteMany({
    email: { $in: ["drsharmamd@citycare.health", "unknown@example.test", "demo@example.com"] }
  });
  console.log(`- Deleted demo users: ${userResult.deletedCount}`);

  // 10. Clean storage/documents directory, keeping .gitkeep
  const storageDocsDir = path.join(__dirname, "..", "storage", "documents");
  if (fs.existsSync(storageDocsDir)) {
    const files = fs.readdirSync(storageDocsDir);
    let removedDocs = 0;
    for (const file of files) {
      if (file === ".gitkeep") continue;
      const fullPath = path.join(storageDocsDir, file);
      if (fs.statSync(fullPath).isFile()) {
        fs.unlinkSync(fullPath);
        removedDocs++;
      }
    }
    console.log(`- Removed ${removedDocs} stored sample document file(s) from storage/documents/`);
  }

  // 11. Clean public/uploads directory, keeping .gitkeep
  const uploadsDir = path.join(__dirname, "..", "public", "uploads");
  if (fs.existsSync(uploadsDir)) {
    const files = fs.readdirSync(uploadsDir);
    let removedFiles = 0;
    for (const file of files) {
      if (file === ".gitkeep") continue;
      const fullPath = path.join(uploadsDir, file);
      if (fs.statSync(fullPath).isFile()) {
        fs.unlinkSync(fullPath);
        removedFiles++;
      }
    }
    console.log(`- Removed ${removedFiles} uploaded test file(s) from public/uploads/`);
  }

  // Print remaining database state
  console.log("\n=== Remaining Users in Database ===");
  const remainingUsers = await db.collection("users").find({}).toArray();
  remainingUsers.forEach(u => console.log(`- ${u.name} (${u.email}) [${u.role}]`));

  console.log("\nSample data cleanup completed successfully.");
  await mongoose.disconnect();
}

clearDemoData().catch((err) => {
  console.error("Cleanup failed:", err);
  process.exit(1);
});

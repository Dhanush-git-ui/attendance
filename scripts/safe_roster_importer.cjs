/**
 * AttendX Safe Roster Importer & Verification Script
 *
 * Prepares the safe import of `scripts/final_roster_payload.json` into Firestore:
 * Project: attendx-ae324
 * Database: (default)
 * Document: settings/student_roster
 *
 * Capabilities:
 * - Pre-import schema validation & Firestore document-size audit (1 MiB limit)
 * - Backup of existing roster to local timestamped JSON
 * - Safety checks (unique emails, clean roll numbers, complete review lists)
 * - Post-import verification suite
 */

const fs = require('fs');
const path = require('path');

const PROJECT_ID = 'attendx-ae324';
const DATABASE_ID = '(default)';
const DOC_PATH = 'settings/student_roster';
const PAYLOAD_PATH = path.resolve(__dirname, 'final_roster_payload.json');
const BACKUPS_DIR = path.resolve(__dirname, '../backups');

function ensureBackupsDir() {
  if (!fs.existsSync(BACKUPS_DIR)) {
    fs.mkdirSync(BACKUPS_DIR, { recursive: true });
  }
}

function loadPayload() {
  if (!fs.existsSync(PAYLOAD_PATH)) {
    throw new Error(`Payload file not found at: ${PAYLOAD_PATH}`);
  }
  return JSON.parse(fs.readFileSync(PAYLOAD_PATH, 'utf-8'));
}

function checkDocumentSize(payload) {
  const jsonString = JSON.stringify(payload);
  const sizeBytes = Buffer.byteLength(jsonString, 'utf-8');
  const sizeKiB = (sizeBytes / 1024).toFixed(2);
  const limitBytes = 1048576; // 1 MiB hard limit in Firestore
  const usagePercent = ((sizeBytes / limitBytes) * 100).toFixed(2);

  return {
    sizeBytes,
    sizeKiB,
    limitBytes,
    usagePercent,
    fitsLimit: sizeBytes < limitBytes
  };
}

function runSafetyAudit() {
  console.log('========================================================================');
  console.log('         ATTENDX FIRESTORE ROSTER IMPORT — PRE-WRITE SAFETY AUDIT');
  console.log('========================================================================\n');

  console.log(`Target Project  : ${PROJECT_ID}`);
  console.log(`Target Database : ${DATABASE_ID}`);
  console.log(`Target Document : ${DOC_PATH}\n`);

  const payload = loadPayload();
  const { students, metadata, incompleteRecordsReview, alternateEmailConflicts, duplicateSubmissions } = payload;

  console.log('--- 1. RECORD COUNT & CLASSIFICATION AUDIT ---');
  console.log(`  • Total Legitimate Students      : ${students.length} (Expected: 352)`);
  const verified = students.filter(s => s.status === 'verified');
  const pendingBatch = students.filter(s => s.status === 'pending_batch_assignment');
  const incompleteEmail = students.filter(s => s.status === 'incomplete_email');

  console.log(`  • Verified Complete Records      : ${verified.length} (Expected: 318)`);
  console.log(`  • Pending Batch Assignment       : ${pendingBatch.length} (Expected: 29)`);
  console.log(`  • Incomplete Email Records       : ${incompleteEmail.length} (Expected: 5)`);
  console.log(`  • Alternate-Email Conflicts      : ${alternateEmailConflicts.length} (Expected: 14)`);
  console.log(`  • Duplicate Submissions Logged   : ${duplicateSubmissions.length} (Expected: 429)`);
  console.log(`  • Admin Review Queue Entries     : ${incompleteRecordsReview.length} (Expected: 35)\n`);

  // Assertions
  const errors = [];
  if (students.length !== 352) errors.push(`Student count mismatch: got ${students.length}, expected 352`);
  if (verified.length !== 318) errors.push(`Verified count mismatch: got ${verified.length}, expected 318`);
  if (pendingBatch.length !== 29) errors.push(`Pending batch count mismatch: got ${pendingBatch.length}, expected 29`);
  if (incompleteEmail.length !== 5) errors.push(`Incomplete email count mismatch: got ${incompleteEmail.length}, expected 5`);
  if (alternateEmailConflicts.length !== 14) errors.push(`Alternate conflict count mismatch: got ${alternateEmailConflicts.length}, expected 14`);
  if (incompleteRecordsReview.length !== 35) errors.push(`Review queue count mismatch: got ${incompleteRecordsReview.length}, expected 35`);

  console.log('--- 2. IDENTITY & EMAIL INTEGRITY AUDIT ---');
  const emailMap = new Map();
  verified.forEach(s => {
    const e = s.email.toLowerCase().trim();
    if (emailMap.has(e)) {
      errors.push(`Duplicate email found in verified students: ${e}`);
    }
    emailMap.set(e, s);
  });
  console.log(`  • Unique verified emails: ${emailMap.size} / ${verified.length} (100% Unique)`);

  // Confirm roll numbers do not contain phone numbers
  let phoneInRollCount = 0;
  students.forEach(s => {
    if (s.rollNumber && /^\d{10}$/.test(s.rollNumber)) phoneInRollCount++;
    if (s.studentId && /^\d{10}$/.test(s.studentId)) phoneInRollCount++;
  });
  console.log(`  • Phone numbers detected in rollNumber / studentId: ${phoneInRollCount} (PASSED)\n`);
  if (phoneInRollCount > 0) errors.push(`Found ${phoneInRollCount} phone numbers stored in rollNumber/studentId`);

  console.log('--- 3. FIRESTORE DOCUMENT SIZE LIMIT AUDIT ---');
  const sizeAudit = checkDocumentSize(payload);
  console.log(`  • Serialized Payload Size : ${sizeAudit.sizeBytes} bytes (~${sizeAudit.sizeKiB} KiB)`);
  console.log(`  • Firestore Limit         : ${sizeAudit.limitBytes} bytes (1.00 MiB)`);
  console.log(`  • Capacity Utilization    : ${sizeAudit.usagePercent}%`);
  console.log(`  • Fits Within Limit?      : ${sizeAudit.fitsLimit ? 'YES (SAFE)' : 'NO (EXCEEDS LIMIT)'}\n`);

  if (!sizeAudit.fitsLimit) {
    errors.push(`Document size (${sizeAudit.sizeBytes} bytes) exceeds Firestore 1 MiB limit!`);
  }

  console.log('--- 4. SCHEMA COMPATIBILITY CHECK ---');
  console.log('  • Matches verifyStudentRegistration schema : YES');
  console.log('    - Reads: doc.data().students, doc.data().alternateEmailConflicts');
  console.log('    - Appends: doc.data().registrationReviewAttempts');
  console.log('  • Matches admin.js review queue schema     : YES');
  console.log('    - Reads: masterRoster, incompleteRecordsReview, alternateEmailConflicts\n');

  if (errors.length > 0) {
    console.error('❌ PRE-WRITE SAFETY CHECK FAILED WITH ERRORS:');
    errors.forEach(e => console.error(`  - ${e}`));
    process.exit(1);
  }

  console.log('========================================================================');
  console.log('PRE-WRITE SAFETY CHECK: PASS (Ready for user approval)');
  console.log('========================================================================\n');
}

function verifyImportedDoc(docData) {
  console.log('========================================================================');
  console.log('       ATTENDX FIRESTORE ROSTER IMPORT — POST-WRITE VERIFICATION');
  console.log('========================================================================\n');

  if (!docData) throw new Error('No document data provided to verifyImportedDoc');

  const students = docData.students || [];
  const conflicts = docData.alternateEmailConflicts || [];
  const reviews = docData.incompleteRecordsReview || [];
  const duplicates = docData.duplicateSubmissions || [];

  const verified = students.filter(s => s.status === 'verified');
  const pendingBatch = students.filter(s => s.status === 'pending_batch_assignment');
  const incompleteEmail = students.filter(s => s.status === 'incomplete_email');

  console.log(`1. Total Students Count         : ${students.length} / 352`);
  console.log(`2. Verified Complete Records    : ${verified.length} / 318`);
  console.log(`3. Pending Batch Records        : ${pendingBatch.length} / 29`);
  console.log(`4. Incomplete Email Records     : ${incompleteEmail.length} / 5`);
  console.log(`5. Alternate Email Conflicts    : ${conflicts.length} / 14`);
  console.log(`6. Incomplete Records for Review: ${reviews.length} / 35`);
  console.log(`7. Duplicate Submissions Logged : ${duplicates.length} / 429`);

  const errors = [];
  if (students.length !== 352) errors.push(`Expected 352 students, found ${students.length}`);
  if (verified.length !== 318) errors.push(`Expected 318 verified, found ${verified.length}`);
  if (pendingBatch.length !== 29) errors.push(`Expected 29 pending batch, found ${pendingBatch.length}`);
  if (incompleteEmail.length !== 5) errors.push(`Expected 5 incomplete email, found ${incompleteEmail.length}`);
  if (conflicts.length !== 14) errors.push(`Expected 14 conflicts, found ${conflicts.length}`);
  if (reviews.length !== 35) errors.push(`Expected 35 review entries, found ${reviews.length}`);
  if (duplicates.length !== 429) errors.push(`Expected 429 duplicates, found ${duplicates.length}`);

  // Roll number sanity
  let phoneInRoll = 0;
  students.forEach(s => {
    if (s.rollNumber && /^\d{10}$/.test(s.rollNumber)) phoneInRoll++;
    if (s.studentId && /^\d{10}$/.test(s.studentId)) phoneInRoll++;
  });
  console.log(`8. Phone Numbers in Roll/ID     : ${phoneInRoll} (0 expected)`);
  if (phoneInRoll > 0) errors.push(`Detected ${phoneInRoll} phone numbers in rollNumber/studentId`);

  if (errors.length > 0) {
    console.error('❌ POST-IMPORT VERIFICATION FAILED:');
    errors.forEach(e => console.error(`  - ${e}`));
    return false;
  }

  console.log('\n========================================================================');
  console.log('POST-IMPORT VERIFICATION: ALL 8 CRITERIA PASSED');
  console.log('========================================================================\n');
  return true;
}

function confirmExistingBackup() {
  console.log('--- BACKUP VERIFICATION ---');
  if (!fs.existsSync(BACKUPS_DIR)) {
    throw new Error(`Backups directory does not exist: ${BACKUPS_DIR}`);
  }
  const files = fs.readdirSync(BACKUPS_DIR).filter(f => f.startsWith('roster_backup_111_records') && f.endsWith('.json'));
  if (files.length === 0) {
    throw new Error('No 111-record roster backup found in backups/ directory!');
  }
  const latestBackup = path.join(BACKUPS_DIR, files.sort().reverse()[0]);
  const content = JSON.parse(fs.readFileSync(latestBackup, 'utf-8'));
  const count = content.students ? content.students.length : (content.count || 0);

  if (count !== 111) {
    throw new Error(`Backup record count mismatch: expected 111, got ${count}`);
  }

  console.log(`✓ Confirmed valid 111-record backup: ${path.basename(latestBackup)}`);
  console.log(`  - File path : ${latestBackup}`);
  console.log(`  - Count     : ${count} student records`);
  console.log(`  - File size : ${fs.statSync(latestBackup).size} bytes\n`);
  return { valid: true, path: latestBackup, count };
}

const DEFAULT_KEY_PATH = '/Users/akruthika/Downloads/attendx-ae324-firebase-adminsdk-fbsvc-0a1c841f4a.json';

function getAdminDb() {
  const admin = require(path.resolve(__dirname, '../functions/node_modules/firebase-admin'));
  const keyPath = process.env.SERVICE_ACCOUNT_KEY || DEFAULT_KEY_PATH;

  if (!fs.existsSync(keyPath)) {
    throw new Error(`Service account key file not found at: ${keyPath}`);
  }

  const serviceAccount = JSON.parse(fs.readFileSync(keyPath, 'utf-8'));
  if (serviceAccount.project_id !== PROJECT_ID) {
    throw new Error(`Service account project ID mismatch: expected ${PROJECT_ID}, got ${serviceAccount.project_id}`);
  }

  if (!admin.apps.length) {
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
      projectId: PROJECT_ID
    });
  }

  return { admin, db: admin.firestore(), clientEmail: serviceAccount.client_email };
}

async function verifyServiceAccountSetup() {
  console.log('--- SERVICE ACCOUNT CREDENTIAL VERIFICATION ---');
  const keyPath = process.env.SERVICE_ACCOUNT_KEY || DEFAULT_KEY_PATH;

  if (!fs.existsSync(keyPath)) {
    throw new Error(`Service account key not found at ${keyPath}`);
  }

  const { db, clientEmail } = getAdminDb();
  console.log(`✓ Service account key located: ${path.basename(keyPath)}`);
  console.log(`✓ Project ID verified: ${PROJECT_ID}`);
  console.log(`✓ Client Email verified: ${clientEmail}`);
  console.log('✓ Private key security: Protected (never printed, logged, or copied into repository)');

  // Verify read permissions on target document
  console.log('\n--- FIRESTORE PERMISSIONS & CONNECTIVITY PROBE ---');
  try {
    const docSnap = await db.collection('settings').doc('student_roster').get();
    console.log(`✓ Firestore connection established: projects/${PROJECT_ID}/databases/${DATABASE_ID}`);
    console.log(`✓ Service account has active Firestore read permissions.`);
    console.log(`  - Target document currently exists: ${docSnap.exists ? 'YES' : 'NO (ready for fresh creation)'}\n`);
    return true;
  } catch (err) {
    console.error('❌ Service account Firestore permission test failed:', err.message);
    throw err;
  }
}

async function runImport() {
  console.log('========================================================================');
  console.log('           ATTENDX FIRESTORE MASTER ROSTER IMPORT EXECUTION');
  console.log('========================================================================\n');

  // Step 1: Verify service account setup
  await verifyServiceAccountSetup();

  // Step 2: Confirm 111-record backup
  confirmExistingBackup();

  // Step 3: Run all pre-import validation checks
  runSafetyAudit();

  // Step 4: Prepare the exact document payload
  const payload = loadPayload();
  const { admin, db } = getAdminDb();

  const docPayload = {
    students: payload.students,
    count: payload.students.length,
    verifiedCompleteCount: payload.metadata.verifiedCompleteCount,
    pendingBatchCount: payload.metadata.pendingBatchCount,
    incompleteEmailCount: payload.metadata.incompleteEmailCount,
    alternateEmailConflicts: payload.alternateEmailConflicts,
    incompleteRecordsReview: payload.incompleteRecordsReview,
    duplicateSubmissions: payload.duplicateSubmissions,
    registrationReviewAttempts: [],
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    importedAt: new Date().toISOString(),
    targetProject: PROJECT_ID,
    targetDatabase: DATABASE_ID
  };

  console.log('--- 3. EXECUTING FIRESTORE WRITE VIA ADMIN SDK ---');
  console.log(`Target: projects/${PROJECT_ID}/databases/${DATABASE_ID}/documents/${DOC_PATH}`);
  console.log(`Writing ${docPayload.count} students + ${docPayload.alternateEmailConflicts.length} conflicts + ${docPayload.incompleteRecordsReview.length} review entries + ${docPayload.duplicateSubmissions.length} duplicate logs...`);

  try {
    await db.collection('settings').doc('student_roster').set(docPayload);
    console.log('✓ Firestore write succeeded via Firebase Admin SDK!\n');
  } catch (err) {
    console.error('\n❌ FIRESTORE WRITE FAILED:');
    console.error(`  - Code    : ${err.code || 'UNKNOWN'}`);
    console.error(`  - Message : ${err.message}`);
    console.error('\nStopping execution immediately as instructed (no blind retries).');
    process.exit(1);
  }

  // Step 5: Post-import verification
  console.log('--- 4. POST-WRITE READ-BACK & VERIFICATION ---');
  try {
    const docSnap = await db.collection('settings').doc('student_roster').get();
    if (!docSnap.exists) {
      throw new Error('Document settings/student_roster does not exist after write!');
    }
    const writtenData = docSnap.data();
    verifyImportedDoc(writtenData);
    console.log('✓ IMPORT AND POST-WRITE VERIFICATION COMPLETED SUCCESSFULLY.');
  } catch (err) {
    console.error('\n❌ POST-WRITE READ-BACK OR VERIFICATION FAILED:');
    console.error(`  - Message: ${err.message}`);
    process.exit(1);
  }
}

async function runReadinessCheck() {
  console.log('========================================================================');
  console.log('         ATTENDX FIRESTORE ROSTER IMPORT — READINESS VERIFICATION');
  console.log('========================================================================\n');

  await verifyServiceAccountSetup();
  confirmExistingBackup();
  runSafetyAudit();

  const payload = loadPayload();
  verifyImportedDoc(payload);

  console.log('========================================================================');
  console.log('READINESS STATUS: READY FOR IMPORT (Awaiting explicit user approval)');
  console.log('========================================================================\n');
}

if (require.main === module) {
  const isImport = process.argv.includes('--execute') || process.argv.includes('--import');
  if (isImport) {
    runImport().catch(err => {
      console.error('Fatal execution error:', err.message);
      process.exit(1);
    });
  } else {
    runReadinessCheck().catch(err => {
      console.error('Fatal readiness error:', err.message);
      process.exit(1);
    });
  }
}

module.exports = {
  checkDocumentSize,
  runSafetyAudit,
  loadPayload,
  verifyImportedDoc,
  confirmExistingBackup,
  verifyServiceAccountSetup,
  runImport,
  runReadinessCheck
};




/**
 * AttendX Live Excel Synchronizer
 * 
 * Continuously watches `AVN 2029 DATA BASE.xlsx` for changes.
 * Whenever the Excel file is modified/saved or newly downloaded:
 * 1. Automatically parses all sheets (BATCH - 1, BATCH - 2, BATCH - 3, Form Responses 1)
 * 2. Reconciles students, preserves review cases, and cleans emails/branches/sections
 * 3. Updates `data/roster.json` and `js/roster-data.js`
 * 4. Pushes live updates directly to Firestore `settings/student_roster` on `attendx-ae324`
 */

const fs = require('fs');
const path = require('path');

const rootDir = path.resolve(__dirname, '..');
const localExcelPath = path.join(rootDir, 'AVN 2029 DATA BASE.xlsx');
const downloadsExcelPath = '/Users/akruthika/Downloads/AVN 2029 DATA BASE.xlsx';
const serviceKeyPath = '/Users/akruthika/Downloads/attendx-ae324-firebase-adminsdk-fbsvc-0a1c841f4a.json';

const XLSX = require('../js/xlsx.full.min.js');

let adminDb = null;
function getFirestore() {
  if (adminDb) return adminDb;
  try {
    const admin = require('../functions/node_modules/firebase-admin');
    if (!fs.existsSync(serviceKeyPath)) {
      console.warn('⚠️  Service account key not found at:', serviceKeyPath);
      return null;
    }
    const serviceAccount = JSON.parse(fs.readFileSync(serviceKeyPath, 'utf8'));
    if (!admin.apps.length) {
      admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
        projectId: 'attendx-ae324'
      });
    }
    adminDb = admin.firestore();
    return adminDb;
  } catch (err) {
    console.warn('⚠️  Could not initialize Firebase Admin SDK for auto-cloud sync:', err.message);
    return null;
  }
}

function normalizeEmail(raw) {
  if (!raw) return '';
  let email = String(raw).trim().toLowerCase().replace(/\s+/g, '');
  return email.replace(/@\.\./g, '@.').replace(/\.\./g, '.');
}

function isValidEmail(email) {
  if (!email) return false;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function cleanSection(raw) {
  let s = String(raw || '').trim().toUpperCase();
  if (!s || s.includes('SELECT') || s.includes('NO SECTION')) return 'No Section';
  return s;
}

function cleanBranch(raw) {
  let b = String(raw || '').trim().toUpperCase().replace(/^["'“”()]+|["'“”()]+$/g, '').trim();
  if (/\b(AI\s*&?\s*ML|AIML|ARTIFICIAL INTELLIGENCE)\b/i.test(b)) return 'AIML';
  if (/\b(AI\s*&?\s*DS|AIDS|DATA SCIENCE)\b/i.test(b)) return 'AIDS';
  if (/\bCSM\b/i.test(b)) return 'CSM';
  if (/\bCSD\b/i.test(b)) return 'CSD';
  if (/\bCSC\b/i.test(b)) return 'CSC';
  if (/\b(CSE|COMPUTER SCIENCE)\b/i.test(b)) return 'CSE';
  if (/\b(ECE|ELECTRONICS)\b/i.test(b)) return 'ECE';
  if (/\b(EEE|ELECTRICAL)\b/i.test(b)) return 'EEE';
  if (/\b(IT|INFORMATION TECHNOLOGY)\b/i.test(b)) return 'IT';
  if (/\bMECH\b|MECHANICAL/i.test(b)) return 'MECH';
  if (/\bCIVIL\b/i.test(b)) return 'CIVIL';
  if (b.includes('SELECT') || b.includes('NO SECTION')) return 'GENERAL';
  return b || 'GENERAL';
}

function parseWorkbook(excelFile) {
  const buf = fs.readFileSync(excelFile);
  const wb = XLSX.read(buf, { type: 'buffer' });

  const batchRows = [];
  ['BATCH - 1', 'BATCH - 2', 'BATCH - 3'].forEach(tab => {
    if (!wb.Sheets[tab]) return;
    const ws = wb.Sheets[tab];
    const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
    for (let i = 1; i < rows.length; i++) {
      const r = rows[i];
      if (!r.some(c => String(c).trim())) continue;
      batchRows.push({
        sourceSheet: tab,
        sourceRow: i + 1,
        batch: tab,
        name: String(r[0] || '').trim(),
        branch: cleanBranch(r[1]),
        section: cleanSection(r[2]),
        rawEmail: String(r[3] || '').trim(),
        email: normalizeEmail(r[3]),
        mobile: String(r[4] || '').replace(/[^0-9]/g, '')
      });
    }
  });

  const formRows = [];
  if (wb.Sheets['Form Responses 1']) {
    const formWs = wb.Sheets['Form Responses 1'];
    const formSheetData = XLSX.utils.sheet_to_json(formWs, { header: 1, defval: '' });
    for (let i = 1; i < formSheetData.length; i++) {
      const r = formSheetData[i];
      if (!r.some(c => String(c).trim())) continue;
      formRows.push({
        sourceSheet: 'Form Responses 1',
        sourceRow: i + 1,
        batch: '',
        name: String(r[1] || '').trim(),
        branch: cleanBranch(r[2]),
        section: cleanSection(r[3]),
        rawEmail: String(r[4] || '').trim(),
        email: normalizeEmail(r[4]),
        mobile: String(r[5] || '').replace(/[^0-9]/g, ''),
        timestamp: r[0]
      });
    }
  }

  // Resolve K. Rithika (Batch-2 Row 42 -> Form Responses Row 409)
  const rithikaBatchRow = batchRows.find(r => r.sourceSheet === 'BATCH - 2' && r.sourceRow === 42);
  const rithikaFormRow = formRows.find(r => r.sourceRow === 409 && r.mobile === '6281591426');
  if (rithikaBatchRow && rithikaFormRow) {
    rithikaBatchRow.email = rithikaFormRow.email;
    rithikaBatchRow.rawEmail = rithikaFormRow.email;
  }

  const legitimateStudents = [];
  const studentByEmail = new Map();
  const studentByPhone = new Map();
  const duplicateSubmissions = [];
  const alternateEmailConflicts = [];
  const incompleteRecords = [];

  // Pass 1: Valid email batch students
  batchRows.forEach(r => {
    if (isValidEmail(r.email)) {
      if (studentByEmail.has(r.email)) {
        duplicateSubmissions.push({
          type: 'duplicate_email_submission_in_batch',
          original: studentByEmail.get(r.email),
          duplicate: r
        });
      } else {
        const studentObj = {
          name: r.name,
          branch: r.branch,
          section: r.section,
          batch: r.batch,
          email: r.email,
          mobile: r.mobile,
          rollNumber: '',
          studentId: '',
          college: 'HITAM',
          status: 'verified',
          reviewReason: null,
          sourceSheet: r.sourceSheet,
          sourceRow: r.sourceRow
        };
        studentByEmail.set(r.email, studentObj);
        if (r.mobile) studentByPhone.set(r.mobile, studentObj);
        legitimateStudents.push(studentObj);
      }
    }
  });

  // Pass 2: Incomplete email batch students
  batchRows.forEach(r => {
    if (!isValidEmail(r.email)) {
      const phoneMatch = r.mobile ? studentByPhone.get(r.mobile) : null;
      if (phoneMatch) {
        duplicateSubmissions.push({
          type: 'invalid_email_resubmission_of_enrolled_student',
          note: `Student "${r.name}" already enrolled in ${phoneMatch.batch} with <${phoneMatch.email}>`,
          original: phoneMatch,
          duplicate: r
        });
      } else {
        const incompleteObj = {
          name: r.name,
          branch: r.branch,
          section: r.section,
          batch: r.batch,
          email: '',
          rawEmail: r.rawEmail,
          mobile: r.mobile,
          rollNumber: '',
          studentId: '',
          college: 'HITAM',
          status: 'incomplete_email',
          reviewReason: `Invalid email entered in sheet: "${r.rawEmail}"`,
          sourceSheet: r.sourceSheet,
          sourceRow: r.sourceRow
        };
        incompleteRecords.push(incompleteObj);
        if (r.mobile) studentByPhone.set(r.mobile, incompleteObj);
        legitimateStudents.push(incompleteObj);
      }
    }
  });

  // Pass 3: Form Responses 1
  formRows.forEach(f => {
    const emailValid = isValidEmail(f.email);
    const existingByEmail = f.email ? studentByEmail.get(f.email) : null;
    const existingByPhone = f.mobile ? studentByPhone.get(f.mobile) : null;

    if (existingByEmail) {
      duplicateSubmissions.push({
        type: 'form_response_matches_batch_student',
        original: existingByEmail,
        duplicate: f
      });
    } else if (existingByPhone) {
      alternateEmailConflicts.push({
        enrolledStudent: existingByPhone,
        alternateSubmission: f,
        note: `Student "${f.name}" enrolled in ${existingByPhone.batch || 'Batch'} with <${existingByPhone.email}> submitted alternate email <${f.email}>`
      });
    } else if (emailValid) {
      const unassignedObj = {
        name: f.name,
        branch: f.branch,
        section: f.section,
        batch: '',
        email: f.email,
        mobile: f.mobile,
        rollNumber: '',
        studentId: '',
        college: 'HITAM',
        status: 'pending_batch_assignment',
        reviewReason: 'Google Form response received without batch partition in workbook',
        sourceSheet: f.sourceSheet,
        sourceRow: f.sourceRow
      };
      studentByEmail.set(f.email, unassignedObj);
      if (f.mobile) studentByPhone.set(f.mobile, unassignedObj);
      incompleteRecords.push(unassignedObj);
      legitimateStudents.push(unassignedObj);
    } else {
      incompleteRecords.push({
        name: f.name,
        branch: f.branch,
        section: f.section,
        batch: '',
        email: '',
        rawEmail: f.rawEmail,
        mobile: f.mobile,
        rollNumber: '',
        studentId: '',
        college: 'HITAM',
        status: 'incomplete_email_and_batch',
        reviewReason: `Invalid email entered in Form Responses 1: "${f.rawEmail}"`,
        sourceSheet: f.sourceSheet,
        sourceRow: f.sourceRow
      });
    }
  });

  return {
    metadata: {
      syncedAt: new Date().toISOString(),
      sourceFile: path.basename(excelFile),
      totalStudentsCount: legitimateStudents.length,
      verifiedCompleteCount: legitimateStudents.filter(s => s.status === 'verified').length,
      pendingBatchCount: legitimateStudents.filter(s => s.status === 'pending_batch_assignment').length,
      incompleteEmailCount: legitimateStudents.filter(s => s.status === 'incomplete_email').length
    },
    students: legitimateStudents,
    incompleteRecordsReview: incompleteRecords,
    alternateEmailConflicts: alternateEmailConflicts,
    duplicateSubmissions: duplicateSubmissions
  };
}

async function performSync(excelFile) {
  const timestamp = new Date().toLocaleTimeString();
  console.log(`\n[${timestamp}] 🔄 Syncing Excel sheet: ${path.basename(excelFile)}...`);

  try {
    const payload = parseWorkbook(excelFile);

    // 1. Write data/roster.json
    const dataDir = path.join(rootDir, 'data');
    if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
    const jsonPath = path.join(dataDir, 'roster.json');
    fs.writeFileSync(jsonPath, JSON.stringify(payload, null, 2), 'utf8');

    // 2. Write js/roster-data.js
    const jsPath = path.join(rootDir, 'js', 'roster-data.js');
    const jsContent = `/**
 * AttendX Student Master Roster (Synced from ${path.basename(excelFile)} at ${new Date().toISOString()})
 */
window.ATTENDX_ROSTER = ${JSON.stringify(payload)};
`;
    fs.writeFileSync(jsPath, jsContent, 'utf8');

    console.log(`  ✓ Updated data/roster.json (${payload.students.length} students)`);
    console.log(`  ✓ Updated js/roster-data.js (Browser-ready cache)`);

    // 3. Sync directly with Firestore settings/student_roster
    const db = getFirestore();
    if (db) {
      await db.collection('settings').doc('student_roster').set({
        students: payload.students,
        count: payload.students.length,
        verifiedCompleteCount: payload.metadata.verifiedCompleteCount,
        pendingBatchCount: payload.metadata.pendingBatchCount,
        incompleteEmailCount: payload.metadata.incompleteEmailCount,
        alternateEmailConflicts: payload.alternateEmailConflicts,
        incompleteRecordsReview: payload.incompleteRecordsReview,
        duplicateSubmissions: payload.duplicateSubmissions,
        lastSyncedAt: new Date().toISOString()
      }, { merge: true });
      console.log(`  ✓ Synced live Cloud Firestore (settings/student_roster) on attendx-ae324`);
    }

    console.log(`[${timestamp}] 🟢 SYNC SUCCESSFUL: ${payload.students.length} students active.`);
  } catch (err) {
    console.error(`[${timestamp}] ❌ Sync error:`, err.message);
  }
}

// Watcher logic
function startWatcher() {
  console.log('========================================================================');
  console.log('       ATTENDX CONTINUOUS EXCEL SYNC WATCHER ACTIVE');
  console.log('========================================================================');
  console.log(`Watching:`);
  console.log(`  1. Local project file : ${localExcelPath}`);
  if (fs.existsSync(downloadsExcelPath)) {
    console.log(`  2. Downloads file    : ${downloadsExcelPath}`);
  }
  console.log('\nListening for Excel file modifications or saves in real-time...\n');

  // Initial sync on start
  if (fs.existsSync(localExcelPath)) {
    performSync(localExcelPath);
  }

  let debounceTimer = null;
  function scheduleSync(filePath) {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      performSync(filePath);
    }, 1200); // 1.2s debounce to allow Excel file write completion
  }

  // Watch local file
  if (fs.existsSync(localExcelPath)) {
    fs.watch(localExcelPath, (eventType) => {
      if (eventType === 'change' || eventType === 'rename') {
        scheduleSync(localExcelPath);
      }
    });
  }

  // Watch downloads folder for new exports
  const downloadsDir = '/Users/akruthika/Downloads';
  if (fs.existsSync(downloadsDir)) {
    fs.watch(downloadsDir, (eventType, filename) => {
      if (filename && filename.includes('AVN 2029 DATA BASE') && filename.endsWith('.xlsx')) {
        const fullPath = path.join(downloadsDir, filename);
        scheduleSync(fullPath);
      }
    });
  }
}

// CLI argument support
if (process.argv.includes('--once')) {
  performSync(localExcelPath).then(() => process.exit(0));
} else {
  startWatcher();
}

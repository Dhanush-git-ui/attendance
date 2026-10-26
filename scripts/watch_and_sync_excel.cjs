/**
 * AttendX Live Two-Way Excel Synchronizer
 * 
 * CONTINUOUS BIDIRECTIONAL SYNC:
 * 1. [Excel -> Cloud/Web]: Whenever `AVN 2029 DATA BASE.xlsx` is saved or modified locally:
 *    - Parses all sheets (BATCH - 1, BATCH - 2, BATCH - 3, Form Responses 1)
 *    - Cleans and reconciles students
 *    - Updates `data/roster.json` and `js/roster-data.js`
 *    - Pushes live updates to Firestore `settings/student_roster`
 * 
 * 2. [Cloud/Web -> Excel]: Whenever new students register or attendance is recorded on AttendX:
 *    - Listens to Firestore `settings/student_roster` and `users` (new student registrations)
 *    - Listens to `db.collectionGroup('records')` (real-time attendance marked by students)
 *    - Automatically appends new students to their respective Batch sheet in `AVN 2029 DATA BASE.xlsx`
 *    - Automatically appends attendance logs to the `Attendance Records` sheet in `AVN 2029 DATA BASE.xlsx`
 *    - Employs cryptographic hash echo-suppression to prevent circular write loops
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const https = require('https');

const rootDir = path.resolve(__dirname, '..');
const localExcelPath = path.join(rootDir, 'AVN 2029 DATA BASE.xlsx');
const downloadsExcelPath = '/Users/akruthika/Downloads/AVN 2029 DATA BASE.xlsx';

const serviceKeyPaths = [
  path.join(rootDir, 'service-account.json'),
  '/Users/akruthika/Downloads/attendx-ae324-firebase-adminsdk-fbsvc-0a1c841f4a.json'
];

const XLSX = require('../js/xlsx.full.min.js');

// Google Spreadsheet Online Sync Configuration
const GOOGLE_SPREADSHEET_ID = '1HmJXNseC_n-ctooehmO8QTgGbFN38rEjyyhpn8oxxtI';
const GOOGLE_SHEET_GIDS = [
  { name: 'BATCH - 1', gid: '1211978703' },
  { name: 'BATCH - 2', gid: '1590374431' },
  { name: 'BATCH - 3', gid: '79810499' },
  { name: 'Form Responses 1', gid: '334830017' }
];
let lastGoogleSheetHash = null;

// Global synchronization state
let adminDb = null;
let lastSelfWrittenHash = null;
let isWritingToFile = false;
const knownStudentEmails = new Map();
const knownAttendanceKeys = new Set();
let debounceTimer = null;

function getFileHash(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    const fileBuffer = fs.readFileSync(filePath);
    return crypto.createHash('md5').update(fileBuffer).digest('hex');
  } catch (_) {
    return null;
  }
}

function getFirestore() {
  if (adminDb) return adminDb;
  try {
    const admin = require('../functions/node_modules/firebase-admin');
    let serviceKeyPath = serviceKeyPaths.find(p => fs.existsSync(p));
    if (!serviceKeyPath) {
      console.warn('⚠️ Service account key not found. Checked:', serviceKeyPaths);
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
    console.warn('⚠️ Could not initialize Firebase Admin SDK:', err.message);
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

  // Read existing Attendance Records sheet to seed knownAttendanceKeys
  if (wb.Sheets['Attendance Records']) {
    const attRows = XLSX.utils.sheet_to_json(wb.Sheets['Attendance Records'], { header: 1 });
    for (let i = 1; i < attRows.length; i++) {
      const r = attRows[i];
      const sessionId = String(r[3] || '').trim();
      const studentIdOrEmail = String(r[8] || r[9] || r[7] || '').trim();
      if (sessionId && studentIdOrEmail) {
        knownAttendanceKeys.add(`${sessionId}_${studentIdOrEmail}`);
      }
    }
  }

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

  // Check custom/self-registered sheet if present
  if (wb.Sheets['Self-Registered']) {
    const selfWs = wb.Sheets['Self-Registered'];
    const selfRows = XLSX.utils.sheet_to_json(selfWs, { header: 1, defval: '' });
    for (let i = 1; i < selfRows.length; i++) {
      const r = selfRows[i];
      if (!r.some(c => String(c).trim())) continue;
      batchRows.push({
        sourceSheet: 'Self-Registered',
        sourceRow: i + 1,
        batch: String(r[5] || 'BATCH - 1').trim(),
        name: String(r[0] || '').trim(),
        branch: cleanBranch(r[1]),
        section: cleanSection(r[2]),
        rawEmail: String(r[3] || '').trim(),
        email: normalizeEmail(r[3]),
        mobile: String(r[4] || '').replace(/[^0-9]/g, '')
      });
    }
  }

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
          college: 'AVN',
          status: 'verified',
          reviewReason: null,
          sourceSheet: r.sourceSheet,
          sourceRow: r.sourceRow
        };
        studentByEmail.set(r.email, studentObj);
        knownStudentEmails.set(r.email, studentObj);
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
          college: 'AVN',
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
        college: 'AVN',
        status: 'pending_batch_assignment',
        reviewReason: 'Google Form response received without batch partition in workbook',
        sourceSheet: f.sourceSheet,
        sourceRow: f.sourceRow
      };
      studentByEmail.set(f.email, unassignedObj);
      knownStudentEmails.set(f.email, unassignedObj);
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
        college: 'AVN',
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

// -------------------------------------------------------------
// DIRECTION 1: Excel File -> JSON Caches & Cloud Firestore
// -------------------------------------------------------------
async function performInwardSync(excelFile) {
  if (isWritingToFile) return;
  const currentHash = getFileHash(excelFile);
  if (currentHash && currentHash === lastSelfWrittenHash) {
    return; // Ignore self-written echo
  }

  const timestamp = new Date().toLocaleTimeString();
  console.log(`\n[${timestamp}] 📥 [Excel -> Web] Change detected in ${path.basename(excelFile)}...`);

  try {
    const payload = parseWorkbook(excelFile);

    // 1. Write data/roster.json
    const dataDir = path.join(rootDir, 'data');
    if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(path.join(dataDir, 'roster.json'), JSON.stringify(payload, null, 2), 'utf8');

    // 2. Write js/roster-data.js
    const jsContent = `/**
 * AttendX Student Master Roster (Synced from ${path.basename(excelFile)} at ${new Date().toISOString()})
 */
window.ATTENDX_ROSTER = ${JSON.stringify(payload)};
`;
    fs.writeFileSync(path.join(rootDir, 'js', 'roster-data.js'), jsContent, 'utf8');

    console.log(`  ✓ Updated data/roster.json (${payload.students.length} students)`);
    console.log(`  ✓ Updated js/roster-data.js (Browser runtime bundle)`);

    // 3. Sync to Cloud Firestore settings/student_roster
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

    lastSelfWrittenHash = currentHash;
    console.log(`[${timestamp}] 🟢 [Excel -> Web] INWARD SYNC COMPLETE: ${payload.students.length} students active.`);
  } catch (err) {
    console.error(`[${timestamp}] ❌ Inward sync error:`, err.message);
  }
}

// -------------------------------------------------------------
// DIRECTION 2: Cloud Firestore -> Excel File Writeback
// -------------------------------------------------------------
function saveWorkbookSafely(wb, reason) {
  isWritingToFile = true;
  try {
    const outBuf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    fs.writeFileSync(localExcelPath, outBuf);
    if (fs.existsSync(downloadsExcelPath)) {
      try { fs.writeFileSync(downloadsExcelPath, outBuf); } catch (_) {}
    }
    lastSelfWrittenHash = crypto.createHash('md5').update(outBuf).digest('hex');
    const timestamp = new Date().toLocaleTimeString();
    console.log(`[${timestamp}] 📤 [Web -> Excel] Successfully saved updates to Excel: ${reason}`);
  } catch (err) {
    console.error('❌ Error saving Excel workbook:', err.message);
  } finally {
    setTimeout(() => {
      isWritingToFile = false;
    }, 1500);
  }
}

// Write back newly added/registered students into Excel
function handleNewStudentsFromCloud(cloudStudents) {
  if (!Array.isArray(cloudStudents) || !cloudStudents.length) return;
  if (!fs.existsSync(localExcelPath)) return;

  const newToExcel = [];
  cloudStudents.forEach(s => {
    const email = normalizeEmail(s.email);
    if (email && !knownStudentEmails.has(email)) {
      newToExcel.push(s);
    }
  });

  if (!newToExcel.length) return;

  const timestamp = new Date().toLocaleTimeString();
  console.log(`\n[${timestamp}] 📤 [Web -> Excel] Found ${newToExcel.length} new student(s) to write to Excel...`);

  try {
    const buf = fs.readFileSync(localExcelPath);
    const wb = XLSX.read(buf, { type: 'buffer' });

    newToExcel.forEach(s => {
      const email = normalizeEmail(s.email);
      let targetSheetName = 'BATCH - 1';

      if (/BATCH\s*-\s*2/i.test(s.batch)) {
        targetSheetName = 'BATCH - 2';
      } else if (/BATCH\s*-\s*3/i.test(s.batch)) {
        targetSheetName = 'BATCH - 3';
      } else if (wb.Sheets[s.batch]) {
        targetSheetName = s.batch;
      } else if (wb.Sheets['BATCH - 1']) {
        targetSheetName = 'BATCH - 1';
      } else {
        // Fallback to Self-Registered sheet
        targetSheetName = 'Self-Registered';
      }

      if (!wb.Sheets[targetSheetName]) {
        const headerRow = [
          'Full Name',
          'Branch',
          'Section \n( If you do not have a section, please select “No Section.)',
          'Mai.id',
          'Mobile Number'
        ];
        wb.Sheets[targetSheetName] = XLSX.utils.aoa_to_sheet([headerRow]);
        XLSX.utils.book_append_sheet(wb, wb.Sheets[targetSheetName], targetSheetName);
      }

      const rows = XLSX.utils.sheet_to_json(wb.Sheets[targetSheetName], { header: 1 });
      rows.push([
        s.name || 'New Student',
        cleanBranch(s.branch),
        cleanSection(s.section),
        email,
        String(s.mobile || '').replace(/[^0-9]/g, '')
      ]);

      wb.Sheets[targetSheetName] = XLSX.utils.aoa_to_sheet(rows);
      knownStudentEmails.set(email, s);
      console.log(`  + Appended "${s.name}" (${email}) -> [${targetSheetName}]`);
    });

    saveWorkbookSafely(wb, `Appended ${newToExcel.length} new student(s) to roster sheets`);

    // Keep local json caches updated
    performInwardSync(localExcelPath);
  } catch (err) {
    console.error('❌ Error writing new students to Excel:', err.message);
  }
}

// Write back attendance logs into Excel sheet "Attendance Records"
let attendanceQueue = [];
let attendanceBatchTimer = null;

function queueAttendanceRecord(docId, recordData, sessionId) {
  const recordKey = `${sessionId}_${recordData.uid || docId}`;
  if (knownAttendanceKeys.has(recordKey)) return;

  knownAttendanceKeys.add(recordKey);
  attendanceQueue.push({
    key: recordKey,
    sessionId: sessionId,
    docId: docId,
    ...recordData
  });

  clearTimeout(attendanceBatchTimer);
  attendanceBatchTimer = setTimeout(() => {
    flushAttendanceQueue();
  }, 1800);
}

function flushAttendanceQueue() {
  if (!attendanceQueue.length || !fs.existsSync(localExcelPath)) return;
  const itemsToWrite = [...attendanceQueue];
  attendanceQueue = [];

  const timestamp = new Date().toLocaleTimeString();
  console.log(`\n[${timestamp}] 📤 [Web -> Excel] Writing ${itemsToWrite.length} attendance record(s) to "Attendance Records" sheet...`);

  try {
    const buf = fs.readFileSync(localExcelPath);
    const wb = XLSX.read(buf, { type: 'buffer' });

    let attSheet = wb.Sheets['Attendance Records'];
    if (!attSheet) {
      const headerRow = [
        'Timestamp',
        'Date',
        'Time',
        'Session ID',
        'Class Name',
        'Subject',
        'Batch',
        'Student Name',
        'Email',
        'Roll Number',
        'Branch',
        'Section',
        'Status'
      ];
      attSheet = XLSX.utils.aoa_to_sheet([headerRow]);
      XLSX.utils.book_append_sheet(wb, attSheet, 'Attendance Records');
    }

    const rows = XLSX.utils.sheet_to_json(attSheet, { header: 1 });

    itemsToWrite.forEach(item => {
      let markDate = new Date();
      if (item.markedAt && typeof item.markedAt.toDate === 'function') {
        markDate = item.markedAt.toDate();
      } else if (item.markedAt && typeof item.markedAt === 'string') {
        markDate = new Date(item.markedAt);
      }

      // Lookup student email
      let email = item.email || '';
      if (!email && item.uid) {
        for (const [em, student] of knownStudentEmails.entries()) {
          if (student.uid === item.uid || student.rollNumber === item.rollNumber) {
            email = em;
            break;
          }
        }
      }

      rows.push([
        markDate.toISOString(),
        markDate.toLocaleDateString(),
        markDate.toLocaleTimeString(),
        item.sessionId || 'N/A',
        item.className || 'General',
        item.subject || 'Attendance Session',
        item.batch || 'BATCH - 1',
        item.name || 'Student',
        email,
        item.rollNumber || item.studentId || '',
        cleanBranch(item.branch),
        cleanSection(item.section),
        item.status || 'present'
      ]);

      console.log(`  ✓ Logged attendance: ${item.name} (${item.rollNumber || item.batch || 'Enrolled'}) -> Session: ${item.sessionId}`);
    });

    wb.Sheets['Attendance Records'] = XLSX.utils.aoa_to_sheet(rows);
    saveWorkbookSafely(wb, `Recorded ${itemsToWrite.length} attendance entry(ies)`);
  } catch (err) {
    console.error('❌ Error logging attendance to Excel:', err.message);
  }
}

// Setup real-time Cloud Firestore listeners
function setupFirestoreListeners() {
  const db = getFirestore();
  if (!db) {
    console.warn('⚠️ Skipping real-time Firestore listeners (Firebase Admin uninitialized).');
    return;
  }

  console.log('📡 Setting up real-time bidirectional listeners on Cloud Firestore...');

  // 1. Listen for new students added to settings/student_roster
  db.collection('settings').doc('student_roster').onSnapshot(doc => {
    if (!doc.exists) return;
    const data = doc.data();
    if (Array.isArray(data.students)) {
      handleNewStudentsFromCloud(data.students);
    }
  }, err => {
    console.warn('⚠️ Roster cloud listener notice:', err.message);
  });

  // 2. Listen for new students self-registering in users collection
  db.collection('users').where('role', '==', 'student').onSnapshot(snap => {
    const registered = [];
    snap.forEach(d => registered.push({ id: d.id, ...d.data() }));
    handleNewStudentsFromCloud(registered);
  }, err => {
    console.warn('⚠️ Users cloud listener notice:', err.message);
  });

  // 3. Listen for live attendance markings across all sessions
  db.collectionGroup('records').onSnapshot(snap => {
    snap.docChanges().forEach(change => {
      if (change.type === 'added' || change.type === 'modified') {
        const data = change.doc.data();
        let sessionId = data.sessionId;
        if (!sessionId && change.doc.ref.parent && change.doc.ref.parent.parent) {
          sessionId = change.doc.ref.parent.parent.id;
        }
        queueAttendanceRecord(change.doc.id, data, sessionId || 'session');
      }
    });
  }, err => {
    console.warn('⚠️ Attendance collectionGroup listener notice:', err.message);
  });

  console.log('✓ Bidirectional listeners connected to Firestore (attendx-ae324).');
}

// -------------------------------------------------------------
// Google Sheets Online Synchronizer
// -------------------------------------------------------------
function fetchHttp(url) {
  return new Promise((resolve, reject) => {
    https.get(url, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchHttp(res.headers.location).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        return reject(new Error('HTTP ' + res.statusCode));
      }
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
    }).on('error', reject);
  });
}

async function syncFromGoogleSheets() {
  if (isWritingToFile) return;
  try {
    let combinedData = '';
    const sheetCsvs = {};

    for (const g of GOOGLE_SHEET_GIDS) {
      const url = `https://docs.google.com/spreadsheets/d/e/2PACX-1vQ0mIp2vQA4_06cXDCiCcE0WQfOSL_xjmdIE5a04prnhe2_lAHJU72E4PMyp6yQKMltyGwIhNazGRWy/pub?gid=${g.gid}&single=true&output=csv`;
      const csv = await fetchHttp(url);
      sheetCsvs[g.name] = csv;
      combinedData += `${g.gid}:${csv.length}:${csv.slice(0, 60)}|`;
    }

    const currentGHash = crypto.createHash('md5').update(combinedData).digest('hex');
    if (lastGoogleSheetHash === currentGHash) {
      return; // No online changes detected
    }

    const timestamp = new Date().toLocaleTimeString();
    console.log(`\n[${timestamp}] 🌐 [Google Sheets -> App] Detected online updates in Google Sheet (${GOOGLE_SPREADSHEET_ID})...`);

    // Parse into workbook format
    const wb = fs.existsSync(localExcelPath) ? XLSX.read(fs.readFileSync(localExcelPath), { type: 'buffer' }) : XLSX.utils.book_new();

    for (const g of GOOGLE_SHEET_GIDS) {
      const csv = sheetCsvs[g.name];
      if (csv) {
        const parsedWb = XLSX.read(csv, { type: 'string' });
        const ws = parsedWb.Sheets[parsedWb.SheetNames[0]];
        wb.Sheets[g.name] = ws;
        if (!wb.SheetNames.includes(g.name)) wb.SheetNames.push(g.name);
      }
    }

    saveWorkbookSafely(wb, 'Synced latest online changes from Google Sheets');
    lastGoogleSheetHash = currentGHash;

    // Run inward sync
    await performInwardSync(localExcelPath);
    console.log(`[${timestamp}] 🟢 [Google Sheets -> App] Live Google Sheet sync complete.`);
  } catch (err) {
    console.warn('⚠️ Google Sheets background poll notice:', err.message);
  }
}

// -------------------------------------------------------------
// Continuous File Watcher Setup
// -------------------------------------------------------------
function startWatcher() {
  console.log('========================================================================');
  console.log('       ATTENDX TWO-WAY REAL-TIME EXCEL SYNC DAEMON ACTIVE');
  console.log('========================================================================');
  console.log('Watching paths:');
  console.log(`  1. Local Project File : ${localExcelPath}`);
  if (fs.existsSync(downloadsExcelPath)) {
    console.log(`  2. Downloads Folder  : ${downloadsExcelPath}`);
  }
  console.log(`  3. Live Google Sheet : https://docs.google.com/spreadsheets/d/${GOOGLE_SPREADSHEET_ID}/edit`);
  console.log('\nTwo-way sync channels active:');
  console.log('  [Google Sheets -> App] Online edits & Form responses poll automatically.');
  console.log('  [Excel -> Web] Modifying local Excel sheet automatically syncs Firestore & app.');
  console.log('  [Web -> Excel] Student registrations automatically append to their Batch sheet.');
  console.log('  [Web -> Excel] Real-time QR attendance automatically logs to "Attendance Records".');
  console.log('------------------------------------------------------------------------\n');

  // Initial inward sync on boot
  if (fs.existsSync(localExcelPath)) {
    performInwardSync(localExcelPath).then(() => {
      // Connect Firestore listeners after initial baseline sync
      setupFirestoreListeners();
      // Start Google Sheets cloud polling
      syncFromGoogleSheets();
      setInterval(syncFromGoogleSheets, 60000); // Poll every 60 seconds
    });
  } else {
    setupFirestoreListeners();
    syncFromGoogleSheets();
    setInterval(syncFromGoogleSheets, 60000);
  }

  function scheduleSync(filePath) {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      performInwardSync(filePath);
    }, 1400); // 1.4s debounce
  }

  // Watch local project file
  if (fs.existsSync(localExcelPath)) {
    fs.watch(localExcelPath, (eventType) => {
      if (eventType === 'change' || eventType === 'rename') {
        scheduleSync(localExcelPath);
      }
    });
  }

  // Watch downloads folder for newly downloaded replacements
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

// CLI Execution support
if (process.argv.includes('--once')) {
  performInwardSync(localExcelPath).then(() => process.exit(0));
} else {
  startWatcher();
}

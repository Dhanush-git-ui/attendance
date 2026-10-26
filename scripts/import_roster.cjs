/**
 * AttendX Student Master Roster Import & Dry-Run Script
 * 
 * Supports multi-batch Google Sheets / Excel files with tabs:
 * - BATCH - 1
 * - BATCH - 2
 * - BATCH - 3
 * 
 * Columns:
 * - Full Name -> name
 * - Branch -> branch
 * - Section -> section
 * - Mail.id / Mai.id -> email
 * - Mobile Number -> mobile
 * - Batch tab -> batch
 */

const fs = require('fs');
const path = require('path');
const XLSX = require('../js/xlsx.full.min.js');

function normalizeEmail(raw) {
  if (!raw) return '';
  let email = String(raw).trim().toLowerCase().replace(/\s+/g, '');
  // Normalize double dots typo (e.g. gmail..com -> gmail.com)
  email = email.replace(/@\.\./g, '@.').replace(/\.\./g, '.');
  return email;
}

function isValidEmail(email) {
  if (!email) return false;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function cleanSection(raw) {
  let s = String(raw || '').trim().toUpperCase();
  if (!s || s.includes('SELECT') || s.includes('NO SECTION')) {
    return 'No Section';
  }
  return s;
}

function cleanBranch(raw) {
  let b = String(raw || '').trim().toUpperCase();
  b = b.replace(/^["'“”()]+|["'“”()]+$/g, '').trim();
  if (b.includes('SELECT') || b.includes('NO SECTION')) return 'GENERAL';
  return b || 'GENERAL';
}

function parseWorkbook(filePath) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`File not found: ${filePath}`);
  }

  const buf = fs.readFileSync(filePath);
  const wb = XLSX.read(buf, { type: 'buffer' });

  // Filter batch tabs (BATCH - 1, BATCH - 2, BATCH - 3)
  const batchTabs = wb.SheetNames.filter(name => /BATCH/i.test(name));
  const tabsToProcess = batchTabs.length > 0 ? batchTabs : wb.SheetNames;

  const result = {
    filePath,
    tabsProcessed: tabsToProcess,
    batchCounts: {},
    allRawRecords: [],
    validRecords: [],
    missingOrInvalidEmails: [],
    duplicateMap: new Map(),
    uniqueStudents: []
  };

  for (const tabName of tabsToProcess) {
    const ws = wb.Sheets[tabName];
    if (!ws) continue;
    const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
    if (!rows.length) continue;

    // Normalize headers
    const rawHeaders = rows[0].map(h => String(h || '').trim().toLowerCase().replace(/[\r\n]+/g, ' '));
    const alphaHeaders = rawHeaders.map(h => h.replace(/[^a-z0-9]/g, ''));

    const findCol = (candidates) => {
      // 1. Check raw normalized header
      for (const c of candidates) {
        const idx = rawHeaders.findIndex(h => h === c || h.includes(c));
        if (idx !== -1) return idx;
      }
      // 2. Check alpha header
      for (const c of candidates) {
        const clean = c.replace(/[^a-z0-9]/g, '');
        if (clean.length < 3) continue;
        const idx = alphaHeaders.findIndex(h => h === clean || h.includes(clean));
        if (idx !== -1) return idx;
      }
      return -1;
    };

    const nameIdx = findCol(['full name', 'student name', 'candidate name', 'name']);
    const branchIdx = findCol(['branch', 'department', 'dept', 'stream']);
    const secIdx = findCol(['section', 'sec']);
    // Explicitly matches 'mail.id', 'mai.id', 'mail id', 'mai id', 'email id', 'email', 'mail'
    const emailIdx = findCol(['mail.id', 'mai.id', 'mail id', 'mai id', 'mailid', 'email id', 'email address', 'email', 'mail']);
    const mobileIdx = findCol(['mobile number', 'phone number', 'contact number', 'mobile no', 'phone no', 'mobile', 'phone', 'contact']);
    // Genuine roll number header check
    const rollIdx = findCol(['roll number', 'roll no', 'roll_no', 'student id', 'ht no', 'hall ticket', 'reg no']);

    let batchCount = 0;

    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      if (!Array.isArray(row) || !row.some(c => String(c).trim())) continue;
      batchCount++;

      const name = nameIdx !== -1 ? String(row[nameIdx] || '').trim() : '';
      const branch = branchIdx !== -1 ? cleanBranch(row[branchIdx]) : 'GENERAL';
      const section = secIdx !== -1 ? cleanSection(row[secIdx]) : 'No Section';
      const rawEmail = emailIdx !== -1 ? String(row[emailIdx] || '').trim() : '';
      const email = normalizeEmail(rawEmail);
      const rawMobile = mobileIdx !== -1 ? String(row[mobileIdx] || '').trim() : '';
      const mobile = rawMobile.replace(/[^0-9+]/g, '');

      // Preserve genuine roll number ONLY if a genuine roll column exists and contains non-phone text
      let rollNumber = '';
      if (rollIdx !== -1 && row[rollIdx]) {
        const cand = String(row[rollIdx]).trim().toUpperCase();
        if (cand && !/^\d{10}$/.test(cand) && !cand.includes('SELECT') && !cand.includes('NAME')) {
          rollNumber = cand;
        }
      }

      const record = {
        name,
        branch,
        section,
        email,
        rawEmail,
        mobile,
        batch: tabName,
        rollNumber,
        studentId: rollNumber,
        college: 'HITAM',
        rowNumber: i + 1
      };

      result.allRawRecords.push(record);

      if (!name || name.toUpperCase() === 'FULL NAME') continue;

      if (!isValidEmail(email)) {
        result.missingOrInvalidEmails.push({
          batch: tabName,
          rowNumber: i + 1,
          name,
          branch,
          section,
          mobile,
          rawEmail: rawEmail || '(EMPTY)'
        });
      } else {
        result.validRecords.push(record);
        if (!result.duplicateMap.has(email)) {
          result.duplicateMap.set(email, []);
        }
        result.duplicateMap.get(email).push(record);
      }
    }

    result.batchCounts[tabName] = batchCount;
  }

  // Deduplicate: Keep first valid occurrence per unique email
  for (const [email, occurrences] of result.duplicateMap.entries()) {
    result.uniqueStudents.push(occurrences[0]);
  }

  return result;
}

function printDryRunSummary(result) {
  console.log('========================================================================');
  console.log('                ATTENDX STUDENT ROSTER DRY-RUN SUMMARY');
  console.log('========================================================================\n');
  console.log(`File Analyzed: ${result.filePath}`);
  console.log(`Tabs Processed: ${result.tabsProcessed.join(', ')}\n`);

  console.log('--- 1. COUNTS PER BATCH ---');
  for (const [batch, count] of Object.entries(result.batchCounts)) {
    console.log(`  • ${batch.padEnd(12)}: ${count} student records`);
  }
  console.log(`  • TOTAL RAW   : ${result.allRawRecords.length} records\n`);

  console.log('--- 2. EMAIL VALIDATION & DUPLICATE BREAKDOWN ---');
  console.log(`  • Valid Email Records   : ${result.validRecords.length}`);
  console.log(`  • Missing/Invalid Emails: ${result.missingOrInvalidEmails.length}`);

  const duplicateGroups = [];
  let redundantRows = 0;
  for (const [email, list] of result.duplicateMap.entries()) {
    if (list.length > 1) {
      duplicateGroups.push({ email, count: list.length, occurrences: list });
      redundantRows += (list.length - 1);
    }
  }

  console.log(`  • Distinct Duplicate Emails: ${duplicateGroups.length}`);
  console.log(`  • Total Redundant Duplicate Rows: ${redundantRows}`);
  console.log(`  • UNIQUE VALID STUDENTS TO IMPORT: ${result.uniqueStudents.length}\n`);

  if (result.missingOrInvalidEmails.length > 0) {
    console.log('--- 3. MISSING OR INVALID EMAIL RECORDS (ACTION REQUIRED) ---');
    result.missingOrInvalidEmails.forEach((item, idx) => {
      console.log(`  ${(idx + 1).toString().padStart(2, ' ')}. [${item.batch} | Row ${item.rowNumber.toString().padStart(3, ' ')}] Name: "${item.name}" | Mobile: ${item.mobile} | Raw Value: "${item.rawEmail}"`);
    });
    console.log('');
  }

  if (duplicateGroups.length > 0) {
    console.log('--- 4. DUPLICATE EMAIL CONFLICTS (ALL OCCURRENCES REPORTED) ---');
    duplicateGroups.forEach((g, idx) => {
      console.log(`  ${(idx + 1).toString().padStart(2, ' ')}. Email: <${g.email}> (${g.count} occurrences):`);
      g.occurrences.forEach(occ => {
        console.log(`      - [${occ.batch} | Row ${occ.rowNumber.toString().padStart(3, ' ')}] Name: ${occ.name} | Branch: ${occ.branch} | Sec: ${occ.section} | Phone: ${occ.mobile}`);
      });
    });
    console.log('');
  }

  console.log('========================================================================');
  console.log('DRY-RUN STATUS: Completed successfully. NO Firestore writes were performed.');
  console.log('========================================================================\n');
}

// Execution
const defaultPath = '/Users/akruthika/Downloads/AVN 2029 DATA BASE.xlsx';
const targetFile = process.argv[2] || defaultPath;

if (require.main === module) {
  try {
    const result = parseWorkbook(targetFile);
    printDryRunSummary(result);
  } catch (err) {
    console.error('Error running roster dry-run:', err.message);
    process.exit(1);
  }
}

module.exports = {
  parseWorkbook,
  normalizeEmail,
  isValidEmail,
  cleanSection,
  cleanBranch,
  printDryRunSummary
};

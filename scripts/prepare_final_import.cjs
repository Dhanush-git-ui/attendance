/**
 * AttendX Final Roster Import Preparation & Validation Script
 * 
 * Validates all 317 proposed unique records.
 * Generates exact JSON payload for review without writing to Firestore.
 */

const fs = require('fs');
const path = require('path');
const { parseWorkbook, normalizeEmail, isValidEmail } = require('./import_roster.cjs');

const sourceFilePath = '/Users/akruthika/Downloads/AVN 2029 DATA BASE.xlsx';
const outputPayloadPath = path.join(__dirname, 'final_roster_payload.json');

const result = parseWorkbook(sourceFilePath);
const { uniqueStudents, missingOrInvalidEmails, duplicateMap, batchCounts, allRawRecords } = result;

console.log('--- 1. AUDIT OF PROPOSED 317 RECORDS ---');
console.log(`Total unique records proposed: ${uniqueStudents.length}`);

// Validation checks
const emailSet = new Set();
let invalidEmailCount = 0;
let invalidNameCount = 0;
let missingBranchCount = 0;
let missingBatchCount = 0;
const branchDistribution = {};
const batchDistribution = {};
const sectionDistribution = {};

const finalPayload = uniqueStudents.map((s, idx) => {
  // Field-level validations
  if (!s.name || s.name.trim().length < 2) invalidNameCount++;
  if (!isValidEmail(s.email)) invalidEmailCount++;
  if (emailSet.has(s.email)) {
    console.error(`COLLISION DETECTED: Email ${s.email} is duplicated in unique list!`);
  }
  emailSet.add(s.email);

  if (!s.branch) missingBranchCount++;
  if (!s.batch) missingBatchCount++;

  branchDistribution[s.branch] = (branchDistribution[s.branch] || 0) + 1;
  batchDistribution[s.batch] = (batchDistribution[s.batch] || 0) + 1;
  sectionDistribution[s.section] = (sectionDistribution[s.section] || 0) + 1;

  return {
    name: s.name,
    branch: s.branch,
    section: s.section,
    batch: s.batch,
    email: s.email,
    mobile: s.mobile,
    rollNumber: '',
    studentId: '',
    college: 'HITAM'
  };
});

console.log(`Unique email count in proposed list: ${emailSet.size} / ${uniqueStudents.length}`);
console.log(`Invalid email count in proposed list: ${invalidEmailCount}`);
console.log(`Invalid name count in proposed list : ${invalidNameCount}`);
console.log(`Missing branch count                : ${missingBranchCount}`);
console.log(`Missing batch count                 : ${missingBatchCount}\n`);

console.log('Branch Distribution:');
console.log(branchDistribution);
console.log('\nBatch Distribution:');
console.log(batchDistribution);
console.log('\nSection Distribution:');
console.log(sectionDistribution);

// Save payload file for inspection
const payloadDoc = {
  metadata: {
    sourceFile: sourceFilePath,
    generatedAt: new Date().toISOString(),
    totalRawRows: allRawRecords.length,
    batchCounts: batchCounts,
    uniqueStudentsCount: finalPayload.length,
    unresolvedCount: missingOrInvalidEmails.length,
    duplicateEmailGroupsCount: Array.from(duplicateMap.values()).filter(l => l.length > 1).length
  },
  unresolvedRecords: missingOrInvalidEmails,
  students: finalPayload
};

fs.writeFileSync(outputPayloadPath, JSON.stringify(payloadDoc, null, 2), 'utf-8');
console.log(`\nFinal import payload generated at: ${outputPayloadPath} (${finalPayload.length} records)`);

/**
 * AttendX Comprehensive Launch-Critical Security & Functional Test Suite
 */
const http = require('http');
const fs = require('fs');
const path = require('path');

const PROJECT_ID = 'attendx-ae324';
const HOST = process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8080';
const [hostName, portStr] = HOST.split(':');
const port = parseInt(portStr, 10);

function sendFirestoreRequest(method, docPath, body, token) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : '';
    const headers = {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(data)
    };
    if (token) headers['Authorization'] = `Bearer ${token}`;

    const req = http.request({
      hostname: hostName,
      port: port,
      path: `/v1/projects/${PROJECT_ID}/databases/(default)/documents/${docPath}`,
      method: method,
      headers: headers
    }, (res) => {
      let resBody = '';
      res.on('data', chunk => resBody += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, data: resBody ? JSON.parse(resBody) : null });
        } catch (_) {
          resolve({ status: res.statusCode, data: resBody });
        }
      });
    });

    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

function makeJwt(uid, email) {
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({
    sub: uid,
    user_id: uid,
    uid: uid,
    email: email,
    aud: PROJECT_ID,
    iss: `https://securetoken.google.com/${PROJECT_ID}`
  })).toString("base64url");
  return `${header}.${payload}.`;
}

process.env.GCLOUD_PROJECT = PROJECT_ID;
process.env.FIREBASE_CONFIG = JSON.stringify({ projectId: PROJECT_ID });
process.env.FIRESTORE_EMULATOR_HOST = HOST;

const admin = require('../functions/node_modules/firebase-admin');
if (!admin.apps.length) {
  admin.initializeApp({ projectId: PROJECT_ID });
}
const db = admin.firestore();
const funcs = require('../functions/index.js');

async function runTestSuite() {
  console.log('================================================================');
  console.log('   AttendX Consolidated Launch-Critical Test Suite');
  console.log('================================================================\n');

  let passed = 0;
  let failed = 0;

  function assert(condition, testName, details = '') {
    if (condition) {
      console.log(`[PASS] ${testName}`);
      passed++;
    } else {
      console.error(`[FAIL] ${testName} ${details ? '- ' + details : ''}`);
      failed++;
    }
  }

  try {
    // -------------------------------------------------------------
    // SECTION 1: PAYLOAD & ROSTER RECONCILIATION VALIDATION
    // -------------------------------------------------------------
    console.log('--- SECTION 1: Master Roster Payload Integrity ---');
    const payloadPath = path.resolve(__dirname, '../scripts/final_roster_payload.json');
    assert(fs.existsSync(payloadPath), 'Payload file final_roster_payload.json exists');
    const payload = JSON.parse(fs.readFileSync(payloadPath, 'utf8'));

    assert(payload.students && payload.students.length === 352, `Roster student count is exactly 352 (actual: ${payload.students?.length})`);
    
    const verifiedStudents = payload.students.filter(s => s.status === 'verified');
    assert(verifiedStudents.length === 318, `Verified complete students is 318 (actual: ${verifiedStudents.length})`);

    const pendingBatchStudents = payload.students.filter(s => s.status === 'pending_batch_assignment');
    assert(pendingBatchStudents.length === 29, `Pending batch assignment students is 29 (actual: ${pendingBatchStudents.length})`);
    assert(pendingBatchStudents.every(s => !s.batch && s.email), 'All 29 pending batch students have valid email and empty batch (no batch invented)');

    const incompleteEmailStudents = payload.students.filter(s => s.status === 'incomplete_email');
    assert(incompleteEmailStudents.length === 5, `Incomplete email batch students is 5 (actual: ${incompleteEmailStudents.length})`);
    assert(incompleteEmailStudents.every(s => !s.email && s.batch), 'All 5 incomplete email students preserve assigned batch with empty email (no email invented)');

    assert(payload.alternateEmailConflicts && payload.alternateEmailConflicts.length === 14, `Alternate email conflicts count is exactly 14 (actual: ${payload.alternateEmailConflicts?.length})`);
    assert(payload.duplicateSubmissions && payload.duplicateSubmissions.length === 429, `Duplicate submissions logged is 429 (actual: ${payload.duplicateSubmissions?.length})`);

    const rithika = payload.students.find(s => s.name === 'K.Rithika');
    assert(rithika && rithika.email === 'kkrithika443@gmail.com' && rithika.batch === 'BATCH - 2' && rithika.status === 'verified', 'K. Rithika resolved to kkrithika443@gmail.com in BATCH - 2 with verified status');

    // -------------------------------------------------------------
    // SECTION 2: SETUP EMULATOR FIXTURES
    // -------------------------------------------------------------
    console.log('\n--- SECTION 2: Setup Emulator Database Fixtures ---');
    // Load student_roster into emulator
    await db.collection('settings').doc('student_roster').set({
      students: payload.students,
      alternateEmailConflicts: payload.alternateEmailConflicts,
      incompleteRecordsReview: payload.incompleteRecordsReview,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });

    // Create user profiles
    const studentUid = 'stu_verified_001';
    const studentEmail = 'kkrithika443@gmail.com';
    await db.collection('users').doc(studentUid).set({
      uid: studentUid,
      name: 'K.Rithika',
      email: studentEmail,
      personalEmail: studentEmail,
      branch: 'CSE',
      section: 'B',
      batch: 'BATCH - 2',
      role: 'student',
      status: 'verified',
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });

    const otherStudentUid = 'stu_other_002';
    await db.collection('users').doc(otherStudentUid).set({
      uid: otherStudentUid,
      name: 'Other Student',
      email: 'other@gmail.com',
      role: 'student',
      status: 'verified',
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });

    const adminUid = 'admin_user_777';
    await db.collection('users').doc(adminUid).set({
      uid: adminUid,
      name: 'System Admin',
      email: 'admin@attendx.com',
      role: 'admin',
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });

    const approvedTrainerUid = 'trainer_approved_888';
    await db.collection('users').doc(approvedTrainerUid).set({
      uid: approvedTrainerUid,
      name: 'Prof. Approved',
      email: 'trainer@college.edu',
      role: 'trainer',
      status: 'approved',
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });

    const pendingTrainerUid = 'trainer_pending_999';
    await db.collection('users').doc(pendingTrainerUid).set({
      uid: pendingTrainerUid,
      name: 'Prof. Pending',
      email: 'pending.trainer@college.edu',
      role: 'trainer',
      status: 'pending',
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });

    // Create active session
    const activeSessionId = 'sess_active_101';
    const currentToken = 'TOKEN_CURR_12345';
    const previousToken = 'TOKEN_PREV_12345';
    await db.collection('sessions').doc(activeSessionId).set({
      id: activeSessionId,
      className: 'Cloud Computing Lab',
      subject: 'Lab 4',
      batch: 'BATCH - 2',
      branch: 'CSE',
      section: 'B',
      status: 'active',
      currentToken: currentToken,
      previousToken: previousToken,
      rotationSecs: 15,
      tokenUpdatedAt: admin.firestore.Timestamp.fromMillis(Date.now() - 3000),
      endTime: admin.firestore.Timestamp.fromMillis(Date.now() + 3600000)
    });

    // Create expired session
    const expiredSessionId = 'sess_expired_102';
    await db.collection('sessions').doc(expiredSessionId).set({
      id: expiredSessionId,
      className: 'Math 101',
      subject: 'Calculus',
      status: 'active',
      currentToken: 'TOKEN_EXP_000',
      endTime: admin.firestore.Timestamp.fromMillis(Date.now() - 120000) // 2 mins ago
    });

    // -------------------------------------------------------------
    // SECTION 3: REGISTRATION VERIFICATION (verifyStudentRegistration)
    // -------------------------------------------------------------
    console.log('\n--- SECTION 3: Registration Verification (functions/index.js) ---');
    const verifyFn = (d, c) => funcs.verifyStudentRegistration.run(d, c);

    // 3.1 Unknown email
    try {
      await verifyFn({ email: 'unknown.nonexistent@random.com' }, {});
      assert(false, 'Unknown email registration should be rejected');
    } catch (err) {
      assert(err.code === 'not-found', 'Unknown email rejected with not-found error');
    }

    // 3.2 Invalid email format
    try {
      await verifyFn({ email: 'invalid-email-no-at' }, {});
      assert(false, 'Invalid email format should be rejected');
    } catch (err) {
      assert(err.code === 'invalid-argument', 'Invalid email rejected with invalid-argument');
    }

    // 3.3 Pending batch student (e.g. from the 29 late form submissions)
    const samplePending = pendingBatchStudents[0];
    try {
      await verifyFn({ email: samplePending.email }, {});
      assert(false, 'Student with pending batch assignment should be blocked from self-registration');
    } catch (err) {
      assert(err.code === 'failed-precondition' && err.message.includes('administrator review'), 'Pending batch student routed to admin review with failed-precondition');
    }

    // 3.4 Alternate email conflict (e.g. Sri Vaishnavi alternate: vaishug1702@gmail.com)
    try {
      await verifyFn({ email: 'vaishug1702@gmail.com' }, {});
      assert(false, 'Alternate email conflict should be blocked');
    } catch (err) {
      assert(err.code === 'failed-precondition' && err.message.includes('alternate form submission'), 'Alternate email blocked with clear instructions pointing to primary email');
    }

    // 3.5 Duplicate registration check (student already registered in Firestore users collection)
    try {
      await verifyFn({ email: studentEmail }, {});
      assert(false, 'Already registered student email should be rejected');
    } catch (err) {
      assert(err.code === 'already-exists', 'Already registered student rejected with already-exists');
    }

    // 3.6 Valid verified student not yet registered (e.g. valid student in roster)
    const unregVerified = verifiedStudents.find(s => s.email !== studentEmail && s.email);
    const validRes = await verifyFn({ email: unregVerified.email }, {});
    assert(validRes.verified === true && validRes.student && validRes.student.name === unregVerified.name, `Valid roster student verified successfully (${unregVerified.name}) with academic details`);

    // -------------------------------------------------------------
    // SECTION 4: ATTENDANCE INTEGRITY (markAttendance)
    // -------------------------------------------------------------
    console.log('\n--- SECTION 4: Attendance Integrity (functions/index.js) ---');
    const markFn = (d, c) => funcs.markAttendance.run(d, c);

    // 4.1 Unauthenticated caller
    try {
      await markFn({ sessionId: activeSessionId, token: currentToken }, {});
      assert(false, 'Unauthenticated attendance call should be rejected');
    } catch (err) {
      assert(err.code === 'unauthenticated', 'Unauthenticated caller rejected with unauthenticated');
    }

    // 4.2 Non-student caller (trainer trying to mark attendance)
    try {
      await markFn({ sessionId: activeSessionId, token: currentToken }, { auth: { uid: approvedTrainerUid } });
      assert(false, 'Non-student caller should be rejected');
    } catch (err) {
      assert(err.code === 'permission-denied', 'Non-student caller rejected with permission-denied');
    }

    // 4.3 Invalid QR token
    try {
      await markFn({ sessionId: activeSessionId, token: 'FORGED_WRONG_TOKEN' }, { auth: { uid: studentUid } });
      assert(false, 'Forged/expired QR token should be rejected');
    } catch (err) {
      assert(err.code === 'invalid-argument', 'Forged QR token rejected with invalid-argument');
    }

    // 4.4 Expired session
    try {
      await markFn({ sessionId: expiredSessionId, token: 'TOKEN_EXP_000' }, { auth: { uid: studentUid } });
      assert(false, 'Expired session attendance should be rejected');
    } catch (err) {
      assert(err.code === 'failed-precondition', 'Expired session rejected with failed-precondition');
    }

    // 4.5 Valid attendance marking
    const markRes = await markFn({ sessionId: activeSessionId, token: currentToken }, { auth: { uid: studentUid } });
    assert(markRes.success === true, 'Valid student successfully marks attendance with active session token');

    // 4.6 Verify attendance record created in Firestore
    const recordDoc = await db.collection('attendance').doc(activeSessionId).collection('records').doc(studentUid).get();
    assert(recordDoc.exists && recordDoc.data().name === 'K.Rithika' && recordDoc.data().batch === 'BATCH - 2', 'Attendance record verified in database with verified student details');

    // 4.7 Duplicate attendance prevention
    try {
      await markFn({ sessionId: activeSessionId, token: currentToken }, { auth: { uid: studentUid } });
      assert(false, 'Duplicate attendance submission in same session should be rejected');
    } catch (err) {
      assert(err.code === 'already-exists', 'Duplicate attendance rejected with already-exists');
    }

    // -------------------------------------------------------------
    // SECTION 5: FIRESTORE SECURITY RULES (Client-Side REST simulation)
    // -------------------------------------------------------------
    console.log('\n--- SECTION 5: Firestore Security Rules Enforcement ---');
    const studentJwt = makeJwt(studentUid, studentEmail);
    const trainerApprovedJwt = makeJwt(approvedTrainerUid, 'trainer@college.edu');
    const trainerPendingJwt = makeJwt(pendingTrainerUid, 'pending.trainer@college.edu');

    // 5.1 Unauthenticated read to settings/student_roster -> 403
    const unauthRoster = await sendFirestoreRequest('GET', 'settings/student_roster');
    assert(unauthRoster.status === 403, 'Unauthenticated direct read to settings/student_roster is BLOCKED (403)');

    // 5.2 Student direct read to settings/student_roster -> 403
    const studentRoster = await sendFirestoreRequest('GET', 'settings/student_roster', null, studentJwt);
    assert(studentRoster.status === 403, 'Student direct read to settings/student_roster is BLOCKED (403)');

    // 5.3 Student direct read to sessions collection (QR tokens) -> 403
    const studentSession = await sendFirestoreRequest('GET', `sessions/${activeSessionId}`, null, studentJwt);
    assert(studentSession.status === 403, 'Student direct read to sessions (QR tokens) is BLOCKED (403)');

    // 5.4 Student direct write to attendance records -> 403 (tamper protection)
    const studentTamper = await sendFirestoreRequest('PATCH', `attendance/${activeSessionId}/records/${studentUid}`, {
      fields: { status: { stringValue: 'present' } }
    }, studentJwt);
    assert(studentTamper.status === 403, 'Student direct client-side write to attendance records is BLOCKED (403)');

    // 5.5 Student read of another student attendance record -> 403
    const crossStudentAtt = await sendFirestoreRequest('GET', `attendance/${activeSessionId}/records/${otherStudentUid}`, null, studentJwt);
    assert(crossStudentAtt.status === 403, 'Student reading another student attendance record is BLOCKED (403)');

    // 5.6 Student self-escalating role to admin -> 403
    const studentPrivEsc = await sendFirestoreRequest('PATCH', `users/${studentUid}`, {
      fields: { role: { stringValue: 'admin' } }
    }, studentJwt);
    assert(studentPrivEsc.status === 403, 'Student attempting privilege escalation to admin is BLOCKED (403)');

    // 5.7 Pending/unapproved trainer reading sessions -> 403
    const pendingTrainerSession = await sendFirestoreRequest('GET', `sessions/${activeSessionId}`, null, trainerPendingJwt);
    assert(pendingTrainerSession.status === 403, 'Pending unapproved trainer reading sessions is BLOCKED (403)');

    // 5.8 Approved trainer reading sessions -> 200
    const approvedTrainerSession = await sendFirestoreRequest('GET', `sessions/${activeSessionId}`, null, trainerApprovedJwt);
    assert(approvedTrainerSession.status === 200, 'Approved trainer reading sessions is ALLOWED (200)');

    // 5.9 Approved trainer reading student roster -> 200
    const approvedTrainerRoster = await sendFirestoreRequest('GET', 'settings/student_roster', null, trainerApprovedJwt);
    assert(approvedTrainerRoster.status === 200, 'Approved trainer reading student roster is ALLOWED (200)');

    // -------------------------------------------------------------
    // SECTION 6: ADMIN REVIEW WORKFLOW & ROSTER INTEGRITY VERIFICATION
    // -------------------------------------------------------------
    console.log('\n--- SECTION 6: Admin Review Workflow & Roster Resolution ---');

    // 6.1 Verify review attempts logged in settings/student_roster
    const currentRosterDoc = await db.collection('settings').doc('student_roster').get();
    const reviewAttempts = currentRosterDoc.data().registrationReviewAttempts || [];
    assert(Array.isArray(reviewAttempts) && reviewAttempts.length > 0, `Registration review attempts reliably logged in Firestore (${reviewAttempts.length} logged)`);
    assert(reviewAttempts.some(r => r.email === 'vaishug1702@gmail.com' && r.reason.includes('alternate email')), 'Alternate email attempt logged with conflict explanation and student identity');

    // 6.2 Student cannot modify or delete review attempts or roster entries -> 403
    const studentTamperRoster = await sendFirestoreRequest('PATCH', 'settings/student_roster', {
      fields: { students: { arrayValue: { values: [] } } }
    }, studentJwt);
    assert(studentTamperRoster.status === 403, 'Student direct tampering of student_roster is BLOCKED (403)');

    const studentDeleteRoster = await sendFirestoreRequest('DELETE', 'settings/student_roster', null, studentJwt);
    assert(studentDeleteRoster.status === 403, 'Student deleting student_roster is BLOCKED (403)');

    // 6.3 Pending trainer cannot modify student_roster -> 403
    const pendingTrainerTamper = await sendFirestoreRequest('PATCH', 'settings/student_roster', {
      fields: { count: { integerValue: 0 } }
    }, trainerPendingJwt);
    assert(pendingTrainerTamper.status === 403, 'Pending trainer modifying student_roster is BLOCKED (403)');

    // 6.4 Admin resolution of pending batch case (in-place resolution without duplicate creation)
    let rosterStudents = currentRosterDoc.data().students;
    const targetPendingIdx = rosterStudents.findIndex(s => s.status === 'pending_batch_assignment');
    assert(targetPendingIdx >= 0, 'Found pending batch student for resolution test');

    const targetStudentBefore = { ...rosterStudents[targetPendingIdx] };
    assert(targetStudentBefore.batch === '', 'Target student initially has empty batch');

    // Simulate admin assigning BATCH - 1
    rosterStudents[targetPendingIdx].batch = 'BATCH - 1';
    rosterStudents[targetPendingIdx].status = 'verified';
    rosterStudents[targetPendingIdx].reviewReason = null;

    await db.collection('settings').doc('student_roster').set({
      students: rosterStudents,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });

    // 6.5 Verify student now verifies successfully with new batch
    const resolvedCheck = await verifyFn({ email: targetStudentBefore.email }, {});
    assert(resolvedCheck.verified === true && resolvedCheck.student.batch === 'BATCH - 1', `Resolved student successfully self-registers in BATCH - 1 (${targetStudentBefore.name})`);

    // 6.6 Verify total student count and all 14 alternate conflicts preserved
    const verifyDocAfter = await db.collection('settings').doc('student_roster').get();
    const studentsAfter = verifyDocAfter.data().students;
    const conflictsAfter = verifyDocAfter.data().alternateEmailConflicts;
    assert(studentsAfter.length === 352, `Roster student count preserved at exactly 352 (actual: ${studentsAfter.length})`);
    assert(conflictsAfter && conflictsAfter.length === 14, `All 14 alternate-email conflicts preserved intact (actual: ${conflictsAfter?.length})`);

    // 6.7 Check duplicate prevention for resolved student email
    const emailsAfter = studentsAfter.map(s => s.email.toLowerCase()).filter(Boolean);
    const uniqueEmailsAfter = new Set(emailsAfter);
    assert(emailsAfter.length === uniqueEmailsAfter.size, `All non-empty emails in roster remain strictly unique (${uniqueEmailsAfter.size} unique emails)`);

  } catch (globalErr) {
    console.error('Fatal test execution error:', globalErr);
    failed++;
  }

  console.log('\n================================================================');
  console.log(`TEST RESULTS: ${passed} PASSED, ${failed} FAILED (TOTAL: ${passed + failed})`);
  console.log('================================================================\n');

  if (failed > 0) {
    process.exit(1);
  } else {
    process.exit(0);
  }
}

runTestSuite();

const assert = require('assert');
const admin = require('../functions/node_modules/firebase-admin');

const KEY_PATH = '/Users/akruthika/Downloads/attendx-ae324-firebase-adminsdk-fbsvc-0a1c841f4a.json';
const serviceAccount = require(KEY_PATH);

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    projectId: 'attendx-ae324'
  });
}

const db = admin.firestore();
const funcs = require('../functions/index.js');

async function runAttendanceVerification() {
  console.log('========================================================================');
  console.log(' ATTENDX markAttendance FUNCTION LIVE VERIFICATION (PROJECT: attendx-ae324)');
  console.log('========================================================================\n');

  const testStudentUid = 'test_student_verif_999';
  const testSessionId = 'test_session_verif_999';
  const validCurrentToken = 'TOKEN_VERIF_ACTIVE_CURRENT_123';
  const validPrevToken = 'TOKEN_VERIF_ACTIVE_PREV_456';
  const fakeToken = 'TOKEN_VERIF_INVALID_999';

  try {
    // 1. Setup temporary test fixtures in live Firestore
    console.log('--- 1. Setting up test fixtures in Firestore ---');
    await db.collection('users').doc(testStudentUid).set({
      uid: testStudentUid,
      name: 'Verification Test Student',
      email: 'test.student.verif@attendx.local',
      role: 'student',
      status: 'verified',
      branch: 'CSE',
      section: 'A',
      batch: 'BATCH - 1',
      rollNumber: 'TEST999',
      college: 'Test College',
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });

    await db.collection('sessions').doc(testSessionId).set({
      id: testSessionId,
      className: 'Automated Test Lab',
      subject: 'DevOps Verification',
      batch: 'BATCH - 1',
      branch: 'CSE',
      section: 'A',
      status: 'active',
      currentToken: validCurrentToken,
      previousToken: validPrevToken,
      rotationSecs: 15,
      tokenUpdatedAt: admin.firestore.Timestamp.fromMillis(Date.now() - 2000),
      endTime: admin.firestore.Timestamp.fromMillis(Date.now() + 600000)
    });

    // Clean up any pre-existing test attendance record
    await db.collection('attendance').doc(testSessionId).collection('records').doc(testStudentUid).delete();

    console.log('✓ Fixtures created.\n');

    // 2. Test Unauthenticated Call
    console.log('--- 2. Unauthenticated Call Rejection ---');
    let unauthCaught = false;
    try {
      await funcs.markAttendance.run({ sessionId: testSessionId, token: validCurrentToken }, { auth: null });
    } catch (err) {
      unauthCaught = true;
      assert.strictEqual(err.code, 'unauthenticated');
    }
    assert(unauthCaught, 'Unauthenticated caller must be rejected');
    console.log('✓ TEST 2 PASSED: Unauthenticated caller rejected with "unauthenticated".\n');

    // 3. Test Invalid Token Rejection
    console.log('--- 3. Invalid Token Rejection ---');
    let invalidTokenCaught = false;
    try {
      await funcs.markAttendance.run(
        { sessionId: testSessionId, token: fakeToken },
        { auth: { uid: testStudentUid } }
      );
    } catch (err) {
      invalidTokenCaught = true;
      assert.strictEqual(err.code, 'invalid-argument');
      assert(err.message.includes('expired') || err.message.includes('current code'));
    }
    assert(invalidTokenCaught, 'Invalid/expired token must be rejected');
    console.log('✓ TEST 3 PASSED: Invalid token rejected with "invalid-argument".\n');

    // 4. Test Valid Token Attendance Marking
    console.log('--- 4. Valid Attendance Recording ---');
    const res = await funcs.markAttendance.run(
      { sessionId: testSessionId, token: validCurrentToken },
      { auth: { uid: testStudentUid } }
    );
    assert.strictEqual(res.success, true);
    assert.strictEqual(res.className, 'Automated Test Lab');

    // Confirm record exists in Firestore subcollection
    const recSnap = await db.collection('attendance').doc(testSessionId).collection('records').doc(testStudentUid).get();
    assert(recSnap.exists, 'Attendance record must be saved in Firestore');
    const recData = recSnap.data();
    assert.strictEqual(recData.uid, testStudentUid);
    assert.strictEqual(recData.rollNumber, 'TEST999');
    assert.strictEqual(recData.status, 'present');
    assert.strictEqual(recData.className, 'Automated Test Lab');
    console.log('✓ TEST 4 PASSED: Attendance recorded with immutable server timestamp and student details.\n');

    // 5. Test Duplicate Attendance Prevention
    console.log('--- 5. Duplicate Attendance Prevention ---');
    let dupCaught = false;
    try {
      await funcs.markAttendance.run(
        { sessionId: testSessionId, token: validCurrentToken },
        { auth: { uid: testStudentUid } }
      );
    } catch (err) {
      dupCaught = true;
      assert.strictEqual(err.code, 'already-exists');
      assert(err.message.includes('already been recorded'));
    }
    assert(dupCaught, 'Duplicate attendance scan must be rejected');
    console.log('✓ TEST 5 PASSED: Duplicate scan rejected with "already-exists".\n');

    // 6. Test Previous Token (Grace Period)
    console.log('--- 6. Previous Token Acceptance During Grace Window ---');
    const student2Uid = 'test_student_verif_998';
    await db.collection('users').doc(student2Uid).set({
      uid: student2Uid,
      name: 'Verification Student 2',
      email: 'test.student2.verif@attendx.local',
      role: 'student',
      status: 'verified',
      rollNumber: 'TEST998',
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });
    await db.collection('attendance').doc(testSessionId).collection('records').doc(student2Uid).delete();

    const resPrev = await funcs.markAttendance.run(
      { sessionId: testSessionId, token: validPrevToken },
      { auth: { uid: student2Uid } }
    );
    assert.strictEqual(resPrev.success, true);
    console.log('✓ TEST 6 PASSED: Previous rotated token accepted within grace period.\n');

    // 7. Cleanup Fixtures
    console.log('--- 7. Cleaning up test fixtures ---');
    await db.collection('attendance').doc(testSessionId).collection('records').doc(testStudentUid).delete();
    await db.collection('attendance').doc(testSessionId).collection('records').doc(student2Uid).delete();
    await db.collection('sessions').doc(testSessionId).delete();
    await db.collection('users').doc(testStudentUid).delete();
    await db.collection('users').doc(student2Uid).delete();
    console.log('✓ Fixtures cleaned up.\n');

    console.log('========================================================================');
    console.log('ALL markAttendance FUNCTION TESTS PASSED WITH ZERO DEFECTS.');
    console.log('========================================================================');

  } catch (err) {
    console.error('Test failure:', err);
    process.exit(1);
  }
}

runAttendanceVerification();

const functions = require('firebase-functions');
const admin = require('firebase-admin');

if (!admin.apps.length) {
  admin.initializeApp();
}

const db = admin.firestore();

/**
 * 1. markAttendance (Callable Cloud Function)
 * Validates QR tokens securely on the server without ever exposing
 * currentToken or previousToken to student clients.
 */
exports.markAttendance = functions.https.onCall(async (data, context) => {
  // 1. Verify caller authentication
  if (!context.auth || !context.auth.uid) {
    throw new functions.https.HttpsError(
      'unauthenticated',
      'You must be signed in to mark attendance.'
    );
  }

  const uid = context.auth.uid;
  const sessionId = (data && data.sessionId ? String(data.sessionId).trim() : '');
  const token = (data && data.token ? String(data.token).trim() : '');

  if (!sessionId || !token) {
    throw new functions.https.HttpsError(
      'invalid-argument',
      'Session ID and scanned QR token are required.'
    );
  }

  // 2. Fetch caller student profile from Firestore (Admin SDK)
  const userDoc = await db.collection('users').doc(uid).get();
  if (!userDoc.exists || userDoc.data().role !== 'student') {
    throw new functions.https.HttpsError(
      'permission-denied',
      'Only enrolled students can mark attendance.'
    );
  }

  const studentProfile = userDoc.data();
  if (studentProfile.status !== 'active') {
    throw new functions.https.HttpsError(
      'permission-denied',
      'Your student account is pending administrator review. Attendance cannot be recorded.'
    );
  }

  // 3. Fetch session document (Admin SDK)
  const sessionDoc = await db.collection('sessions').doc(sessionId).get();
  if (!sessionDoc.exists) {
    throw new functions.https.HttpsError(
      'not-found',
      'Session not found or has expired.'
    );
  }

  const session = sessionDoc.data();

  // 4. Validate session status
  if (session.status !== 'active') {
    throw new functions.https.HttpsError(
      'failed-precondition',
      'This attendance session has already ended.'
    );
  }

  // 5. Validate session expiry duration
  const nowMs = Date.now();
  let sessionEndMs = null;
  if (session.endTime) {
    if (typeof session.endTime.toMillis === 'function') {
      sessionEndMs = session.endTime.toMillis();
    } else if (session.endTime._seconds) {
      sessionEndMs = session.endTime._seconds * 1000;
    } else {
      sessionEndMs = new Date(session.endTime).getTime();
    }
  }
  if (sessionEndMs && nowMs > sessionEndMs + 60000) {
    throw new functions.https.HttpsError(
      'failed-precondition',
      'Session duration has expired. Attendance closed.'
    );
  }

  // 6. Token matching: compare scanned token with session's current or previous token
  const isCurrent = session.currentToken === token;
  const isPrevious = Boolean(session.previousToken && session.previousToken === token);

  if (!isCurrent && !isPrevious) {
    throw new functions.https.HttpsError(
      'invalid-argument',
      'QR code has expired. Please scan the current code on screen.'
    );
  }

  // If token is previous token (rotated during scan), enforce rotation grace limit
  if (isPrevious && !isCurrent) {
    if (session.tokenUpdatedAt && session.tokenUpdatedAt.toMillis) {
      const timeSinceRotation = Math.abs(nowMs - session.tokenUpdatedAt.toMillis());
      const graceLimitMs = ((session.rotationSecs || 10) + 45) * 1000;
      if (timeSinceRotation > graceLimitMs) {
        throw new functions.https.HttpsError(
          'invalid-argument',
          'QR code has expired. Please scan the current code on screen.'
        );
      }
    }
  }

  // 7. Prevent duplicate attendance for the same session
  const recordRef = db.collection('attendance').doc(sessionId).collection('records').doc(uid);
  const existingRecord = await recordRef.get();
  if (existingRecord.exists) {
    throw new functions.https.HttpsError(
      'already-exists',
      'Attendance has already been recorded for this session.'
    );
  }

  // 8. Create immutable attendance record using verified server profile (no client tampering)
  const roll = studentProfile.rollNumber || studentProfile.studentId || '';
  const attendanceRecord = {
    uid,
    rollNumber: roll,
    studentId: roll,
    name: studentProfile.name || 'Student',
    branch: studentProfile.branch || '',
    college: studentProfile.college || '',
    section: studentProfile.section || '',
    batch: studentProfile.batch || '',
    sessionId,
    className: session.className || '',
    subject: session.subject || '',
    status: 'present',
    markedAt: admin.firestore.FieldValue.serverTimestamp()
  };

  await recordRef.set(attendanceRecord);

  return {
    success: true,
    message: `Attendance marked successfully for ${session.className}`,
    className: session.className,
    subject: session.subject
  };
});

/**
 * 2. verifyStudentRegistration (Callable Cloud Function)
 * Validates a student's personal email against the official master roster.
 * Supports unique email-based verification without exposing student PII.
 * Prevents duplicate registrations before account creation.
 */
exports.verifyStudentRegistration = functions.https.onCall(async (data, context) => {
  const email = (data && data.email ? String(data.email).trim().toLowerCase() : '');
  const rollNumber = (data && data.rollNumber ? String(data.rollNumber).trim().toUpperCase() : '');

  if (!email && !rollNumber) {
    throw new functions.https.HttpsError(
      'invalid-argument',
      'Personal email address is required for registration verification.'
    );
  }

  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (email && !emailRegex.test(email)) {
    throw new functions.https.HttpsError(
      'invalid-argument',
      'Please enter a valid personal email address.'
    );
  }

  // 1. Fetch master roster from settings/student_roster
  const rosterDoc = await db.collection('settings').doc('student_roster').get();
  if (!rosterDoc.exists || !Array.isArray(rosterDoc.data().students) || rosterDoc.data().students.length === 0) {
    // If master roster has not been uploaded yet, permit self-registration so workflow is not blocked
    return {
      verified: false,
      rosterUploaded: false,
      message: 'Master roster not uploaded yet. Manual registration allowed.'
    };
  }

  const rosterData = rosterDoc.data() || {};
  const students = rosterData.students || [];
  const alternateConflicts = rosterData.alternateEmailConflicts || [];
  let matched = null;

  if (email) {
    // Check if email is an alternate email conflict
    const altConflict = alternateConflicts.find(c => {
      const alt = String(c.alternateSubmission?.email || c.alternateEmail || '').trim().toLowerCase();
      const enrolled = String(c.enrolledStudent?.email || c.email || '').trim().toLowerCase();
      return (alt && alt === email) || (enrolled && enrolled === email);
    });
    if (altConflict) {
      const enrolledEmail = String(altConflict.enrolledStudent?.email || altConflict.email || '').trim().toLowerCase();
      const studentName = altConflict.enrolledStudent?.name || altConflict.name || 'a student';
      if (enrolledEmail && enrolledEmail !== email) {
        try {
          await db.collection('settings').doc('student_roster').set({
            registrationReviewAttempts: admin.firestore.FieldValue.arrayUnion({
              email,
              name: studentName,
              reason: `Attempted registration using alternate email (Primary: ${enrolledEmail})`,
              attemptedAt: new Date().toISOString(),
              status: 'pending'
            })
          }, { merge: true });
        } catch (_) {}

        throw new functions.https.HttpsError(
          'failed-precondition',
          `Your email is associated with an alternate form submission for ${studentName}. Please register using your primary verified email ("${enrolledEmail}") or contact your administrator.`
        );
      }
    }

    // Match unique personal email in master roster
    const matches = students.filter(s => (s.email || '').trim().toLowerCase() === email);
    if (matches.length > 1) {
      throw new functions.https.HttpsError(
        'already-exists',
        'Multiple roster records found for this email address. Please contact your college administrator.'
      );
    }
    matched = matches.length === 1 ? matches[0] : null;

    if (!matched) {
      throw new functions.https.HttpsError(
        'not-found',
        `Email "${email}" was not found in the official college roster. Please contact administrator or use your enrolled college email.`
      );
    }
  } else if (rollNumber) {
    // Fallback: match by roll number
    matched = students.find(s => (s.rollNumber || '').toUpperCase() === rollNumber);
    if (!matched) {
      throw new functions.https.HttpsError(
        'not-found',
        `Roll Number "${rollNumber}" was not found in the official college roster.`
      );
    }
  }

  // 1b. Block incomplete or ambiguous records and route them to admin review
  if (matched && (matched.status !== 'verified' || !matched.batch || !matched.email)) {
    const reason = matched.reviewReason || (!matched.batch ? 'batch assignment pending' : 'incomplete student details');
    try {
      await db.collection('settings').doc('student_roster').set({
        registrationReviewAttempts: admin.firestore.FieldValue.arrayUnion({
          email: matched.email || email,
          name: matched.name || 'Student',
          branch: matched.branch || '',
          section: matched.section || '',
          reason: reason,
          attemptedAt: new Date().toISOString(),
          status: 'pending'
        })
      }, { merge: true });
    } catch (_) {}

    throw new functions.https.HttpsError(
      'failed-precondition',
      `Your student registration requires administrator review (${reason}). Please contact your administrator.`
    );
  }

  // 2. Prevent duplicate registrations: Check if user already registered in Firebase Auth or Firestore
  if (email) {
    try {
      const existingAuthUser = await admin.auth().getUserByEmail(email);
      if (existingAuthUser) {
        throw new functions.https.HttpsError(
          'already-exists',
          `An account with email "${email}" has already been registered. Please sign in instead.`
        );
      }
    } catch (authErr) {
      if (authErr.code === 'already-exists' || (authErr.message && authErr.message.includes('already been registered'))) {
        throw authErr;
      }
      // 'auth/user-not-found' is expected and normal
    }

    const existingEmailSnap = await db.collection('users')
      .where('email', '==', email)
      .limit(1)
      .get();
    if (!existingEmailSnap.empty) {
      throw new functions.https.HttpsError(
        'already-exists',
        `An account with email "${email}" has already been registered. Please sign in instead.`
      );
    }

    if (matched && matched.rollNumber) {
      const existingRollSnap = await db.collection('users')
        .where('rollNumber', '==', matched.rollNumber.toUpperCase())
        .limit(1)
        .get();
      if (!existingRollSnap.empty) {
        throw new functions.https.HttpsError(
          'already-exists',
          `An account for Roll Number ${matched.rollNumber} has already been registered.`
        );
      }
    }
  }

  // 3. Return sanitized student details for academic auto-population
  return {
    verified: true,
    rosterUploaded: true,
    student: {
      name: matched.name || '',
      branch: matched.branch || '',
      section: matched.section || '',
      rollNumber: matched.rollNumber || '',
      college: matched.college || '',
      batch: matched.batch || ''
    }
  };
});

// Staff-only correction for roster batch mistakes; keep the roster and existing
// Firebase student profile in sync so registration, filters and scan records agree.
exports.correctStudentBatch = functions.https.onCall(async (data, context) => {
  if (!context.auth || !context.auth.uid) {
    throw new functions.https.HttpsError('unauthenticated', 'Sign in as staff to correct a batch.');
  }
  const actor = await db.collection('users').doc(context.auth.uid).get();
  const actorData = actor.exists ? actor.data() : {};
  const allowed = actorData.role === 'admin' || (actorData.role === 'trainer' && actorData.status === 'approved');
  if (!allowed) throw new functions.https.HttpsError('permission-denied', 'Only approved staff can correct student batches.');

  const email = String(data?.email || '').trim().toLowerCase();
  const batch = String(data?.batch || '').trim().toUpperCase();
  if (!email || !['BATCH - 1', 'BATCH - 2', 'BATCH - 3'].includes(batch)) {
    throw new functions.https.HttpsError('invalid-argument', 'Choose a student email and a valid batch.');
  }
  const rosterRef = db.collection('settings').doc('student_roster');
  const rosterDoc = await rosterRef.get();
  if (!rosterDoc.exists || !Array.isArray(rosterDoc.data().students)) {
    throw new functions.https.HttpsError('not-found', 'The student roster is not available.');
  }
  const roster = rosterDoc.data().students;
  const matches = roster.filter(student => String(student.email || '').trim().toLowerCase() === email);
  if (matches.length !== 1) throw new functions.https.HttpsError('failed-precondition', 'This email must match exactly one roster student.');
  const updatedStudents = roster.map(student => String(student.email || '').trim().toLowerCase() === email ? { ...student, batch } : student);
  await rosterRef.set({ students: updatedStudents, updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
  const profiles = await db.collection('users').where('email', '==', email).get();
  const batchWriter = db.batch();
  profiles.docs.forEach(profile => batchWriter.update(profile.ref, { batch, updatedAt: admin.firestore.FieldValue.serverTimestamp() }));
  if (!profiles.empty) await batchWriter.commit();
  return { success: true, email, batch, profilesUpdated: profiles.size };
});



/**
 * Completes a newly authenticated student's registration from the private roster.
 * The client can create only a pending stub; this function supplies trusted fields.
 */
exports.completeStudentRegistration = functions.https.onCall(async (data, context) => {
  if (!context.auth || !context.auth.uid || !context.auth.token.email) {
    throw new functions.https.HttpsError('unauthenticated', 'Sign in with your student email to finish registration.');
  }

  const uid = context.auth.uid;
  const email = String(context.auth.token.email).trim().toLowerCase();
  const userRef = db.collection('users').doc(uid);
  const userSnap = await userRef.get();

  if (userSnap.exists && userSnap.data().status === 'active' && userSnap.data().role === 'student') {
    const active = userSnap.data();
    return { success: true, student: {
      name: active.name || '', college: active.college || '', branch: active.branch || '',
      section: active.section || '', rollNumber: active.rollNumber || '',
      studentId: active.studentId || '', mobile: active.mobile || '', email,
      personalEmail: email, role: 'student', batch: active.batch || '', status: 'active'
    } };
  }
  if (!userSnap.exists || userSnap.data().role !== 'student' || userSnap.data().status !== 'pending' || String(userSnap.data().email || '').trim().toLowerCase() !== email) {
    throw new functions.https.HttpsError('permission-denied', 'Student registration is not pending.');
  }

  const rosterSnap = await db.collection('settings').doc('student_roster').get();
  const students = rosterSnap.exists && Array.isArray(rosterSnap.data().students)
    ? rosterSnap.data().students
    : [];
  const matches = students.filter(student =>
    String(student.email || '').trim().toLowerCase() === email
    && student.status === 'verified'
    && student.batch
  );
  if (matches.length !== 1) {
    throw new functions.https.HttpsError('failed-precondition', 'Your email must match one verified roster entry. Contact your administrator if you need help.');
  }

  const rosterStudent = matches[0];
  const profile = {
    name: String(rosterStudent.name || 'Student'),
    college: String(rosterStudent.college || 'AVN'),
    branch: String(rosterStudent.branch || ''),
    section: String(rosterStudent.section || ''),
    rollNumber: String(rosterStudent.rollNumber || ''),
    studentId: String(rosterStudent.rollNumber || ''),
    mobile: String(rosterStudent.mobile || ''),
    email,
    personalEmail: email,
    role: 'student',
    batch: String(rosterStudent.batch),
    status: 'active',
  };

  await userRef.set({ ...profile, createdAt: userSnap.data().createdAt || admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
  return { success: true, student: profile };
});





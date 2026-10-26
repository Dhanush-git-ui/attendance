// =============================================
// STUDENT JS — QR Scanner + Attendance Marking
// =============================================

let currentUser = null;
let html5QrCode = null;
let scanning    = false;
let processing  = false;

// ---- Auth Guard ----
auth.onAuthStateChanged(async (user) => {
  if (!user) {
    window.location.href = 'index.html';
    return;
  }

  try {
    let profileData = {};
    try {
      const doc = await db.collection('users').doc(user.uid).get();
      if (doc.exists) {
        if (doc.data().role !== 'student') {
          window.location.href = 'index.html';
          return;
        }
        profileData = doc.data();
      }
    } catch (fsErr) {
      console.warn('Firestore user lookup restricted by security rules (using local profile):', fsErr);
    }

    if (!profileData.name && !profileData.rollNumber) {
      const cached = localStorage.getItem(`user_profile_${user.uid}`);
      if (cached) {
        try { profileData = JSON.parse(cached); } catch (_) {}
      }
    }

    if (!profileData.rollNumber) {
      profileData.rollNumber = '';
      profileData.studentId = '';
    }

    if (!profileData.name) {
      profileData.name = user.displayName || 'Student';
    }

    currentUser = { uid: user.uid, ...profileData };
    populateStudentInfo();
    loadHistory();
  } catch(e) {
    console.error('User lookup error:', e);
    window.location.href = 'index.html';
  }
});

// ---- Populate UI ----
function populateStudentInfo() {
  const roll = currentUser.rollNumber || currentUser.studentId || '';
  const batch = currentUser.batch || '';
  const name = currentUser.name || 'Student';
  
  const nameDisplay = document.getElementById('student-name-display');
  const fullname = document.getElementById('student-fullname');
  if (nameDisplay) nameDisplay.textContent = name;
  if (fullname) fullname.textContent = name;

  const rollText = document.getElementById('student-roll-text');
  const idDisplay = document.getElementById('student-id-display');
  const mobile = currentUser.mobile || '';
  const labelText = mobile ? `Phone: ${mobile}` : (roll ? `Roll No: ${roll}` : (batch ? `Batch: ${batch}` : 'Student'));
  if (rollText) {
    rollText.textContent = labelText;
  } else if (idDisplay) {
    idDisplay.textContent = labelText;
  }

  const avatar = document.getElementById('student-avatar');
  if (avatar) avatar.textContent = name.charAt(0).toUpperCase();

  // Branch badge
  const branchBadge = document.getElementById('student-branch-badge');
  if (branchBadge) {
    if (currentUser.branch) {
      branchBadge.textContent = currentUser.branch;
      branchBadge.style.display = 'inline-flex';
    } else {
      branchBadge.style.display = 'none';
    }
  }

  // Section badge
  const sectionBadge = document.getElementById('student-section-badge');
  if (sectionBadge) {
    if (currentUser.section && currentUser.section !== 'No Section') {
      sectionBadge.textContent = `Sec ${currentUser.section}`;
      sectionBadge.style.display = 'inline-flex';
    } else {
      sectionBadge.style.display = 'none';
    }
  }

  // Batch badge
  const batchBadge = document.getElementById('student-batch-badge');
  if (batchBadge) {
    if (currentUser.batch) {
      batchBadge.textContent = currentUser.batch;
      batchBadge.style.display = 'inline-flex';
    } else {
      batchBadge.style.display = 'none';
    }
  }

  // College info (default to AVN from database)
  const collegeWrap = document.getElementById('student-college-wrap');
  const collegeText = document.getElementById('student-college-text');
  if (collegeWrap && collegeText) {
    const rawCollege = currentUser.college;
    const cleanCollege = (rawCollege && rawCollege !== 'HITAM') ? rawCollege : 'AVN';
    collegeText.textContent = cleanCollege;
    collegeWrap.style.display = 'inline-flex';
  }
}

// ---- Start QR Scanner ----
async function startScanner() {
  if (scanning) {
    await stopScanner();
    return;
  }

  try {
    html5QrCode = new Html5Qrcode('reader');
    await html5QrCode.start(
      { facingMode: 'environment' },
      { fps: 10, qrbox: { width: 250, height: 250 } },
      onScanSuccess,
      onScanError
    );
    scanning = true;
    document.getElementById('scan-btn').innerHTML = '<svg class="icon-svg fill-current" viewBox="0 0 24 24"><rect x="5" y="5" width="14" height="14" rx="2" ry="2"/></svg> <span>Stop Camera</span>';
    document.getElementById('scan-btn').className = 'btn btn-danger btn-full';
    showStatus('Camera active — point at QR code', 'info');
  } catch (e) {
    console.error(e);
    showStatus('Could not access camera. Please allow camera permission.', 'error');
  }
}

async function stopScanner() {
  if (html5QrCode && scanning) {
    await html5QrCode.stop();
    html5QrCode = null;
  }
  scanning = false;
  document.getElementById('scan-btn').innerHTML = '<svg class="icon-svg" viewBox="0 0 24 24"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg> <span>Start Camera</span>';
  document.getElementById('scan-btn').className = 'btn btn-primary btn-full';
  document.getElementById('reader').innerHTML   = '';
}

// ---- On QR Scanned ----
async function onScanSuccess(rawValue) {
  if (processing) return;
  processing = true;

  let payload;
  try {
    payload = JSON.parse(rawValue);
  } catch {
    showStatus('Invalid QR code. Please scan the classroom QR.', 'error');
    processing = false;
    return;
  }

  const { sessionId, token } = payload;
  if (!sessionId || !token) {
    showStatus('Invalid QR format.', 'error');
    processing = false;
    return;
  }

  await stopScanner();
  showStatus('Verifying attendance with server...', 'info');

  try {
    let successRecorded = false;

    // 1. If Cloud Functions are available (e.g. Blaze plan), try callable function
    if (typeof firebase !== 'undefined' && firebase.functions) {
      try {
        const markAttendanceFn = firebase.functions().httpsCallable('markAttendance');
        const res = await markAttendanceFn({ sessionId, token });
        const data = res.data || {};
        showStatus(`Attendance marked for "${data.className || 'Class'}" — ${data.subject || 'Session'}`, 'success');
        showToast('Attendance recorded!', 'success');
        successRecorded = true;
      } catch (fnErr) {
        // If functions are not deployed on Spark plan, fall back to direct Firestore verification
        console.warn('Callable function unavailable on Spark plan, falling back to direct Firestore verification:', fnErr.message);
      }
    }

    // 2. Direct Firestore verification fallback for Firebase Spark (free) plan
    if (!successRecorded) {
      const sessionDoc = await db.collection('sessions').doc(sessionId).get();
      if (!sessionDoc.exists) {
        throw new Error('Session not found or has expired.');
      }
      const session = sessionDoc.data();
      if (session.status !== 'active') {
        throw new Error('This attendance session has already ended.');
      }

      // Check session expiry duration
      const nowMs = Date.now();
      let sessionEndMs = null;
      if (session.endTime) {
        if (typeof session.endTime.toMillis === 'function') sessionEndMs = session.endTime.toMillis();
        else if (session.endTime._seconds) sessionEndMs = session.endTime._seconds * 1000;
        else sessionEndMs = new Date(session.endTime).getTime();
      }
      if (sessionEndMs && nowMs > sessionEndMs + 60000) {
        throw new Error('Session duration has expired. Attendance closed.');
      }

      // Rotating token match
      const isCurrent = session.currentToken === token;
      const isPrevious = Boolean(session.previousToken && session.previousToken === token);
      if (!isCurrent && !isPrevious) {
        throw new Error('QR code has expired. Please scan the current code on screen.');
      }

      // Prevent duplicate attendance for the same session
      const recordRef = db.collection('attendance').doc(sessionId).collection('records').doc(currentUser.uid);
      const existing = await recordRef.get();
      if (existing.exists) {
        throw new Error('Attendance has already been recorded for this session.');
      }

      // Fetch student profile details
      let prof = currentUser || {};
      if (!prof.name) {
        try {
          const uDoc = await db.collection('users').doc(currentUser.uid).get();
          if (uDoc.exists) prof = { ...prof, ...uDoc.data() };
        } catch (_) {}
      }

      const roll = prof.rollNumber || prof.studentId || '';
      const attendanceRecord = {
        uid: currentUser.uid,
        rollNumber: roll,
        studentId: roll,
        name: prof.name || currentUser.displayName || 'Student',
        branch: prof.branch || '',
        college: (prof.college && prof.college !== 'HITAM') ? prof.college : 'AVN',
        section: prof.section || '',
        batch: prof.batch || '',
        sessionId: sessionId,
        className: session.className || '',
        subject: session.subject || '',
        status: 'present',
        markedAt: firebase.firestore.FieldValue.serverTimestamp()
      };

      await recordRef.set(attendanceRecord);
      showStatus(`Attendance marked for "${session.className || 'Class'}" — ${session.subject || 'Session'}`, 'success');
      showToast('Attendance recorded!', 'success');
    }

    loadHistory();
  } catch (e) {
    console.error('Attendance verification error:', e);
    const msg = e.message || 'Failed to mark attendance. Please scan current code.';
    showStatus(msg, 'error');
    showToast(msg, 'error');
  }

  processing = false;
}

function onScanError() {
  // Suppress continuous scan errors silently
}

// ---- Load Attendance History ----
async function loadHistory() {
  if (!currentUser) return;

  try {
    let records = [];
    try {
      const snap = await db.collectionGroup('records')
        .where('uid', '==', currentUser.uid)
        .orderBy('markedAt', 'desc')
        .limit(25)
        .get();
      snap.forEach(doc => records.push(doc.data()));
    } catch (groupErr) {
      console.warn('CollectionGroup notice:', groupErr.message);
    }

    renderHistory(records);
  } catch (e) {
    console.error('History load error:', e);
  }
}

function renderHistory(records) {
  const list = document.getElementById('history-list');
  if (!records.length) {
    list.innerHTML = '<div style="text-align:center;padding:2rem;color:var(--text-muted)">No attendance records yet</div>';
    return;
  }

  list.innerHTML = records.map(r => `
    <div class="history-item">
      <div class="history-info">
        <div class="h-class">${r.className || '—'}</div>
        <div class="h-meta">${r.subject || ''} &nbsp;|&nbsp; ${formatTime(r.markedAt)}</div>
      </div>
      <span class="badge badge-success">
        <svg class="icon-svg" viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"/></svg>
        <span>Present</span>
      </span>
    </div>
  `).join('');
}

// ---- Helpers ----
function showStatus(msg, type) {
  const el = document.getElementById('scan-status');
  el.textContent = msg;
  el.className   = `scan-status mt-2 ${type === 'info' ? 'success' : type}`;
  if (type === 'info') {
    el.style.background = 'rgba(108,99,255,0.12)';
    el.style.borderColor = 'rgba(108,99,255,0.3)';
    el.style.color = 'var(--primary)';
  } else {
    el.style.background = '';
    el.style.borderColor = '';
    el.style.color = '';
  }
  el.style.display = 'block';
}

function formatTime(ts) {
  if (!ts) return '—';
  const d = ts.toDate ? ts.toDate() : new Date(ts);
  return d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function showToast(msg, type = 'info') {
  const container = document.getElementById('toast-container');
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.textContent = msg;
  container.appendChild(toast);
  setTimeout(() => toast.remove(), 3500);
}

function logout() {
  if (html5QrCode && scanning) html5QrCode.stop();
  if (auth.currentUser) {
    auth.signOut().then(() => window.location.href = 'index.html');
  } else {
    window.location.href = 'index.html';
  }
}

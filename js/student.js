// =============================================
// STUDENT JS — QR Scanner + Attendance Marking
// =============================================

let currentUser = null;
let html5QrCode = null;
let scanning    = false;
let processing  = false;

// ---- Auth Guard ----
auth.onAuthStateChanged(async (user) => {
  if (!user) { window.location.href = 'index.html'; return; }
  const doc = await db.collection('users').doc(user.uid).get();
  if (!doc.exists || doc.data().role !== 'student') {
    window.location.href = 'index.html'; return;
  }
  currentUser = { uid: user.uid, ...doc.data() };
  populateStudentInfo();
  loadHistory();
});

// ---- Populate UI ----
function populateStudentInfo() {
  const roll = currentUser.rollNumber || currentUser.studentId || '—';
  document.getElementById('student-name-display').textContent = currentUser.name;
  document.getElementById('student-fullname').textContent     = currentUser.name;
  document.getElementById('student-id-display').textContent   = 'Roll No: ' + roll;
  document.getElementById('student-avatar').textContent       = currentUser.name.charAt(0).toUpperCase();
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
  showStatus('Verifying attendance...', 'info');

  try {
    // ---- VALIDATION CHECKS ----

    // 1. Fetch session
    const sessionSnap = await db.collection('sessions').doc(sessionId).get();
    if (!sessionSnap.exists) {
      showStatus('Session not found.', 'error');
      processing = false; return;
    }

    const session = sessionSnap.data();

    // 2. Session must be active
    if (session.status !== 'active') {
      showStatus('This session has already ended.', 'error');
      processing = false; return;
    }

    // 3. Token must match
    if (session.currentToken !== token) {
      showStatus('QR expired. Please scan the latest code on screen.', 'error');
      processing = false; return;
    }

    // 4. Token freshness (within rotationSecs + 2s buffer)
    const tokenAge = Date.now() - session.tokenUpdatedAt.toMillis();
    const maxAge   = (session.rotationSecs + 2) * 1000;
    if (tokenAge > maxAge) {
      showStatus('QR too old. Scan the current code.', 'error');
      processing = false; return;
    }

    // 5. Not already marked
    const existingRef = db.collection('attendance').doc(sessionId)
      .collection('records').doc(currentUser.uid);
    const existing = await existingRef.get();
    if (existing.exists) {
      showStatus('Attendance already marked for this session.', 'success');
      processing = false; return;
    }

    // ---- MARK ATTENDANCE ----
    const roll = currentUser.rollNumber || currentUser.studentId || '';
    await existingRef.set({
      name: currentUser.name,
      rollNumber: roll,
      studentId: roll,
      markedAt: firebase.firestore.FieldValue.serverTimestamp(),
      status: 'present',
      sessionId,
      className: session.className,
      subject: session.subject
    });

    showStatus(`Attendance marked for "${session.className}" — ${session.subject}`, 'success');
    showToast('Attendance recorded!', 'success');
    loadHistory();

  } catch (e) {
    console.error(e);
    showStatus('Failed to mark attendance. Please try again.', 'error');
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
    const snap = await db.collectionGroup('records')
      .where('studentId', '==', currentUser.studentId || '')
      .orderBy('markedAt', 'desc')
      .limit(20)
      .get();

    // Fallback: query by name if studentId doesn't match
    let records = [];
    snap.forEach(doc => records.push(doc.data()));

    if (!records.length) {
      // Try querying attendance collection directly by uid
      const sessions = await db.collection('sessions').limit(50).get();
      for (const sDoc of sessions.docs) {
        const record = await db.collection('attendance').doc(sDoc.id)
          .collection('records').doc(currentUser.uid).get();
        if (record.exists) {
          records.push({ ...record.data(), sessionId: sDoc.id });
        }
      }
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
  auth.signOut().then(() => window.location.href = 'index.html');
}

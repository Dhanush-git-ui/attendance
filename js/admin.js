// =============================================
// ADMIN JS — Session Management + Rotating QR
// =============================================

let currentUser   = null;
let currentSession = null;
let sessionDocRef  = null;
let qrInstance     = null;
let qrRotateInterval  = null;
let sessionEndTimeout = null;
let sessionTimerInterval = null;
let attendanceUnsubscribe = null;
let attendanceData = [];
let sessionEndTime = null;
let rotationSecs = 10;

// ---- Auth Guard ----
auth.onAuthStateChanged(async (user) => {
  if (!user) { window.location.href = 'index.html'; return; }
  const doc = await db.collection('users').doc(user.uid).get();
  if (!doc.exists || doc.data().role !== 'admin') {
    window.location.href = 'index.html'; return;
  }
  currentUser = { uid: user.uid, ...doc.data() };
  document.getElementById('admin-name-display').textContent = currentUser.name;
});

// ---- Start Session ----
async function startSession() {
  const className = document.getElementById('class-name').value.trim();
  const subject   = document.getElementById('subject').value.trim();
  const duration  = parseInt(document.getElementById('duration').value);
  rotationSecs    = parseInt(document.getElementById('rotation').value);

  if (!className || !subject) return showToast('Please fill in class name and subject.', 'error');

  document.getElementById('start-btn').disabled = true;
  document.getElementById('start-btn').innerHTML = '<span class="spinner"></span> Starting...';

  try {
    const token = generateToken();
    const now   = new Date();
    sessionEndTime = new Date(now.getTime() + duration * 1000);

    sessionDocRef = db.collection('sessions').doc();
    await sessionDocRef.set({
      id: sessionDocRef.id,
      className,
      subject,
      adminId: currentUser.uid,
      adminName: currentUser.name,
      startTime: firebase.firestore.FieldValue.serverTimestamp(),
      duration,
      status: 'active',
      currentToken: token,
      tokenUpdatedAt: firebase.firestore.FieldValue.serverTimestamp(),
      rotationSecs,
      endTime: firebase.firestore.Timestamp.fromDate(sessionEndTime)
    });

    currentSession = { id: sessionDocRef.id, className, subject, duration, rotationSecs };

    // Show active session card
    document.getElementById('active-session-card').style.display = 'block';
    document.getElementById('active-session-info').innerHTML = `
      <div class="card-sm">
        <div style="font-weight:700;font-size:1rem">${className}</div>
        <div style="color:var(--text-muted);font-size:0.85rem;margin-top:0.25rem">${subject}</div>
        <div class="mt-2" style="font-size:0.85rem;color:var(--text-muted)">Duration: ${formatDuration(duration)}</div>
      </div>
    `;

    // Update form button
    document.getElementById('start-btn').innerHTML = '<svg class="icon-svg" viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"/></svg> <span>Session Running</span>';

    // Start QR rotation
    renderQR(token);
    startQRRotation();

    // Auto end session after duration
    sessionEndTimeout = setTimeout(endSession, duration * 1000);

    // Live session timer
    startSessionTimer();

    // Listen for attendance
    listenAttendance();

    showToast(`Session started for ${className}`, 'success');
    showQRFullscreen();
    updateFullscreenInfo();

  } catch (e) {
    console.error(e);
    showToast('Failed to start session. Try again.', 'error');
    document.getElementById('start-btn').disabled = false;
    document.getElementById('start-btn').innerHTML = '<svg class="icon-svg fill-current" viewBox="0 0 24 24"><polygon points="5 3 19 12 5 21 5 3"/></svg> <span>Start Session</span>';
  }
}

// ---- Generate Token ----
function generateToken() {
  return Math.random().toString(36).substring(2, 10) + Date.now().toString(36);
}

// ---- Render QR ----
function renderQR(token) {
  const box = document.getElementById('qr-box');
  box.innerHTML = '';
  qrInstance = new QRCode(box, {
    text: JSON.stringify({ sessionId: currentSession.id, token }),
    width: 260,
    height: 260,
    colorDark: '#000000',
    colorLight: '#ffffff',
    correctLevel: QRCode.CorrectLevel.H
  });
}

// ---- Rotate QR Every N Seconds ----
function startQRRotation() {
  let countdown = rotationSecs;
  updateCountdown(countdown);
  updateProgress(1);

  qrRotateInterval = setInterval(async () => {
    countdown--;
    updateCountdown(countdown);
    updateProgress(countdown / rotationSecs);

    if (countdown <= 0) {
      countdown = rotationSecs;
      const newToken = generateToken();
      await sessionDocRef.update({
        currentToken: newToken,
        tokenUpdatedAt: firebase.firestore.FieldValue.serverTimestamp()
      });
      renderQR(newToken);
    }
  }, 1000);
}

function updateCountdown(n) {
  const el = document.getElementById('qr-countdown');
  if (!el) return;
  el.textContent = n;
  el.className = 'count' + (n <= 3 ? ' red' : '');
}

function updateProgress(fraction) {
  const bar = document.getElementById('qr-progress');
  if (bar) bar.style.width = (fraction * 100) + '%';
}

// ---- Session Timer ----
function startSessionTimer() {
  sessionTimerInterval = setInterval(() => {
    const remaining = Math.max(0, sessionEndTime - Date.now());
    const mins = Math.floor(remaining / 60000);
    const secs = Math.floor((remaining % 60000) / 1000);
    const str  = `${String(mins).padStart(2,'0')}:${String(secs).padStart(2,'0')}`;
    const el = document.getElementById('fs-session-timer');
    if (el) el.textContent = str;
    if (remaining <= 0) clearInterval(sessionTimerInterval);
  }, 1000);
}

// ---- Listen Attendance (real-time) ----
function listenAttendance() {
  attendanceUnsubscribe = db
    .collection('attendance').doc(currentSession.id)
    .collection('records')
    .orderBy('markedAt', 'asc')
    .onSnapshot((snap) => {
      attendanceData = [];
      snap.forEach(doc => attendanceData.push({ id: doc.id, ...doc.data() }));
      renderAttendanceList();
      updateStats();
    });
}

function renderAttendanceList() {
  const list = document.getElementById('attendance-list');
  if (!attendanceData.length) {
    list.innerHTML = '<div style="text-align:center;padding:2rem;color:var(--text-muted)">Waiting for students to scan...</div>';
    return;
  }
  list.innerHTML = attendanceData.map(r => `
    <div class="attendance-item">
      <div class="att-avatar">${r.name.charAt(0).toUpperCase()}</div>
      <div class="att-info">
        <div class="att-name">${r.name}</div>
        <div class="att-meta">ID: ${r.studentId || '—'} &nbsp;|&nbsp; ${formatTime(r.markedAt)}</div>
      </div>
      <span class="badge badge-success">
        <svg class="icon-svg" viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"/></svg>
        <span>Present</span>
      </span>
    </div>
  `).join('');

  const fsCount = document.getElementById('fs-live-count');
  if (fsCount) fsCount.textContent = `${attendanceData.length} student${attendanceData.length !== 1 ? 's' : ''} marked present`;
}

function updateStats() {
  document.getElementById('stat-present').textContent = attendanceData.length;
  const pct = attendanceData.length > 0 ? attendanceData.length + '%' : '—';
  document.getElementById('stat-pct').textContent = attendanceData.length > 0
    ? Math.min(100, Math.round((attendanceData.length / Math.max(1, attendanceData.length)) * 100)) + '%'
    : '—';
}

// ---- End Session ----
async function endSession() {
  if (!sessionDocRef) return;

  clearInterval(qrRotateInterval);
  clearInterval(sessionTimerInterval);
  clearTimeout(sessionEndTimeout);
  if (attendanceUnsubscribe) attendanceUnsubscribe();

  await sessionDocRef.update({ status: 'ended' });

  hideQRFullscreen();
  document.getElementById('active-session-card').style.display = 'none';
  document.getElementById('start-btn').disabled = false;
  document.getElementById('start-btn').innerHTML = '<svg class="icon-svg fill-current" viewBox="0 0 24 24"><polygon points="5 3 19 12 5 21 5 3"/></svg> <span>Start Session</span>';
  document.getElementById('qr-box').innerHTML = '';
  currentSession = null;
  sessionDocRef  = null;

  showToast('Session ended. Attendance saved.', 'success');
}

// ---- Fullscreen QR ----
function showQRFullscreen() {
  document.getElementById('qr-fullscreen').classList.add('show');
}

function hideQRFullscreen() {
  document.getElementById('qr-fullscreen').classList.remove('show');
}

function updateFullscreenInfo() {
  if (!currentSession) return;
  document.getElementById('fs-class-name').textContent = currentSession.className;
  document.getElementById('fs-subject').textContent    = currentSession.subject;
}

// ---- Export CSV ----
function exportCSV() {
  if (!attendanceData.length) return showToast('No attendance data to export.', 'error');

  const rows = [['Name', 'Student ID', 'Marked At', 'Status']];
  attendanceData.forEach(r => {
    rows.push([r.name, r.studentId || '', formatTime(r.markedAt), 'Present']);
  });

  const csv = rows.map(r => r.join(',')).join('\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `attendance_${currentSession?.className || 'export'}_${new Date().toLocaleDateString()}.csv`;
  a.click();
}

// ---- Logout ----
function logout() {
  auth.signOut().then(() => window.location.href = 'index.html');
}

// ---- Utils ----
function generateToken() {
  return Math.random().toString(36).substring(2, 12) + Date.now().toString(36);
}

function formatDuration(secs) {
  if (secs < 3600) return `${secs / 60} minutes`;
  return `${secs / 3600} hour${secs > 3600 ? 's' : ''}`;
}

function formatTime(ts) {
  if (!ts) return '—';
  const d = ts.toDate ? ts.toDate() : new Date(ts);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function showToast(msg, type = 'info') {
  const container = document.getElementById('toast-container');
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.textContent = msg;
  container.appendChild(toast);
  setTimeout(() => toast.remove(), 3500);
}

// =============================================
// ADMIN JS — Session Management + Master Roster + Absentee Tracking
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

// Master Roster, Review Queue & Absentees State
let masterRoster = [];
let masterIncompleteReviews = [];
let masterConflicts = [];
let masterRegistrationAttempts = [];
let currentRosterTab = 'all'; // 'all' | 'review' | 'conflicts'
let currentAttTab = 'present'; // 'present' | 'absent'
let currentSearchQuery = '';
let dailyHistoryCache = null;
let dailyHistoryPromise = null;

// ---- Auth Guard ----
auth.onAuthStateChanged(async (user) => {
  if (user) {
    let authorized = false;
    let adminName = user.displayName || 'Admin';
    try {
      const doc = await db.collection('users').doc(user.uid).get();
      if (doc.exists) {
        const udata = doc.data() || {};
        if (udata.role === 'admin' || (udata.role === 'trainer' && udata.status === 'approved')) {
          authorized = true;
          currentUser = { uid: user.uid, ...udata };
          adminName = currentUser.name || adminName;
        } else if (udata.role === 'student') {
          window.location.href = 'student.html';
          return;
        }
      }
    } catch (e) {
      console.warn('Firestore authorization check error:', e);
      authorized = false;
    }

    if (!authorized) {
      currentUser = null;
      await auth.signOut();
      window.location.href = 'index.html';
      return;
    }

    const nameEl = document.getElementById('admin-name-display');
    if (nameEl) nameEl.textContent = adminName;
    const badgeEl = document.getElementById('admin-role-badge');
    if (badgeEl && currentUser) {
      badgeEl.textContent = currentUser.role === 'admin' ? 'Overall Admin' : 'Trainer';
      if (currentUser.role === 'trainer') {
        badgeEl.style.background = '#f0fdf4';
        badgeEl.style.color = '#15803d';
        badgeEl.style.border = '1px solid #bbf7d0';
      }
    }

    // Only Overall Admin sees the Trainer Approvals interface
    if (currentUser && currentUser.role === 'admin') {
      initTrainerApprovals();
    }
  } else {
    window.location.href = 'index.html';
  }
});

// =============================================
// TRAINER APPROVALS WORKFLOW (ADMIN ONLY)
// =============================================
async function initTrainerApprovals() {
  const btn = document.getElementById('nav-trainers-btn');
  if (btn) btn.style.display = 'inline-flex';
  loadPendingTrainersCount();
}

async function loadPendingTrainersCount() {
  try {
    const snap = await db.collection('users')
      .where('role', '==', 'trainer')
      .where('status', '==', 'pending')
      .get();
    const countEl = document.getElementById('pending-trainers-badge');
    if (countEl) countEl.textContent = snap.size;
  } catch (e) {
    console.debug('Pending trainer count check:', e);
  }
}

async function openTrainerApprovalsModal() {
  const modal = document.getElementById('trainer-approvals-modal');
  if (modal) modal.classList.add('show');
  renderTrainerApprovalsList();
}

function closeTrainerApprovalsModal() {
  const modal = document.getElementById('trainer-approvals-modal');
  if (modal) modal.classList.remove('show');
}

async function renderTrainerApprovalsList() {
  const container = document.getElementById('trainer-approvals-list');
  if (!container) return;
  container.innerHTML = '<div style="text-align:center;padding:2rem;color:var(--text-muted)"><span class="spinner"></span> Loading pending registrations...</div>';

  try {
    const snap = await db.collection('users')
      .where('role', '==', 'trainer')
      .where('status', '==', 'pending')
      .get();

    if (snap.empty) {
      container.innerHTML = '<div style="text-align:center;padding:2.5rem 1rem;color:var(--text-muted)">✓ No pending trainer registrations at this time. All instructors are up to date.</div>';
      const countEl = document.getElementById('pending-trainers-badge');
      if (countEl) countEl.textContent = '0';
      return;
    }

    const countEl = document.getElementById('pending-trainers-badge');
    if (countEl) countEl.textContent = snap.size;

    container.innerHTML = snap.docs.map(doc => {
      const t = doc.data();
      return `
        <div class="card-sm" style="display:flex;align-items:center;justify-content:space-between;padding:1rem;margin-bottom:0.75rem;border:1px solid var(--border);border-radius:12px;background:#ffffff">
          <div>
            <div style="font-weight:700;font-size:0.95rem;color:var(--text)">${escapeHtml(t.name || 'Trainer')}</div>
            <div style="color:var(--text-muted);font-size:0.85rem">${escapeHtml(t.email || '')}</div>
            <div style="font-size:0.78rem;color:#2563eb;margin-top:0.25rem;font-weight:600">${escapeHtml(t.department || 'General')}</div>
          </div>
          <div style="display:flex;gap:0.5rem">
            <button class="btn btn-outline" style="padding:0.4rem 0.75rem;font-size:0.82rem;color:#dc2626;border-color:#fecaca" onclick="rejectTrainer('${doc.id}')">Reject</button>
            <button class="btn btn-primary" style="padding:0.4rem 0.85rem;font-size:0.82rem" onclick="approveTrainer('${doc.id}')">Approve</button>
          </div>
        </div>
      `;
    }).join('');
  } catch (err) {
    console.error('Failed to load pending trainers:', err);
    container.innerHTML = '<div style="color:#dc2626;text-align:center;padding:1.5rem">Failed to load pending trainers. Please ensure you are logged in as admin.</div>';
  }
}

async function approveTrainer(uid) {
  try {
    await db.collection('users').doc(uid).update({
      status: 'approved',
      approvedAt: firebase.firestore.FieldValue.serverTimestamp(),
      approvedBy: currentUser?.email || 'admin'
    });
    showToast('Trainer account approved successfully!', 'success');
    renderTrainerApprovalsList();
    loadPendingTrainersCount();
  } catch (err) {
    console.error('Approval error:', err);
    showToast('Failed to approve trainer.', 'error');
  }
}

async function rejectTrainer(uid) {
  if (!confirm('Are you sure you want to reject this trainer registration?')) return;
  try {
    await db.collection('users').doc(uid).update({
      status: 'rejected',
      rejectedAt: firebase.firestore.FieldValue.serverTimestamp(),
      rejectedBy: currentUser?.email || 'admin'
    });
    showToast('Trainer registration rejected.', 'info');
    renderTrainerApprovalsList();
    loadPendingTrainersCount();
  } catch (err) {
    console.error('Rejection error:', err);
    showToast('Failed to reject trainer.', 'error');
  }
}

// Initialize Master Roster on Page Load
document.addEventListener('DOMContentLoaded', () => {
  const dateInput = document.getElementById('sheet-date');
  if (dateInput) dateInput.value = new Date().toISOString().slice(0, 10);
  loadMasterRoster();
  loadDailySheet();
});

function dailySheetSessionId(date, batch, branch, section) {
  const safe = value => String(value || 'ALL').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-');
  return `manual_${date}_${safe(batch)}_${safe(branch)}_${safe(section)}`;
}

function dailyStudentKey(student) {
  return String(student.rollNumber || student.studentId || student.email || student.name || '').trim().toUpperCase();
}

async function getAttendanceSessionHistory() {
  if (dailyHistoryCache) return dailyHistoryCache;
  if (dailyHistoryPromise) return dailyHistoryPromise;
  dailyHistoryPromise = db.collection('sessions').get().then(async snapshot => {
    dailyHistoryCache = await Promise.all(snapshot.docs.map(async doc => {
      const data = { id: doc.id, ...(doc.data() || {}) };
      if (!data.date && data.startTime?.toDate) data.date = data.startTime.toDate().toISOString().slice(0, 10);
      if (!Array.isArray(data.presentRolls)) {
        const records = await db.collection('attendance').doc(doc.id).collection('records').get();
        data.presentRolls = records.docs.map(record => dailyStudentKey(record.data() || {})).filter(Boolean);
      }
      return data;
    }));
    return dailyHistoryCache;
  }).finally(() => { dailyHistoryPromise = null; });
  return dailyHistoryPromise;
}

async function loadDailySheet() {
  const body = document.getElementById('daily-sheet-body');
  if (!body) return;
  if (!masterRoster.length) {
    body.innerHTML = '<tr><td colspan="4" style="padding:1rem;color:var(--text-muted)">Load the student roster first.</td></tr>';
    return;
  }
  const date = document.getElementById('sheet-date')?.value || new Date().toISOString().slice(0, 10);
  const batch = document.getElementById('session-batch')?.value || 'ALL';
  const branch = document.getElementById('session-branch')?.value || 'ALL';
  const section = document.getElementById('session-section')?.value || 'ALL';
  const students = getFilteredEnrolled(batch, branch, section);
  const sessionId = dailySheetSessionId(date, batch, branch, section);
  body.innerHTML = '<tr><td colspan="4" style="padding:1rem">Loading attendance…</td></tr>';
  try {
    const [sessionDoc, history] = await Promise.all([
      db.collection('sessions').doc(sessionId).get(),
      getAttendanceSessionHistory()
    ]);
    const present = new Set(sessionDoc.exists ? (sessionDoc.data().presentRolls || []) : []);
    history.filter(day => day.date === date).forEach(day => {
      const inSelectedGroup = (!day.batch || day.batch === 'ALL' || batch === 'ALL' || day.batch === batch)
        && (!day.branch || day.branch === 'ALL' || branch === 'ALL' || day.branch === branch)
        && (!day.section || day.section === 'ALL' || section === 'ALL' || day.section === section);
      if (inSelectedGroup) (day.presentRolls || []).forEach(key => present.add(key));
    });
    const counts = new Map();
    students.forEach(student => {
      const key = dailyStudentKey(student);
      const classDays = new Map();
      history.forEach(day => {
        const inGroup = (!day.batch || day.batch === 'ALL' || day.batch === student.batch)
          && (!day.branch || day.branch === 'ALL' || day.branch === student.branch)
          && (!day.section || day.section === 'ALL' || day.section === student.section);
        if (inGroup && day.date) {
          if (!classDays.has(day.date)) classDays.set(day.date, false);
          if ((day.presentRolls || []).includes(key)) classDays.set(day.date, true);
        }
      });
      const total = classDays.size;
      const attended = Array.from(classDays.values()).filter(Boolean).length;
      counts.set(key, `${attended} / ${total}`);
    });
    body.innerHTML = students.map((student, index) => {
      const key = dailyStudentKey(student);
      return `<tr style="border-top:1px solid var(--border)">
        <td style="padding:.5rem">${escapeHtml(student.name || 'Student')} <small style="color:var(--text-muted)">${escapeHtml(student.rollNumber || student.studentId || '')}</small></td>
        <td style="text-align:center">${escapeHtml(student.batch || '—')}</td>
        <td style="text-align:center"><input type="checkbox" aria-label="${escapeHtml(student.name || 'student')} attendance" ${present.has(key) ? 'checked' : ''} disabled></td>
        <td style="text-align:center">${counts.get(key) || '0 / 0'}</td></tr>`;
    }).join('') || '<tr><td colspan="4" style="padding:1rem">No students match these filters.</td></tr>';
    window.dailySheetStudents = students;
    window.dailySheetContext = { date, batch, branch, section, sessionId };
    const summary = document.getElementById('sheet-summary');
    if (summary) summary.textContent = `${present.size} present · ${students.length} students · ${history.length} saved class sessions`;
  } catch (error) {
    console.error('Daily attendance sheet load failed:', error);
    body.innerHTML = '<tr><td colspan="4" style="padding:1rem;color:#b91c1c">Could not load the saved sheet. Check connection and permissions.</td></tr>';
  }
}

// ---- Start Session ----
async function startSession() {
  const className = document.getElementById('class-name').value.trim();
  const subject   = document.getElementById('subject').value.trim();
  const duration  = parseInt(document.getElementById('duration').value);
  rotationSecs    = parseInt(document.getElementById('rotation').value);

  const batch     = document.getElementById('session-batch') ? document.getElementById('session-batch').value : 'ALL';
  const branch    = document.getElementById('session-branch') ? document.getElementById('session-branch').value : 'ALL';
  const section   = document.getElementById('session-section') ? document.getElementById('session-section').value : 'ALL';

  if (!className || !subject) return showToast('Please fill in class name and subject.', 'error');

  const startBtn = document.getElementById('start-btn');
  if (startBtn) {
    startBtn.disabled = true;
    startBtn.innerHTML = '<span class="spinner"></span> Starting...';
  }

  try {
    const token = generateToken();
    const now   = new Date();
    sessionEndTime = new Date(now.getTime() + duration * 1000);

    const targetStudents = getFilteredEnrolled(batch, branch, section);

    sessionDocRef = db.collection('sessions').doc();
    const sessionPayload = {
      id: sessionDocRef.id,
      sessionType: 'qr_attendance',
      date: now.toISOString().slice(0, 10),
      className,
      subject,
      batch,
      branch,
      section,
      expectedCount: targetStudents.length || 0,
      expectedRolls: targetStudents.map(dailyStudentKey),
      adminId: currentUser?.uid || 'admin',
      adminName: currentUser?.name || 'Admin',
      startTime: firebase.firestore.FieldValue.serverTimestamp(),
      duration,
      status: 'active',
      currentToken: token,
      previousToken: '',
      tokenUpdatedAt: firebase.firestore.FieldValue.serverTimestamp(),
      rotationSecs,
      endTime: firebase.firestore.Timestamp.fromDate(sessionEndTime)
    };

    await sessionDocRef.set(sessionPayload);

    currentSession = {
      id: sessionDocRef.id,
      className,
      date: now.toISOString().slice(0, 10),
      subject,
      batch,
      branch,
      section,
      expectedCount: targetStudents.length,
      duration,
      rotationSecs,
      currentToken: token,
      previousToken: ''
    };

    // Show active session card
    document.getElementById('active-session-card').style.display = 'block';
    document.getElementById('active-session-info').innerHTML = `
      <div class="card-sm">
        <div style="font-weight:700;font-size:1rem">${escapeHtml(className)}</div>
        <div style="color:var(--text-muted);font-size:0.85rem;margin-top:0.25rem">${escapeHtml(subject)}</div>
        <div style="display:flex;gap:0.4rem;margin-top:0.5rem;flex-wrap:wrap">
          <span class="badge" style="background:#eff6ff;color:#2563eb;font-size:0.75rem">Batch: ${batch}</span>
          <span class="badge" style="background:#eff6ff;color:#2563eb;font-size:0.75rem">Branch: ${branch}</span>
          <span class="badge" style="background:#eff6ff;color:#2563eb;font-size:0.75rem">Sec: ${section}</span>
        </div>
        <div class="mt-2" style="font-size:0.85rem;color:var(--text-muted)">Duration: ${formatDuration(duration)}</div>
      </div>
    `;

    // Update form button
    if (startBtn) {
      startBtn.innerHTML = '<svg class="icon-svg" viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"/></svg> <span>Session Running</span>';
    }

    // Start QR rotation
    renderQR(token);
    startQRRotation();

    // Auto end session after duration
    sessionEndTimeout = setTimeout(endSession, duration * 1000);

    // Live session timer
    startSessionTimer();

    // Listen for attendance
    attendanceData = [];
    listenAttendance();
    updateStatsAndLists();

    showToast(`Session started for ${className}`, 'success');
    showQRFullscreen();
    updateFullscreenInfo();

  } catch (e) {
    console.error('Session start error:', e);
    showToast('Failed to start session. Try again.', 'error');
    if (startBtn) {
      startBtn.disabled = false;
      startBtn.innerHTML = '<svg class="icon-svg fill-current" viewBox="0 0 24 24"><polygon points="5 3 19 12 5 21 5 3"/></svg> <span>Start Session</span>';
    }
  }
}

// ---- Generate Token ----
function generateToken() {
  return Math.random().toString(36).substring(2, 10) + Date.now().toString(36);
}

// ---- Render QR ----
function renderQR(token) {
  const box = document.getElementById('qr-box');
  if (!box) return;
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

  let lastTick = Date.now();

  qrRotateInterval = setInterval(async () => {
    const now = Date.now();
    const elapsed = Math.max(1, Math.round((now - lastTick) / 1000));
    lastTick = now;

    countdown -= elapsed;

    if (countdown <= 0) {
      countdown = rotationSecs;
      const newToken = generateToken();
      const prevToken = currentSession.currentToken || '';
      currentSession.previousToken = prevToken;
      currentSession.currentToken = newToken;

      // Update screen immediately
      renderQR(newToken);

      if (sessionDocRef) {
        try {
          await sessionDocRef.update({
            currentToken: newToken,
            previousToken: prevToken,
            tokenUpdatedAt: firebase.firestore.FieldValue.serverTimestamp()
          });
        } catch (err) {
          console.warn('Rotation token update warning:', err);
        }
      }
    }

    updateCountdown(Math.max(0, countdown));
    updateProgress(Math.max(0, countdown) / rotationSecs);
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
  if (!currentSession) return;
  try {
    attendanceUnsubscribe = db
      .collection('attendance').doc(currentSession.id)
      .collection('records')
      .orderBy('markedAt', 'asc')
      .onSnapshot((snap) => {
        attendanceData = [];
        snap.forEach(doc => attendanceData.push({ id: doc.id, ...doc.data() }));
        const presentRolls = attendanceData.map(dailyStudentKey);
        sessionDocRef?.update({ presentRolls }).then(() => {
          if (dailyHistoryCache && currentSession) {
            const cached = dailyHistoryCache.find(day => day.id === currentSession.id);
            if (cached) cached.presentRolls = presentRolls;
            else dailyHistoryCache.push({ ...currentSession, presentRolls });
          }
          loadDailySheet();
        }).catch(() => {});
        updateStatsAndLists();
      }, (err) => {
        console.warn('Attendance snapshot note:', err);
      });
  } catch (e) {
    console.warn('Attendance listener notice:', e);
  }
}

// =============================================
// MASTER ROSTER & ABSENTEE LOGIC
// =============================================

// ---- Branch Normalization & Canonicalization ----
function normalizeBranch(raw) {
  if (!raw) return '';
  let b = String(raw).trim().toUpperCase();
  b = b.replace(/^["'“”()]+|["'“”()]+$/g, '').trim();

  // If it contains instructional text or header noise, reject it
  if (
    b.includes('SELECT') ||
    b.includes('SECTION') ||
    b.includes('MOBILE') ||
    b.includes('EMAIL') ||
    b.includes('NUMBER') ||
    b.includes('MAI.ID') ||
    b.length > 25
  ) {
    return '';
  }

  // Canonical branch mappings (e.g. CYBER, DS, AIDS, AIML, ECE, CSE)
  if (/CYBER|CSE\s*[-_]?\s*CYBER|CSE\s*\(\s*CYBER|CS\s*[-_]?\s*CYBER/i.test(b)) return 'CYBER';
  if (/DATA\s*SCIENCE|CSE\s*[-_]?\s*DS|CSE\s*\(\s*DS\s*\)|\bDS\b/i.test(b)) return 'DS';
  if (/AI\s*&?\s*DS|AI\s*AND\s*DS|CSE\s*\(\s*AI\s*&?\s*DS\s*\)|\bAIDS\b/i.test(b)) return 'AIDS';
  if (/AI\s*&?\s*ML|AI\s*AND\s*ML|CSE\s*\(\s*AI\s*&?\s*ML\s*\)|\bAIML\b/i.test(b)) return 'AIML';
  if (/\bECE\b|ELECTRONICS/i.test(b)) return 'ECE';
  if (/\bCSE\b|COMPUTER\s*SCIENCE/i.test(b)) return 'CSE';
  if (/\bEEE\b|ELECTRICAL/i.test(b)) return 'EEE';
  if (/\bIT\b|INFORMATION\s*TECH/i.test(b)) return 'IT';
  if (/\bMECH\b|MECHANICAL/i.test(b)) return 'MECH';
  if (/\bCIVIL\b/i.test(b)) return 'CIVIL';

  return b;
}

function normalizeEmail(raw) {
  if (!raw) return '';
  let email = String(raw).trim().toLowerCase().replace(/\s+/g, '');
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

// Check if a row parsed from CSV is an actual student record
function isStudentRowValid(s) {
  if (!s) return false;
  const roll = String(s.rollNumber || '').trim().toUpperCase();
  const name = String(s.name || '').trim();
  const branch = String(s.branch || '').trim().toUpperCase();

  // Must have a name with at least 2 characters
  if (!name || name.length < 2) return false;

  // Header and note phrases to reject
  const headerPhrases = [
    'ROLL NO', 'ROLL NUMBER', 'STUDENT NAME', 'FULL NAME', 'NAME OF THE STUDENT',
    'HALL TICKET', 'HT NO', 'REG NO', 'S.NO', 'SL.NO', 'SERIAL NO',
    'PLEASE SELECT', 'NO SECTION', 'MOBILE NUMBER', 'PHONE NUMBER', 'MAIL ID', 'EMAIL ID'
  ];

  for (const phrase of headerPhrases) {
    if ((roll && roll === phrase) || name.toUpperCase() === phrase) return false;
  }

  // Reject instructional/prompt rows
  if (
    name.toUpperCase().includes('PLEASE SELECT') ||
    (roll && roll.includes('PLEASE SELECT')) ||
    branch.includes('PLEASE SELECT') ||
    branch.includes('NO SECTION')
  ) {
    return false;
  }

  return true;
}

// Clean and deduplicate any student array
function sanitizeRoster(roster) {
  if (!Array.isArray(roster)) return [];
  const map = new Map();
  for (let idx = 0; idx < roster.length; idx++) {
    const s = roster[idx];
    if (!isStudentRowValid(s)) continue;

    let cleanRoll = String(s.rollNumber || s.studentId || '').trim().toUpperCase();
    // Do not invent fake roll numbers or treat 10-digit mobile numbers as roll numbers
    if (/^\d{10}$/.test(cleanRoll) || /^STU-\d+$/i.test(cleanRoll)) {
      cleanRoll = '';
    }

    const normBranch = normalizeBranch(s.branch) || 'GENERAL';
    const normEmail = normalizeEmail(s.email);
    const cleanStudent = {
      ...s,
      rollNumber: cleanRoll,
      studentId: cleanRoll,
      name: String(s.name || '').trim(),
      branch: normBranch,
      section: cleanSection(s.section),
      batch: String(s.batch || '').trim(),
      mobile: String(s.mobile || '').replace(/[^0-9+]/g, '').trim(),
      email: normEmail,
      college: String(s.college || 'HITAM').trim()
    };

    // Deduplicate prioritizing normalized email, then genuine roll number, then unique index
    const dedupKey = normEmail ? 'EMAIL:' + normEmail : (cleanRoll ? 'ROLL:' + cleanRoll : 'IDX:' + idx);
    map.set(dedupKey, cleanStudent);
  }
  return Array.from(map.values());
}

function loadMasterRoster() {
  const saved = localStorage.getItem('attendx_master_roster');
  if (saved) {
    try {
      const raw = JSON.parse(saved);
      // Immediately sanitize and strip out any corrupted/note entries
      masterRoster = sanitizeRoster(raw);
      if (masterRoster.length !== raw.length) {
        localStorage.setItem('attendx_master_roster', JSON.stringify(masterRoster));
      }
    } catch (e) {
      masterRoster = [];
    }
  }

  // Fallback to pre-compiled JSON roster if local storage is empty
  if (!masterRoster.length && typeof window !== 'undefined' && window.ATTENDX_ROSTER && Array.isArray(window.ATTENDX_ROSTER.students)) {
    masterRoster = sanitizeRoster(window.ATTENDX_ROSTER.students);
    masterIncompleteReviews = Array.isArray(window.ATTENDX_ROSTER.incompleteRecordsReview) ? window.ATTENDX_ROSTER.incompleteRecordsReview : [];
    masterConflicts = Array.isArray(window.ATTENDX_ROSTER.alternateEmailConflicts) ? window.ATTENDX_ROSTER.alternateEmailConflicts : [];
  }

  // Also check Firestore if available
  try {
    db.collection('settings').doc('student_roster').get().then(doc => {
      if (doc.exists && doc.data()) {
        const d = doc.data();
        if (Array.isArray(d.students) && d.students.length > 0) {
          masterRoster = sanitizeRoster(d.students);
          masterIncompleteReviews = Array.isArray(d.incompleteRecordsReview) ? d.incompleteRecordsReview : [];
          masterConflicts = Array.isArray(d.alternateEmailConflicts) ? d.alternateEmailConflicts : [];
          masterRegistrationAttempts = Array.isArray(d.registrationReviewAttempts) ? d.registrationReviewAttempts : [];
          localStorage.setItem('attendx_master_roster', JSON.stringify(masterRoster));
          populateRosterFilters();
          updateRosterUI();
          loadDailySheet();
        }
      }
    }).catch(() => {});
  } catch (_) {}

  populateRosterFilters();
  updateRosterUI();
}

function saveMasterRoster(students, mode = null) {
  if (!Array.isArray(students)) return;

  // Determine mode: merge (default) or replace
  if (!mode) {
    const radio = document.querySelector('input[name="roster-upload-mode"]:checked');
    mode = radio ? radio.value : 'merge';
  }

  const sanitizedNew = sanitizeRoster(students);
  if (!sanitizedNew.length && !masterRoster.length) return;

  if (mode === 'replace') {
    masterRoster = sanitizedNew;
  } else {
    // Merge mode: Add new students or update existing, deduplicating by normalized email or genuine roll number
    const studentMap = new Map();
    sanitizeRoster(masterRoster).forEach((s, i) => {
      const key = s.email ? 'EMAIL:' + s.email : (s.rollNumber ? 'ROLL:' + s.rollNumber : 'IDX:' + i);
      studentMap.set(key, s);
    });
    sanitizedNew.forEach((s, i) => {
      const key = s.email ? 'EMAIL:' + s.email : (s.rollNumber ? 'ROLL:' + s.rollNumber : 'IDX:' + i);
      studentMap.set(key, s);
    });
    masterRoster = Array.from(studentMap.values());
  }

  localStorage.setItem('attendx_master_roster', JSON.stringify(masterRoster));

  try {
    db.collection('settings').doc('student_roster').set({
      students: masterRoster,
      updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
      count: masterRoster.length
    }).catch(e => console.warn('Firestore roster sync warning:', e));
  } catch (_) {}

  populateRosterFilters();
  updateRosterUI();
  loadDailySheet();
  updateStatsAndLists();
}

function clearMasterRoster() {
  if (!confirm('Are you sure you want to clear the entire student master roster?')) return;
  masterRoster = [];
  localStorage.removeItem('attendx_master_roster');
  try {
    db.collection('settings').doc('student_roster').delete().catch(() => {});
  } catch (_) {}

  populateRosterFilters();
  updateRosterUI();
  updateStatsAndLists();
  showToast('Student roster has been cleared.', 'info');
}

function populateRosterFilters() {
  const batchSelect = document.getElementById('session-batch');
  const branchSelect = document.getElementById('session-branch');
  const sectionSelect = document.getElementById('session-section');

  if (!batchSelect || !branchSelect || !sectionSelect) return;

  const batches  = Array.from(new Set(masterRoster.map(s => s.batch).filter(Boolean))).sort();
  const branches = Array.from(new Set(masterRoster.map(s => s.branch).filter(Boolean))).sort();
  const sections = Array.from(new Set(masterRoster.map(s => s.section).filter(Boolean))).sort();

  batchSelect.innerHTML  = '<option value="ALL">All Batches</option>' + batches.map(b => `<option value="${escapeHtml(b)}">${escapeHtml(b)}</option>`).join('');
  branchSelect.innerHTML = '<option value="ALL">All Branches</option>' + branches.map(b => `<option value="${escapeHtml(b)}">${escapeHtml(b)}</option>`).join('');
  sectionSelect.innerHTML= '<option value="ALL">All Sections</option>' + sections.map(s => `<option value="${escapeHtml(s)}">${escapeHtml(s)}</option>`).join('');

  updateExpectedCount();
}

function updateExpectedCount() {
  const batch   = document.getElementById('session-batch')?.value || 'ALL';
  const branch  = document.getElementById('session-branch')?.value || 'ALL';
  const section = document.getElementById('session-section')?.value || 'ALL';

  const enrolled = getFilteredEnrolled(batch, branch, section);
  const hintEl   = document.getElementById('session-expected-text');

  if (masterRoster.length === 0) {
    if (hintEl) hintEl.textContent = 'Upload student roster (Google Sheet / CSV) to track absentees';
    return;
  }

  const parts = [];
  if (batch !== 'ALL') parts.push(`Batch ${batch}`);
  if (branch !== 'ALL') parts.push(`Branch ${branch}`);
  if (section !== 'ALL') parts.push(`Section ${section}`);
  const criteriaStr = parts.length ? parts.join(', ') : 'All Batches/Branches/Sections';

  if (hintEl) {
    hintEl.textContent = `Target: ${enrolled.length} enrolled student${enrolled.length !== 1 ? 's' : ''} in ${criteriaStr}`;
  }

  const expectedStat = document.getElementById('stat-expected');
  if (expectedStat && !currentSession) {
    expectedStat.textContent = enrolled.length || '—';
  }
}

function getFilteredEnrolled(batch, branch, section) {
  let list = masterRoster;
  if (batch && batch !== 'ALL') {
    list = list.filter(s => (s.batch || '').toLowerCase() === batch.toLowerCase());
  }
  if (branch && branch !== 'ALL') {
    list = list.filter(s => (s.branch || '').toLowerCase() === branch.toLowerCase());
  }
  if (section && section !== 'ALL') {
    list = list.filter(s => (s.section || '').toLowerCase() === section.toLowerCase());
  }
  return list;
}

function getReviewList() {
  if (Array.isArray(masterIncompleteReviews) && masterIncompleteReviews.length > 0) {
    return masterIncompleteReviews;
  }
  return masterRoster.filter(s => s.status !== 'verified' || !s.batch || !s.email);
}

function updateRosterUI() {
  const count = masterRoster.length;
  const navCount = document.getElementById('nav-roster-count');
  if (navCount) navCount.textContent = count;

  const needsReviewList = getReviewList();
  const totalReviewCount = needsReviewList.length + masterConflicts.length + (masterRegistrationAttempts ? masterRegistrationAttempts.length : 0);
  const navReviewCount = document.getElementById('nav-review-count');
  if (navReviewCount) navReviewCount.textContent = totalReviewCount;

  const tabAllCount = document.getElementById('tab-all-count');
  if (tabAllCount) tabAllCount.textContent = count;

  const tabReviewCount = document.getElementById('tab-review-count');
  if (tabReviewCount) tabReviewCount.textContent = needsReviewList.length;

  const tabConflictsCount = document.getElementById('tab-conflicts-count');
  if (tabConflictsCount) tabConflictsCount.textContent = masterConflicts.length;

  const bannerTitle = document.getElementById('roster-banner-title');
  const bannerDesc  = document.getElementById('roster-banner-desc');
  const viewBtn     = document.getElementById('roster-view-btn');
  const uploadBtnTxt= document.getElementById('roster-upload-btn-text');

  const branches = Array.from(new Set(masterRoster.map(s => s.branch).filter(Boolean)));
  const sections = Array.from(new Set(masterRoster.map(s => s.section).filter(Boolean)));
  const batches  = Array.from(new Set(masterRoster.map(s => s.batch).filter(Boolean)));

  if (count > 0) {
    if (bannerTitle) bannerTitle.textContent = `Master Roster Active (${count} Students)`;
    if (bannerDesc) bannerDesc.textContent = `Loaded ${count} students across ${batches.length} batch(es), ${branches.length} branch(es) [${branches.join(', ')}], and ${sections.length} section(s).`;
    if (viewBtn) viewBtn.style.display = 'inline-flex';
    if (uploadBtnTxt) uploadBtnTxt.textContent = 'Update Roster (CSV)';
  } else {
    if (bannerTitle) bannerTitle.textContent = 'Student Master Roster';
    if (bannerDesc) bannerDesc.textContent = 'Upload your student Google Sheet / CSV to auto-calculate absentees by batch, branch & section.';
    if (viewBtn) viewBtn.style.display = 'none';
    if (uploadBtnTxt) uploadBtnTxt.textContent = 'Upload Roster (CSV)';
  }

  // Update modal stats
  const modalTotal = document.getElementById('modal-roster-total');
  const modalBranches = document.getElementById('modal-roster-branches');
  const modalSections = document.getElementById('modal-roster-sections');
  const modalBatches = document.getElementById('modal-roster-batches');

  if (modalTotal) modalTotal.textContent = count;
  if (modalBranches) modalBranches.textContent = branches.length;
  if (modalSections) modalSections.textContent = sections.length;
  if (modalBatches) modalBatches.textContent = batches.length;

  switchRosterTab(currentRosterTab);
}

// ---- Attendance & Absentees Calculation ----
function updateStatsAndLists() {
  let enrolled = [];
  if (currentSession) {
    enrolled = getFilteredEnrolled(currentSession.batch, currentSession.branch, currentSession.section);
  } else {
    enrolled = masterRoster;
  }

  const expectedCount = enrolled.length || (attendanceData.length ? Math.max(60, attendanceData.length) : 0);

  // Set of uppercase roll numbers who scanned
  const presentRolls = new Set(
    attendanceData.map(r => (r.rollNumber || r.studentId || '').trim().toUpperCase()).filter(Boolean)
  );

  // Absentees = Enrolled students whose rollNumber is not in presentRolls
  const absentees = enrolled.filter(s => {
    const roll = (s.rollNumber || s.studentId || '').trim().toUpperCase();
    return roll && !presentRolls.has(roll);
  });

  // Update stat numbers
  const presentEl = document.getElementById('stat-present');
  const expectedEl = document.getElementById('stat-expected');
  const absentEl = document.getElementById('stat-absent');
  const pctEl = document.getElementById('stat-pct');

  if (presentEl) presentEl.textContent = attendanceData.length;
  if (expectedEl) expectedEl.textContent = expectedCount || '—';
  if (absentEl) absentEl.textContent = currentSession ? absentees.length : (masterRoster.length ? masterRoster.length : '—');

  if (pctEl) {
    if (expectedCount > 0) {
      const pct = Math.min(100, Math.round((attendanceData.length / expectedCount) * 100));
      pctEl.textContent = `${pct}%`;
    } else {
      pctEl.textContent = attendanceData.length > 0 ? '100%' : '—';
    }
  }

  // Update tab counts
  const tabPresentCount = document.getElementById('tab-present-count');
  const tabAbsentCount  = document.getElementById('tab-absent-count');
  if (tabPresentCount) tabPresentCount.textContent = attendanceData.length;
  if (tabAbsentCount)  tabAbsentCount.textContent  = absentees.length;

  const fsCount = document.getElementById('fs-live-count');
  if (fsCount) {
    fsCount.textContent = `${attendanceData.length} present / ${absentees.length} absent`;
  }

  // Render active tab view
  renderAttendanceView(absentees);
}

function switchAttTab(tab) {
  currentAttTab = tab;
  const pBtn = document.getElementById('tab-btn-present');
  const aBtn = document.getElementById('tab-btn-absent');

  if (pBtn) pBtn.classList.toggle('active', tab === 'present');
  if (aBtn) aBtn.classList.toggle('active', tab === 'absent');

  updateStatsAndLists();
}

function handleAttSearch(val) {
  currentSearchQuery = (val || '').trim().toLowerCase();
  updateStatsAndLists();
}

function renderAttendanceView(absentees) {
  const container = document.getElementById('attendance-list');
  if (!container) return;

  if (!currentSession && !attendanceData.length) {
    container.innerHTML = `
      <div class="no-session-msg">
        <div class="icon" style="color:var(--text-muted);display:flex;justify-content:center;margin-bottom:0.75rem">
          <svg class="icon-lg" viewBox="0 0 24 24"><line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/></svg>
        </div>
        <p>Start a session to track attendance & absentees live</p>
      </div>`;
    return;
  }

  if (currentAttTab === 'present') {
    let list = attendanceData;
    if (currentSearchQuery) {
      list = list.filter(r => {
        const name = (r.name || '').toLowerCase();
        const roll = (r.rollNumber || r.studentId || '').toLowerCase();
        const branch = (r.branch || '').toLowerCase();
        return name.includes(currentSearchQuery) || roll.includes(currentSearchQuery) || branch.includes(currentSearchQuery);
      });
    }

    if (!list.length) {
      container.innerHTML = `<div style="text-align:center;padding:2.5rem 1rem;color:var(--text-muted)">
        ${currentSearchQuery ? 'No matching present students found.' : 'Waiting for students to scan QR code...'}
      </div>`;
      return;
    }

    container.innerHTML = list.map(r => `
      <div class="attendance-item">
        <div class="att-avatar">${(r.name || '?').charAt(0).toUpperCase()}</div>
        <div class="att-info">
          <div class="att-name">${escapeHtml(r.name || 'Student')}</div>
          <div class="att-meta">
            <span>Roll No: <strong>${escapeHtml(r.rollNumber || r.studentId || '—')}</strong></span>
            ${r.branch ? `<span class="badge" style="background:#eff6ff;color:#2563eb;font-size:0.75rem;padding:0.15rem 0.5rem">${escapeHtml(r.branch)}</span>` : ''}
            <span>&nbsp;|&nbsp; ${r.timeStr || formatTime(r.markedAt)}</span>
          </div>
        </div>
        <span class="badge badge-success">
          <svg class="icon-svg" viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"/></svg>
          <span>Present</span>
        </span>
      </div>
    `).join('');

  } else {
    // Absentees Tab
    let list = absentees;
    if (currentSearchQuery) {
      list = list.filter(s => {
        const name = (s.name || '').toLowerCase();
        const roll = (s.rollNumber || s.studentId || '').toLowerCase();
        const mobile = (s.mobile || '').toLowerCase();
        const branch = (s.branch || '').toLowerCase();
        return name.includes(currentSearchQuery) || roll.includes(currentSearchQuery) || mobile.includes(currentSearchQuery) || branch.includes(currentSearchQuery);
      });
    }

    if (!list.length) {
      if (!masterRoster.length) {
        container.innerHTML = `
          <div style="text-align:center;padding:2.5rem 1rem;color:var(--text-muted)">
            <p style="font-weight:600;margin-bottom:0.4rem">No Student Master Roster Uploaded</p>
            <p style="font-size:0.85rem">Please upload your Google Sheet or CSV to track absent students.</p>
            <button class="btn btn-primary mt-2" style="font-size:0.82rem;padding:0.45rem 1rem" onclick="openRosterModal()">Upload Roster</button>
          </div>`;
      } else {
        container.innerHTML = `
          <div style="text-align:center;padding:2.5rem 1rem;color:var(--success)">
            <svg class="icon-lg" style="color:var(--success);margin-bottom:0.5rem" viewBox="0 0 24 24"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>
            <p style="font-weight:700">100% Attendance!</p>
            <p style="font-size:0.85rem;color:var(--text-muted)">All expected students have checked in.</p>
          </div>`;
      }
      return;
    }

    const subjectName = currentSession?.subject || 'Class';
    const dateStr = new Date().toLocaleDateString();

    container.innerHTML = list.map(s => {
      const cleanPhone = (s.mobile || '').replace(/[^0-9]/g, '');
      const waMessage = encodeURIComponent(`Dear ${s.name || 'Student'} (${s.rollNumber || ''}), you were marked absent for ${subjectName} on ${dateStr}. Please contact the department.`);
      const waLink = cleanPhone ? `https://wa.me/91${cleanPhone}?text=${waMessage}` : '#';
      const telLink = cleanPhone ? `tel:${cleanPhone}` : '#';
      const mailLink = s.email ? `mailto:${s.email}?subject=${encodeURIComponent('Attendance Absence Notice - ' + subjectName)}&body=${waMessage}` : '#';

      return `
        <div class="absentee-item">
          <div style="display:flex;align-items:center;min-width:0;flex:1">
            <div class="absent-avatar">${(s.name || '?').charAt(0).toUpperCase()}</div>
            <div class="att-info" style="min-width:0">
              <div class="att-name" style="color:#b91c1c">${escapeHtml(s.name || 'Unknown Student')}</div>
              <div class="att-meta">
                <span>Roll: <strong>${escapeHtml(s.rollNumber || '—')}</strong></span>
                ${s.branch ? `<span class="badge" style="background:#fee2e2;color:#b91c1c;font-size:0.75rem;padding:0.15rem 0.5rem">${escapeHtml(s.branch)}-${escapeHtml(s.section || 'A')}</span>` : ''}
                ${s.mobile ? `<span style="color:var(--text-secondary);font-size:0.8rem">&nbsp;•&nbsp; 📞 ${escapeHtml(s.mobile)}</span>` : ''}
              </div>
            </div>
          </div>

          <div class="absent-contact-actions">
            ${cleanPhone ? `
              <a href="${waLink}" target="_blank" rel="noopener noreferrer" class="contact-pill contact-pill-wa" title="Send WhatsApp alert">
                <span>WhatsApp</span>
              </a>
              <a href="${telLink}" class="contact-pill contact-pill-tel" title="Call student/parent">
                <span>Call</span>
              </a>
            ` : ''}
            ${s.email ? `
              <a href="${mailLink}" class="contact-pill contact-pill-mail" title="Send email notice">
                <span>Email</span>
              </a>
            ` : ''}
            <span class="badge" style="background:#fef2f2;color:#dc2626;border:1px solid #fecaca;font-weight:700">Absent</span>
          </div>
        </div>
      `;
    }).join('');
  }
}

// ---- Robust Table Parser (Handles CSV, TSV from Google Sheets, Quoted cells, Multiline) ----
function parseTableData(text) {
  if (!text || !text.trim()) return [];

  // Auto-detect delimiter: tab (\t) for Google Sheets copy-paste, or comma (,) for CSV
  const firstLine = text.trim().split(/\r?\n/)[0] || '';
  const tabCount = (firstLine.match(/\t/g) || []).length;
  const commaCount = (firstLine.match(/,/g) || []).length;
  const delimiter = tabCount > commaCount ? '\t' : ',';

  const rows = [];
  let currentRow = [];
  let currentCell = '';
  let inQuotes = false;
  let i = 0;
  const len = text.length;

  while (i < len) {
    const char = text[i];
    const nextChar = text[i + 1];

    if (char === '"' || char === '“' || char === '”') {
      if (inQuotes && nextChar === '"') {
        currentCell += '"';
        i += 2;
        continue;
      } else {
        inQuotes = !inQuotes;
        i++;
        continue;
      }
    }

    if (!inQuotes && char === delimiter) {
      currentRow.push(currentCell.trim());
      currentCell = '';
      i++;
      continue;
    }

    if (!inQuotes && (char === '\r' || char === '\n')) {
      if (char === '\r' && nextChar === '\n') {
        i++;
      }
      currentRow.push(currentCell.trim());
      currentCell = '';
      if (currentRow.some(c => c.length > 0)) {
        rows.push(currentRow);
      }
      currentRow = [];
      i++;
      continue;
    }

    currentCell += char;
    i++;
  }

  currentRow.push(currentCell.trim());
  if (currentRow.some(c => c.length > 0)) {
    rows.push(currentRow);
  }

  return rows;
}

// Find the header row among the first 15 rows (handles title banners & metadata rows)
function detectHeaderRow(rows) {
  const maxScan = Math.min(rows.length, 15);
  let bestIdx = 0;
  let bestScore = -1;

  const keywords = [
    'roll', 'ht no', 'hall ticket', 'reg no', 'id',
    'name', 'candidate',
    'branch', 'dept', 'department', 'stream', 'course',
    'section', 'sec',
    'batch', 'year',
    'mobile', 'phone', 'contact', 'cell', 'whatsapp',
    'email', 'mail', 'timestamp', 's.no', 'sl.no'
  ];

  for (let r = 0; r < maxScan; r++) {
    const row = rows[r];
    if (!Array.isArray(row)) continue;
    let score = 0;
    const lowerCells = row.map(c => String(c || '').trim().toLowerCase());

    for (const cell of lowerCells) {
      if (!cell) continue;
      if (keywords.some(k => cell === k || cell.includes(k))) {
        score++;
      }
    }

    if (score > bestScore) {
      bestScore = score;
      bestIdx = r;
    }
  }

  return bestScore >= 2 ? bestIdx : 0;
}

// Extract students directly from a 2D array of rows
function extractStudentsFromRows(rawRows, tabName = '') {
  if (!Array.isArray(rawRows)) return [];
  const rows = rawRows.filter(r => Array.isArray(r) && r.some(c => String(c || '').trim().length > 0));
  if (rows.length < 2) return [];

  const headerIdx = detectHeaderRow(rows);
  const rawHeaders = rows[headerIdx].map(h => String(h || '').trim().toLowerCase().replace(/[\r\n]+/g, ' '));
  const alphaHeaders = rawHeaders.map(h => h.replace(/[^a-z0-9]/g, ''));

  console.log(`[Tab: "${tabName}"] detected header at row ${headerIdx}:`, rawHeaders);

  const mapKey = (candidates) => {
    // 1. Exact or substring match in rawHeaders
    for (const c of candidates) {
      const idx = rawHeaders.findIndex(h => h === c || h.includes(c));
      if (idx !== -1) return idx;
    }
    // 2. Alphanumeric match (handles punctuation variations like 'mai.id' or 'mail.id')
    for (const c of candidates) {
      const clean = c.replace(/[^a-z0-9]/g, '');
      if (clean.length < 3) continue;
      const idx = alphaHeaders.findIndex(h => h === clean || h.includes(clean));
      if (idx !== -1) return idx;
    }
    return -1;
  };

  const nameIdx    = mapKey(['full name', 'student name', 'candidate name', 'student', 'name']);
  const branchIdx  = mapKey(['branch', 'department', 'dept', 'stream', 'course']);
  const secIdx     = mapKey(['section', 'sec', 'class section']);
  const batchIdx   = mapKey(['batch', 'academic year', 'year']);
  const mobileIdx  = mapKey(['mobile number', 'phone number', 'contact number', 'mobile no', 'phone no', 'mobile', 'phone', 'contact', 'cell', 'whatsapp']);
  const emailIdx   = mapKey(['mail.id', 'mai.id', 'mail id', 'mai id', 'mailid', 'maiid', 'email id', 'email address', 'student email', 'email', 'mail']);
  const rollIdx    = mapKey(['roll number', 'roll no', 'roll_no', 'rollno', 'student id', 'ht no', 'htno', 'hall ticket', 'hallticket', 'reg no', 'reg_no', 'regno', 'registration no']);

  const students = [];

  for (let i = headerIdx + 1; i < rows.length; i++) {
    const row = rows[i];
    if (!Array.isArray(row) || row.length === 0) continue;

    let name = nameIdx !== -1 ? String(row[nameIdx] || '').trim() : '';
    const rawBranch = branchIdx !== -1 ? String(row[branchIdx] || '').trim() : '';
    let rawSec = secIdx !== -1 ? String(row[secIdx] || '').trim().toUpperCase() : 'No Section';
    let rawBatch = batchIdx !== -1 ? String(row[batchIdx] || '').trim() : '';
    const rawMobile = mobileIdx !== -1 ? String(row[mobileIdx] || '').trim() : '';
    const rawEmail = emailIdx !== -1 ? String(row[emailIdx] || '').trim() : '';
    const rawCollege = 'HITAM';

    // If no name found at nameIdx, look for first sensible string cell
    if (!name) {
      for (let c = 0; c < row.length; c++) {
        const val = String(row[c] || '').trim();
        if (val && c !== rollIdx && c !== mobileIdx && c !== emailIdx && isNaN(val) && val.length > 2) {
          name = val;
          break;
        }
      }
    }

    if (!name || name.length < 2) continue;

    // Check if name is header text
    const upperName = name.toUpperCase();
    if (upperName === 'FULL NAME' || upperName === 'STUDENT NAME' || upperName === 'NAME' || upperName.includes('PLEASE SELECT')) continue;

    // Genuine roll number only: do not invent roll numbers or store mobile/email as roll numbers
    let roll = '';
    if (rollIdx !== -1 && row[rollIdx]) {
      const cand = String(row[rollIdx] || '').trim().toUpperCase();
      if (cand && !/^\d{10}$/.test(cand) && !cand.includes('SELECT') && !cand.includes('NAME')) {
        roll = cand;
      }
    }

    // Branch normalization with fallback to tab name
    let cleanBranch = normalizeBranch(rawBranch);
    if (!cleanBranch) {
      cleanBranch = normalizeBranch(tabName) || 'GENERAL';
    }

    // Clean section
    const sec = cleanSection(rawSec);

    // Clean batch
    if (!rawBatch) {
      rawBatch = tabName ? tabName : '2029';
    }

    const normEmail = normalizeEmail(rawEmail);
    const cleanMobile = rawMobile.replace(/[^0-9+]/g, '');

    const studentObj = {
      rollNumber: roll,
      studentId: roll,
      name: name,
      branch: cleanBranch,
      section: sec,
      batch: rawBatch,
      mobile: cleanMobile,
      email: normEmail,
      rawEmail: rawEmail,
      college: rawCollege,
      tab: tabName,
      sourceRow: i + 1
    };

    if (isStudentRowValid(studentObj)) {
      students.push(studentObj);
    }
  }

  return students;
}

// Parse text into student objects (CSV, TSV, or Google Sheet copy-paste)
function parseCSV(text) {
  let rows = [];
  if (typeof XLSX !== 'undefined') {
    try {
      const wb = XLSX.read(text, { type: 'string' });
      const ws = wb.Sheets[wb.SheetNames[0]];
      rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
    } catch (_) {
      rows = parseTableData(text);
    }
  } else {
    rows = parseTableData(text);
  }
  return extractStudentsFromRows(rows);
}

// Multi-file & Excel (.xlsx) upload handler with Dry-Run support
async function handleRosterFileUpload(event) {
  const files = Array.from(event.target.files || []);
  if (!files.length) return;

  let allParsed = [];
  const batchCounts = {};
  const missingOrInvalidEmails = [];
  const duplicateMap = new Map();

  for (const file of files) {
    try {
      const fileName = file.name.toLowerCase();

      // If Excel workbook (.xlsx, .xls)
      if (fileName.endsWith('.xlsx') || fileName.endsWith('.xls')) {
        if (typeof XLSX !== 'undefined') {
          const buffer = await file.arrayBuffer();
          const workbook = XLSX.read(buffer, { type: 'array' });
          console.log('Opened workbook with sheets:', workbook.SheetNames);
          
          // Read all batch tabs (e.g. BATCH - 1, BATCH - 2, BATCH - 3)
          const batchTabs = workbook.SheetNames.filter(name => /BATCH/i.test(name));
          const sheetsToProcess = batchTabs.length > 0 ? batchTabs : workbook.SheetNames;

          for (const sheetName of sheetsToProcess) {
            const sheet = workbook.Sheets[sheetName];
            const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });
            const parsed = extractStudentsFromRows(rows, sheetName);
            batchCounts[sheetName] = (batchCounts[sheetName] || 0) + parsed.length;
            console.log(`Subsheet "${sheetName}" (${rows.length} raw rows) -> extracted ${parsed.length} students`);
            allParsed = allParsed.concat(parsed);
          }
        } else {
          showToast('Excel parser initializing, please try again.', 'warning');
        }
      } else {
        // Plain CSV / TSV text file
        const text = await file.text();
        const parsed = parseCSV(text);
        console.log(`File "${file.name}" rows:`, parsed.length);
        batchCounts[file.name] = parsed.length;
        allParsed = allParsed.concat(parsed);
      }
    } catch (err) {
      console.warn('File read error:', err);
    }
  }

  if (!allParsed.length) {
    return showToast('No student rows found. Please check file columns or use the Paste box.', 'error');
  }

  // --- DRY-RUN VALIDATION & AUDIT ---
  const validRecords = [];
  allParsed.forEach(s => {
    if (!isValidEmail(s.email)) {
      missingOrInvalidEmails.push(s);
    } else {
      validRecords.push(s);
      if (!duplicateMap.has(s.email)) {
        duplicateMap.set(s.email, []);
      }
      duplicateMap.get(s.email).push(s);
    }
  });

  const duplicateGroups = [];
  let redundantRows = 0;
  for (const [email, list] of duplicateMap.entries()) {
    if (list.length > 1) {
      duplicateGroups.push({ email, count: list.length, occurrences: list });
      redundantRows += (list.length - 1);
    }
  }

  const uniqueValidStudents = sanitizeRoster(validRecords);

  console.group('--- AttendX Student Roster Dry-Run Summary ---');
  console.log('Batch breakdown:', batchCounts);
  console.log(`Total raw records parsed: ${allParsed.length}`);
  console.log(`Valid email records: ${validRecords.length}`);
  console.log(`Missing or invalid emails (${missingOrInvalidEmails.length}):`, missingOrInvalidEmails);
  console.log(`Duplicate email groups (${duplicateGroups.length}):`, duplicateGroups);
  console.log(`Redundant duplicate rows: ${redundantRows}`);
  console.log(`Unique valid students to import: ${uniqueValidStudents.length}`);
  console.groupEnd();

  // Render preview table in modal
  renderRosterPreview(uniqueValidStudents.length > 0 ? uniqueValidStudents : allParsed);

  // Update modal stats
  const totalEl = document.getElementById('modal-roster-total');
  const branchesEl = document.getElementById('modal-roster-branches');
  const sectionsEl = document.getElementById('modal-roster-sections');
  const batchesEl = document.getElementById('modal-roster-batches');
  if (totalEl) totalEl.textContent = uniqueValidStudents.length;
  if (branchesEl) branchesEl.textContent = new Set(uniqueValidStudents.map(s => s.branch)).size;
  if (sectionsEl) sectionsEl.textContent = new Set(uniqueValidStudents.map(s => s.section)).size;
  if (batchesEl) batchesEl.textContent = Object.keys(batchCounts).length || new Set(uniqueValidStudents.map(s => s.batch)).size;

  // IMPORTANT: DRY RUN ONLY - Do not overwrite Firestore automatically until dry run is reviewed
  showToast(
    `Dry-run complete: ${uniqueValidStudents.length} unique valid records (${missingOrInvalidEmails.length} invalid/missing emails, ${redundantRows} duplicates). Reviewed in console. Firestore NOT overwritten.`,
    'info'
  );

  event.target.value = '';
}

function handlePastedCSV() {
  const input = document.getElementById('roster-paste-input');
  if (!input || !input.value.trim()) {
    return showToast('Please paste CSV or sheet text first.', 'error');
  }
  const parsed = parseCSV(input.value);
  if (!parsed.length) {
    return showToast('Failed to parse text. Please ensure columns include Roll Number and Name.', 'error');
  }

  const radio = document.querySelector('input[name="roster-upload-mode"]:checked');
  const mode = radio ? radio.value : 'merge';

  saveMasterRoster(parsed, mode);
  input.value = '';
  document.getElementById('roster-paste-area').style.display = 'none';

  const branches = Array.from(new Set(masterRoster.map(s => s.branch))).join(', ');
  showToast(`Imported ${parsed.length} rows (${masterRoster.length} total students). Branches: ${branches}`, 'success');

  setTimeout(() => {
    closeRosterModal();
  }, 1200);
}

function togglePasteArea() {
  const area = document.getElementById('roster-paste-area');
  const toggleTxt = document.getElementById('paste-toggle-text');
  if (!area) return;
  const isHidden = area.style.display === 'none';
  area.style.display = isHidden ? 'block' : 'none';
  if (toggleTxt) toggleTxt.textContent = isHidden ? 'Hide Paste Area' : 'Paste CSV Text instead';
}

function downloadSampleCSV() {
  const sampleData = [
    ['Roll Number', 'Name', 'Branch', 'Section', 'Batch', 'Mobile No', 'Email', 'College'],
    ['24E51A6601', 'Aarav Sharma', 'CSM', 'A', '2024', '9876543210', 'aarav@hitam.org', 'HITAM'],
    ['24E51A6602', 'Bhavana Reddy', 'CSM', 'A', '2024', '9876543211', 'bhavana@hitam.org', 'HITAM'],
    ['24E51A6603', 'Charan Kumar', 'CSM', 'B', '2024', '9876543212', 'charan@hitam.org', 'HITAM'],
    ['24E51A6604', 'Divya Patel', 'CSE', 'A', '2024', '9876543213', 'divya@hitam.org', 'HITAM']
  ];
  const csvContent = sampleData.map(r => r.join(',')).join('\n');
  const blob = new Blob([csvContent], { type: 'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'sample_student_roster.csv';
  a.click();
  showToast('Downloaded sample student roster CSV template!', 'success');
}

function switchRosterTab(tab) {
  currentRosterTab = tab;
  ['all', 'review', 'conflicts'].forEach(t => {
    const btn = document.getElementById(`roster-tab-${t}`);
    if (btn) {
      if (t === tab) {
        btn.className = 'btn btn-sm btn-primary';
      } else {
        btn.className = 'btn btn-sm btn-outline';
      }
    }
  });

  const titleEl = document.getElementById('roster-tab-title');
  const headEl = document.getElementById('roster-preview-head');

  if (tab === 'review') {
    if (titleEl) titleEl.textContent = 'Students Needing Review / Batch Assignment';
    if (headEl) {
      headEl.innerHTML = `
        <tr>
          <th>Student</th>
          <th>Issue / Status</th>
          <th>Assign Batch</th>
          <th>Correct Email</th>
          <th>Action</th>
        </tr>
      `;
    }
    const needsReview = getReviewList();
    renderRosterReviewList(needsReview);
  } else if (tab === 'conflicts') {
    if (titleEl) titleEl.textContent = 'Alternate Email Conflicts (Review)';
    if (headEl) {
      headEl.innerHTML = `
        <tr>
          <th>Student Name</th>
          <th>Mobile</th>
          <th>Primary Verified Email</th>
          <th>Alternate Submissions</th>
        </tr>
      `;
    }
    renderRosterConflictsList(masterConflicts);
  } else {
    if (titleEl) titleEl.textContent = 'All Students Directory';
    if (headEl) {
      headEl.innerHTML = `
        <tr>
          <th>Name</th>
          <th>Personal Email</th>
          <th>Branch</th>
          <th>Sec</th>
          <th>Correct Batch</th>
          <th>Status</th>
          <th>Action</th>
        </tr>
      `;
    }
    renderRosterPreview(masterRoster);
  }
}

function renderRosterPreview(list) {
  const tbody = document.getElementById('roster-preview-body');
  if (!tbody) return;

  if (!list.length) {
    tbody.innerHTML = `<tr><td colspan="7" style="text-align:center;color:var(--text-muted);padding:1.5rem">No students uploaded yet. Drag & drop your Google Sheet CSV above.</td></tr>`;
    return;
  }

  tbody.innerHTML = list.map(s => {
    const isVerified = s.status === 'verified' && s.batch && s.email;
    const badgeColor = isVerified ? '#10b981' : '#f59e0b';
    const badgeBg = isVerified ? '#ecfdf5' : '#fffbeb';
    const statusLabel = isVerified ? 'Verified' : (s.batch ? 'Missing Email' : 'Pending Batch');

    return `
      <tr>
        <td><strong>${escapeHtml(s.name)}</strong></td>
        <td>${s.email ? escapeHtml(s.email) : '<span style="color:#ef4444;font-style:italic">Missing Email</span>'}</td>
        <td><span class="badge" style="background:#eff6ff;color:#2563eb;font-size:0.75rem">${escapeHtml(s.branch)}</span></td>
        <td>${escapeHtml(s.section || 'A')}</td>
        <td><select id="roster-batch-${encodeURIComponent(s.email || s.rollNumber || s.name)}" style="padding:.25rem;font-size:.78rem" ${!s.email ? 'disabled' : ''}>
          <option value="BATCH - 1" ${s.batch === 'BATCH - 1' ? 'selected' : ''}>BATCH - 1</option>
          <option value="BATCH - 2" ${s.batch === 'BATCH - 2' ? 'selected' : ''}>BATCH - 2</option>
          <option value="BATCH - 3" ${s.batch === 'BATCH - 3' ? 'selected' : ''}>BATCH - 3</option>
        </select></td>
        <td><span class="badge" style="background:${badgeBg};color:${badgeColor};border:1px solid ${badgeColor}33;font-size:0.75rem">${statusLabel}</span></td>
        <td><button class="btn btn-outline" style="padding:.25rem .5rem;font-size:.75rem" onclick="correctRosterBatch('${escapeHtml(s.email || '')}', 'roster-batch-${encodeURIComponent(s.email || s.rollNumber || s.name)}')" ${!s.email ? 'disabled' : ''}>Save</button></td>
      </tr>
    `;
  }).join('');
}

async function correctRosterBatch(email, selectId) {
  const normalizedEmail = String(email || '').trim().toLowerCase();
  const batch = document.getElementById(selectId)?.value;
  if (!normalizedEmail || !['BATCH - 1', 'BATCH - 2', 'BATCH - 3'].includes(batch)) return;
  try {
    let handled = false;
    if (typeof firebase !== 'undefined' && typeof firebase.functions === 'function') {
      try {
        const updateBatch = firebase.functions().httpsCallable('correctStudentBatch');
        await updateBatch({ email: normalizedEmail, batch });
        handled = true;
      } catch (fnErr) {
        console.warn('correctStudentBatch callable unavailable, using direct Firestore:', fnErr.message);
      }
    }
    if (!handled) {
      const rosterDoc = await db.collection('settings').doc('student_roster').get();
      if (rosterDoc.exists) {
        const students = rosterDoc.data().students || [];
        const idx = students.findIndex(s => s.email && s.email.toLowerCase() === normalizedEmail);
        if (idx !== -1) {
          students[idx].batch = batch;
          await db.collection('settings').doc('student_roster').set({ students }, { merge: true });
        }
      }
      const userSnap = await db.collection('users').where('email', '==', normalizedEmail).limit(1).get();
      if (!userSnap.empty) {
        await userSnap.docs[0].ref.update({ batch });
      }
    }
    masterRoster = masterRoster.map(student => student.email?.toLowerCase() === normalizedEmail ? { ...student, batch } : student);
    localStorage.setItem('attendx_master_roster', JSON.stringify(masterRoster));
    populateRosterFilters();
    updateRosterUI();
    showToast(`Batch updated to ${batch}. Existing account profile synchronized.`, 'success');
  } catch (error) {
    console.error('Batch correction failed:', error);
    showToast(error.message || 'Could not update student batch.', 'error');
  }
}

function renderRosterReviewList(list) {
  const tbody = document.getElementById('roster-preview-body');
  if (!tbody) return;

  if (!list.length) {
    tbody.innerHTML = `<tr><td colspan="5" style="text-align:center;color:#10b981;padding:1.5rem">✓ All student records are verified and assigned! No records pending review.</td></tr>`;
    return;
  }

  tbody.innerHTML = list.map((s, idx) => {
    const reason = s.reviewReason || (!s.batch ? 'Google Form submission without batch partition' : 'Missing email address');
    const selectId = `review-batch-sel-${idx}`;
    const emailId = `review-email-inp-${idx}`;

    return `
      <tr style="background:#fffdfa">
        <td>
          <div style="font-weight:700">${escapeHtml(s.name)}</div>
          <div style="font-size:0.75rem;color:var(--text-muted)">${escapeHtml(s.branch)} - Sec ${escapeHtml(s.section || '—')} | Ph: ${escapeHtml(s.mobile || '—')}</div>
          ${s.sourceSheet ? `<div style="font-size:0.7rem;color:var(--text-muted)">Source: ${escapeHtml(s.sourceSheet)} (Row ${s.sourceRow || '—'})</div>` : ''}
        </td>
        <td>
          <span class="badge" style="background:#fef3c7;color:#b45309;font-size:0.72rem;display:inline-block;white-space:normal">${escapeHtml(reason)}</span>
        </td>
        <td>
          <select id="${selectId}" style="padding:0.25rem 0.4rem;font-size:0.78rem;border:1px solid var(--border);border-radius:4px">
            <option value="">-- Select Batch --</option>
            <option value="BATCH - 1" ${s.batch === 'BATCH - 1' ? 'selected' : ''}>BATCH - 1</option>
            <option value="BATCH - 2" ${s.batch === 'BATCH - 2' ? 'selected' : ''}>BATCH - 2</option>
            <option value="BATCH - 3" ${s.batch === 'BATCH - 3' ? 'selected' : ''}>BATCH - 3</option>
          </select>
        </td>
        <td>
          <input type="email" id="${emailId}" value="${escapeHtml(s.email || s.rawEmail || '')}" placeholder="personal@gmail.com" style="padding:0.25rem 0.45rem;font-size:0.78rem;border:1px solid var(--border);border-radius:4px;width:160px" />
        </td>
        <td>
          <button type="button" class="btn btn-primary" style="padding:0.25rem 0.65rem;font-size:0.75rem;white-space:nowrap" onclick="resolveReviewStudent(${idx}, '${selectId}', '${emailId}')">
            Approve & Verify
          </button>
        </td>
      </tr>
    `;
  }).join('');
}

function renderRosterConflictsList(list) {
  const tbody = document.getElementById('roster-preview-body');
  if (!tbody) return;

  if (!list.length) {
    tbody.innerHTML = `<tr><td colspan="4" style="text-align:center;color:var(--text-muted);padding:1.5rem">No alternate-email conflicts recorded.</td></tr>`;
    return;
  }

  tbody.innerHTML = list.map(c => {
    const studentName = c.enrolledStudent?.name || c.name || 'Student';
    const mobile = c.enrolledStudent?.mobile || c.mobile || '—';
    const primaryEmail = c.enrolledStudent?.email || c.email || '<span style="color:#ef4444;font-style:italic">Missing in Sheet</span>';
    const altEmail = c.alternateSubmission?.email || c.alternateSubmission?.rawEmail || (c.alternateEmails || []).join(', ') || '—';

    return `
      <tr>
        <td>
          <strong>${escapeHtml(studentName)}</strong>
          ${c.enrolledStudent?.branch ? `<div style="font-size:0.75rem;color:var(--text-muted)">${escapeHtml(c.enrolledStudent.branch)} - Sec ${escapeHtml(c.enrolledStudent.section || '—')} (${escapeHtml(c.enrolledStudent.batch || 'Unassigned')})</div>` : ''}
        </td>
        <td>${escapeHtml(mobile)}</td>
        <td><span style="color:#15803d;font-weight:600">${escapeHtml(primaryEmail)}</span></td>
        <td>
          <span style="color:#b45309;font-size:0.78rem;font-weight:600">${escapeHtml(altEmail)}</span>
          ${c.alternateSubmission?.sourceSheet ? `<div style="font-size:0.7rem;color:var(--text-muted)">Source: ${escapeHtml(c.alternateSubmission.sourceSheet)} (Row ${c.alternateSubmission.sourceRow || '—'})</div>` : ''}
        </td>
      </tr>
    `;
  }).join('');
}

async function resolveReviewStudent(idx, batchSelectId, emailInputId) {
  // STRICT: Only authorized admins can resolve cases and assign batches/emails
  if (!currentUser || currentUser.role !== 'admin') {
    alert('Security restriction: Only verified administrators can resolve review records and assign batches.');
    return;
  }

  const reviewList = getReviewList();
  const revItem = reviewList[idx];
  if (!revItem) return;

  const batchSelect = document.getElementById(batchSelectId);
  const emailInput = document.getElementById(emailInputId);

  const assignedBatch = batchSelect ? batchSelect.value.trim() : (revItem.batch || '');
  const correctedEmail = emailInput ? emailInput.value.trim().toLowerCase() : (revItem.email || '');

  if (!assignedBatch) {
    alert('Please select an assigned batch (BATCH - 1, BATCH - 2, or BATCH - 3).');
    return;
  }

  if (!correctedEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(correctedEmail)) {
    alert('Please enter a valid personal email address for the student.');
    return;
  }

  // Find or create corresponding student in masterRoster
  let targetStudent = masterRoster.find(s => 
    (revItem.sourceSheet && revItem.sourceRow && s.sourceSheet === revItem.sourceSheet && s.sourceRow === revItem.sourceRow) ||
    (revItem.mobile && s.mobile && revItem.mobile === s.mobile) ||
    (revItem.email && s.email && revItem.email.toLowerCase() === s.email.toLowerCase()) ||
    (revItem.name && s.name && revItem.name.trim().toLowerCase() === s.name.trim().toLowerCase() && revItem.branch === s.branch)
  );

  if (targetStudent) {
    targetStudent.batch = assignedBatch;
    targetStudent.email = correctedEmail;
    targetStudent.status = 'verified';
    targetStudent.reviewReason = null;
  } else {
    targetStudent = {
      name: revItem.name,
      branch: revItem.branch,
      section: revItem.section,
      batch: assignedBatch,
      email: correctedEmail,
      mobile: revItem.mobile || '',
      rollNumber: revItem.rollNumber || '',
      studentId: revItem.studentId || '',
      college: revItem.college || 'HITAM',
      status: 'verified',
      reviewReason: null,
      sourceSheet: revItem.sourceSheet || 'Form Responses 1',
      sourceRow: revItem.sourceRow || null
    };
    masterRoster.push(targetStudent);
  }

  // Remove resolved item from masterIncompleteReviews if present
  if (Array.isArray(masterIncompleteReviews)) {
    const revIndex = masterIncompleteReviews.indexOf(revItem);
    if (revIndex !== -1) {
      masterIncompleteReviews.splice(revIndex, 1);
    } else if (idx < masterIncompleteReviews.length) {
      masterIncompleteReviews.splice(idx, 1);
    }
  }

  try {
    await db.collection('settings').doc('student_roster').set({
      students: masterRoster,
      count: masterRoster.length,
      incompleteRecordsReview: masterIncompleteReviews,
      updatedAt: firebase.firestore.FieldValue.serverTimestamp()
    }, { merge: true });

    localStorage.setItem('attendx_master_roster', JSON.stringify(masterRoster));
    showToast(`Approved & verified ${targetStudent.name} in ${assignedBatch}`, 'success');
    updateRosterUI();
    renderRosterReviewList(getReviewList());
  } catch (err) {
    console.error('Failed to update student review status:', err);
    showToast('Failed to save student update to Firestore.', 'error');
  }
}

function filterRosterPreview(query) {
  const q = (query || '').toLowerCase().trim();
  if (currentRosterTab === 'review') {
    const needsReview = getReviewList();
    if (!q) return renderRosterReviewList(needsReview);
    const filtered = needsReview.filter(s =>
      (s.name || '').toLowerCase().includes(q) ||
      (s.email || '').toLowerCase().includes(q) ||
      (s.branch || '').toLowerCase().includes(q) ||
      (s.mobile || '').includes(q)
    );
    return renderRosterReviewList(filtered);
  }

  if (currentRosterTab === 'conflicts') {
    if (!q) return renderRosterConflictsList(masterConflicts);
    const filtered = masterConflicts.filter(c =>
      (c.name || '').toLowerCase().includes(q) ||
      (c.email || '').toLowerCase().includes(q) ||
      (c.mobile || '').includes(q)
    );
    return renderRosterConflictsList(filtered);
  }

  if (!q) return renderRosterPreview(masterRoster);

  const filtered = masterRoster.filter(s =>
    (s.name || '').toLowerCase().includes(q) ||
    (s.email || '').toLowerCase().includes(q) ||
    (s.branch || '').toLowerCase().includes(q) ||
    (s.section || '').toLowerCase().includes(q)
  );
  renderRosterPreview(filtered);
}

function openRosterModal(mode = 'all') {
  const modal = document.getElementById('roster-modal');
  if (modal) {
    modal.classList.add('show');
    switchRosterTab(mode === 'review' ? 'review' : (mode === 'conflicts' ? 'conflicts' : 'all'));
  }
}

function closeRosterModal() {
  const modal = document.getElementById('roster-modal');
  if (modal) modal.classList.remove('show');
}

// ---- Add Single Student Handlers ----
function openAddStudentModal() {
  const modal = document.getElementById('add-student-modal');
  if (modal) {
    modal.classList.add('show');
    const errEl = document.getElementById('add-student-error');
    if (errEl) { errEl.textContent = ''; errEl.style.display = 'none'; }
    const nameEl = document.getElementById('as-name');
    if (nameEl) setTimeout(() => nameEl.focus(), 100);
  }
}

function closeAddStudentModal() {
  const modal = document.getElementById('add-student-modal');
  if (modal) modal.classList.remove('show');
  ['as-name', 'as-email', 'as-branch', 'as-section', 'as-roll', 'as-mobile'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = '';
  });
  const errEl = document.getElementById('add-student-error');
  if (errEl) { errEl.textContent = ''; errEl.style.display = 'none'; }
}

async function submitAddSingleStudent(e) {
  if (e && e.preventDefault) e.preventDefault();
  const name = document.getElementById('as-name').value.trim();
  const email = document.getElementById('as-email').value.trim().toLowerCase();
  const branch = document.getElementById('as-branch').value.trim().toUpperCase();
  const section = document.getElementById('as-section').value.trim().toUpperCase();
  const batch = document.getElementById('as-batch').value;
  const roll = (document.getElementById('as-roll').value || '').trim().toUpperCase();
  const mobile = (document.getElementById('as-mobile').value || '').replace(/[^0-9]/g, '');

  const errEl = document.getElementById('add-student-error');
  const btn = document.getElementById('as-submit-btn');

  if (!name || !email || !branch || !section || !batch) {
    if (errEl) { errEl.textContent = 'Please fill in Name, Email, Branch, Section, and Batch.'; errEl.style.display = 'block'; }
    return;
  }

  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(email)) {
    if (errEl) { errEl.textContent = 'Please enter a valid email address.'; errEl.style.display = 'block'; }
    return;
  }

  // Check duplicate email
  const existing = masterRoster.find(s => (s.email || '').trim().toLowerCase() === email);
  if (existing) {
    if (errEl) { errEl.textContent = `A student with email "${email}" already exists in ${existing.batch || 'roster'}.`; errEl.style.display = 'block'; }
    return;
  }

  if (btn) btn.disabled = true;

  const newStudent = {
    name,
    email,
    branch,
    section,
    batch,
    rollNumber: roll,
    studentId: roll,
    mobile,
    college: 'HITAM',
    status: 'verified',
    sourceSheet: 'Admin Added',
    createdAt: new Date().toISOString()
  };

  try {
    // 1. Add to Firestore settings/student_roster
    await db.collection('settings').doc('student_roster').set({
      students: firebase.firestore.FieldValue.arrayUnion(newStudent)
    }, { merge: true });

    // 2. Add to in-memory masterRoster
    masterRoster.push(newStudent);

    // 3. Add to window.ATTENDX_ROSTER
    if (typeof window !== 'undefined' && window.ATTENDX_ROSTER && Array.isArray(window.ATTENDX_ROSTER.students)) {
      window.ATTENDX_ROSTER.students.push(newStudent);
    }

    // 4. Update UI stats and tables
    updateRosterSummaryUI();
    renderRosterPreview(masterRoster);

    closeAddStudentModal();
    showToast(`Student "${name}" added to roster successfully!`, 'success');
  } catch (err) {
    console.error('Error adding student:', err);
    if (errEl) { errEl.textContent = 'Failed to add student: ' + err.message; errEl.style.display = 'block'; }
  } finally {
    if (btn) btn.disabled = false;
  }
}

// Drag & drop handlers for dropzone
document.addEventListener('DOMContentLoaded', () => {
  const dropzone = document.getElementById('roster-dropzone');
  if (!dropzone) return;

  ['dragenter', 'dragover'].forEach(eventName => {
    dropzone.addEventListener(eventName, (e) => {
      e.preventDefault();
      e.stopPropagation();
      dropzone.classList.add('dragover');
    }, false);
  });

  ['dragleave', 'drop'].forEach(eventName => {
    dropzone.addEventListener(eventName, (e) => {
      e.preventDefault();
      e.stopPropagation();
      dropzone.classList.remove('dragover');
    }, false);
  });

  dropzone.addEventListener('drop', (e) => {
    const files = e.dataTransfer.files;
    if (files.length) {
      handleRosterFileUpload({ target: { files } });
    }
  });
});

// ---- Copy Absentee Contacts ----
function copyAbsenteeContacts(type) {
  let enrolled = [];
  if (currentSession) {
    enrolled = getFilteredEnrolled(currentSession.batch, currentSession.branch, currentSession.section);
  } else {
    enrolled = masterRoster;
  }

  const presentRolls = new Set(
    attendanceData.map(r => (r.rollNumber || r.studentId || '').trim().toUpperCase()).filter(Boolean)
  );

  const absentees = enrolled.filter(s => {
    const roll = (s.rollNumber || s.studentId || '').trim().toUpperCase();
    return roll && !presentRolls.has(roll);
  });

  if (!absentees.length) {
    return showToast('No absentees to copy contacts for.', 'info');
  }

  if (type === 'mobile') {
    const numbers = absentees.map(s => (s.mobile || '').replace(/[^0-9]/g, '')).filter(Boolean);
    if (!numbers.length) return showToast('No phone numbers recorded for absentees.', 'warning');
    const text = numbers.join(', ');
    navigator.clipboard.writeText(text).then(() => {
      showToast(`Copied ${numbers.length} absentee phone numbers to clipboard!`, 'success');
    });
  } else {
    const emails = absentees.map(s => (s.email || '').trim()).filter(Boolean);
    if (!emails.length) return showToast('No emails recorded for absentees.', 'warning');
    const text = emails.join(', ');
    navigator.clipboard.writeText(text).then(() => {
      showToast(`Copied ${emails.length} absentee emails to clipboard!`, 'success');
    });
  }
}

// ---- Export CSV Options ----
function exportCSV(type = 'absent') {
  let enrolled = [];
  if (currentSession) {
    enrolled = getFilteredEnrolled(currentSession.batch, currentSession.branch, currentSession.section);
  } else {
    enrolled = masterRoster;
  }

  const presentRolls = new Set(
    attendanceData.map(r => (r.rollNumber || r.studentId || '').trim().toUpperCase()).filter(Boolean)
  );

  const absentees = enrolled.filter(s => {
    const roll = (s.rollNumber || s.studentId || '').trim().toUpperCase();
    return roll && !presentRolls.has(roll);
  });

  const sessionName = currentSession?.className || 'Class';
  const dateStr = new Date().toISOString().slice(0, 10);

  if (type === 'absent') {
    if (!absentees.length) return showToast('No absentees to export.', 'info');

    const rows = [['Roll Number', 'Name', 'Branch', 'Section', 'Batch', 'Mobile Number', 'Email', 'College', 'Status']];
    absentees.forEach(s => {
      rows.push([
        `"${(s.rollNumber || '').replace(/"/g, '""')}"`,
        `"${(s.name || '').replace(/"/g, '""')}"`,
        `"${(s.branch || '').replace(/"/g, '""')}"`,
        `"${(s.section || '').replace(/"/g, '""')}"`,
        `"${(s.batch || '').replace(/"/g, '""')}"`,
        `"${(s.mobile || '').replace(/"/g, '""')}"`,
        `"${(s.email || '').replace(/"/g, '""')}"`,
        `"${(s.college || '').replace(/"/g, '""')}"`,
        'Absent'
      ]);
    });

    downloadCSVBlob(rows, `absentees_${sessionName}_${dateStr}.csv`);
    showToast(`Exported ${absentees.length} absentees to CSV!`, 'success');

  } else if (type === 'present') {
    if (!attendanceData.length) return showToast('No present attendance data to export.', 'info');

    const rows = [['Roll Number', 'Name', 'Branch', 'College', 'Marked At', 'Status']];
    attendanceData.forEach(r => {
      rows.push([
        `"${(r.rollNumber || r.studentId || '').replace(/"/g, '""')}"`,
        `"${(r.name || '').replace(/"/g, '""')}"`,
        `"${(r.branch || '').replace(/"/g, '""')}"`,
        `"${(r.college || '').replace(/"/g, '""')}"`,
        `"${formatTime(r.markedAt)}"`,
        'Present'
      ]);
    });

    downloadCSVBlob(rows, `present_${sessionName}_${dateStr}.csv`);
    showToast(`Exported ${attendanceData.length} present students to CSV!`, 'success');

  } else {
    // Export Full Combined Attendance Report (Present + Absent)
    if (!enrolled.length && !attendanceData.length) {
      return showToast('No attendance or roster data available.', 'info');
    }

    const presentMap = new Map();
    attendanceData.forEach(r => {
      const roll = (r.rollNumber || r.studentId || '').trim().toUpperCase();
      if (roll) presentMap.set(roll, r);
    });

    const rows = [['Roll Number', 'Name', 'Branch', 'Section', 'Batch', 'Mobile Number', 'Email', 'Attendance Status', 'Marked At']];

    enrolled.forEach(s => {
      const roll = (s.rollNumber || '').trim().toUpperCase();
      const presentRecord = presentMap.get(roll);
      const isPresent = Boolean(presentRecord);

      rows.push([
        `"${(s.rollNumber || '').replace(/"/g, '""')}"`,
        `"${(s.name || '').replace(/"/g, '""')}"`,
        `"${(s.branch || '').replace(/"/g, '""')}"`,
        `"${(s.section || '').replace(/"/g, '""')}"`,
        `"${(s.batch || '').replace(/"/g, '""')}"`,
        `"${(s.mobile || '').replace(/"/g, '""')}"`,
        `"${(s.email || '').replace(/"/g, '""')}"`,
        isPresent ? 'Present' : 'Absent',
        isPresent ? `"${formatTime(presentRecord.markedAt)}"` : '—'
      ]);
    });

    downloadCSVBlob(rows, `master_attendance_${sessionName}_${dateStr}.csv`);
    showToast(`Exported full report (${enrolled.length} students) to CSV!`, 'success');
  }
}

function downloadCSVBlob(rows, filename) {
  const csv = rows.map(r => r.join(',')).join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
}

// ---- Export Full Multi-Sheet Excel Workbook (.xlsx) ----
function exportMasterWorkbookXLSX() {
  if (typeof XLSX === 'undefined') {
    return showToast('Excel engine loading, please try again.', 'warning');
  }

  const wb = XLSX.utils.book_new();
  const dateStr = new Date().toISOString().slice(0, 10);
  const sessionName = currentSession?.className || 'General';

  // Exports are attendance reports only: include checked-in students and no roster tabs.
  const sheetStudents = window.dailySheetStudents || [];
  const sheetChecks = Array.from(document.querySelectorAll('#daily-sheet-body input[type="checkbox"]'));
  const manualPresent = sheetStudents.filter((_, index) => sheetChecks[index]?.checked);
  const exportStudents = currentSession ? attendanceData : manualPresent;
  const exportSessionId = currentSession?.id || window.dailySheetContext?.sessionId || '';
  const presentRows = [['Roll Number', 'Name', 'Branch', 'Section', 'Batch', 'Marked At', 'Session ID']];
  exportStudents.forEach(r => presentRows.push([
    r.rollNumber || r.studentId || '', r.name || '', r.branch || '', r.section || '', r.batch || '',
    r.markedAt ? formatTime(r.markedAt) : '', exportSessionId
  ]));
  if (!exportStudents.length) return showToast('No present students to export yet.', 'info');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(presentRows), 'Present Students');

  XLSX.writeFile(wb, `AttendX_Master_Roster_${sessionName}_${dateStr}.xlsx`);
  showToast(`Downloaded ${exportStudents.length} present students (.xlsx).`, 'success');
}

// ---- End Session ----
async function endSession() {
  if (!currentSession) return;

  clearInterval(qrRotateInterval);
  clearInterval(sessionTimerInterval);
  clearTimeout(sessionEndTimeout);
  if (typeof attendanceUnsubscribe === 'function') {
    attendanceUnsubscribe();
  }
  attendanceUnsubscribe = null;

  if (sessionDocRef) {
    try {
      await sessionDocRef.update({ status: 'ended' });
    } catch(e) {}
  }

  hideQRFullscreen();
  document.getElementById('active-session-card').style.display = 'none';
  const startBtn = document.getElementById('start-btn');
  if (startBtn) {
    startBtn.disabled = false;
    startBtn.innerHTML = '<svg class="icon-svg fill-current" viewBox="0 0 24 24"><polygon points="5 3 19 12 5 21 5 3"/></svg> <span>Start Session</span>';
  }
  document.getElementById('qr-box').innerHTML = '';
  currentSession = null;
  sessionDocRef  = null;

  showToast('Session ended. Attendance and absentees finalized.', 'success');
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

// ---- Logout ----
function logout() {
  auth.signOut().then(() => window.location.href = 'index.html');
}

// ---- Utils ----
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
  if (!container) return;
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.textContent = msg;
  container.appendChild(toast);
  setTimeout(() => toast.remove(), 3500);
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ---- Google Sheet Embedding & Live Sync Controls ----
function toggleGoogleSheetSection() {
  const card = document.getElementById('google-sheet-embed-card');
  if (!card) return;
  if (card.style.display === 'none') {
    card.style.display = 'block';
    card.scrollIntoView({ behavior: 'smooth', block: 'start' });
  } else {
    card.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
}

async function syncFromGoogleSheetNow() {
  showToast('Upload a roster CSV through the secured admin roster panel.', 'info');
}

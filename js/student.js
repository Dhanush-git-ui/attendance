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
        if (profileData.role === 'student' && profileData.status === 'pending') {
          const complete = firebase.functions().httpsCallable('completeStudentRegistration');
          const result = await complete({});
          if (result.data && result.data.student) profileData = result.data.student;
        }
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
  const editBatchBtn = document.getElementById('edit-batch-btn');
  if (batchBadge) {
    if (currentUser.batch) {
      batchBadge.textContent = currentUser.batch;
      batchBadge.style.display = 'inline-flex';
    } else {
      batchBadge.style.display = 'none';
    }
  }
  if (editBatchBtn) {
    editBatchBtn.style.display = 'none';
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

  if (typeof Html5Qrcode === 'undefined') {
    showStatus('The QR scanner library did not load. Please check your network and refresh the page.', 'error');
    return;
  }

  if (!window.isSecureContext && window.location.hostname !== 'localhost' && window.location.hostname !== '127.0.0.1') {
    showStatus('Camera access requires a secure connection (HTTPS). Open the site using its HTTPS address.', 'error');
    return;
  }

  try {
    html5QrCode = new Html5Qrcode('reader');
    const qrConfig = { fps: 10, qrbox: { width: 250, height: 250 } };

    try {
      // Try back/environment camera first (mobile)
      await html5QrCode.start({ facingMode: 'environment' }, qrConfig, onScanSuccess, onScanError);
    } catch (envErr) {
      console.warn('Environment camera unavailable, falling back to default/front camera:', envErr);
      // Fallback for laptops/desktops with front webcam
      await html5QrCode.start({ facingMode: 'user' }, qrConfig, onScanSuccess, onScanError);
    }

    scanning = true;
    document.getElementById('scan-btn').innerHTML = '<svg class="icon-svg fill-current" viewBox="0 0 24 24"><rect x="5" y="5" width="14" height="14" rx="2" ry="2"/></svg> <span>Stop Camera</span>';
    document.getElementById('scan-btn').className = 'btn btn-danger btn-full';
    showStatus('Camera active — point at classroom QR code', 'info');
  } catch (e) {
    console.error('Camera startup failed:', e);
    scanning = false;
    if (html5QrCode) {
      try {
        if (html5QrCode.isScanning) await html5QrCode.stop();
      } catch (_) {}
      try { await html5QrCode.clear(); } catch (_) {}
      html5QrCode = null;
    }

    let message = 'Camera could not start.';
    const errName = (e && e.name) || '';
    const errMsg = (e && e.message) || '';

    if (errName === 'NotAllowedError' || /permission|denied/i.test(errMsg)) {
      message = 'Camera permission was denied. Please allow camera permissions for this site in your browser settings and try again.';
    } else if (errName === 'NotFoundError' || errName === 'DevicesNotFoundError') {
      message = 'No camera was found on this device.';
    } else if (errName === 'NotReadableError' || errName === 'TrackStartError') {
      message = 'Camera is currently locked or in use by another app (e.g. Zoom, Teams, or another tab). Close other camera apps and try again.';
    } else if (errName === 'OverconstrainedError') {
      message = 'Camera resolution or constraints not supported by your device camera.';
    } else if (errName === 'SecurityError') {
      message = 'Camera access blocked by security policy. Ensure you are on HTTPS.';
    } else if (errMsg) {
      message = `Camera error: ${errMsg}`;
    } else {
      message = 'Camera could not start. Check permissions and close any other apps using the camera.';
    }

    showStatus(message, 'error');
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

  try {
    let payload;
    try {
      payload = JSON.parse(rawValue);
    } catch (_) {
      showStatus('Invalid QR code. Please scan the classroom QR.', 'error');
      return;
    }

    const sessionId = payload && payload.sessionId;
    const token = payload && payload.token;
    if (!sessionId || !token) {
      showStatus('Invalid QR format.', 'error');
      return;
    }

    await stopScanner();
    showStatus('Verifying attendance with server...', 'info');
    const markAttendance = firebase.functions().httpsCallable('markAttendance');
    const result = await markAttendance({ sessionId, token });
    const data = result.data || {};
    showStatus('Attendance marked for "' + (data.className || 'Class') + '" — ' + (data.subject || 'Session'), 'success');
    showToast('Attendance recorded!', 'success');
    await loadHistory();
  } catch (error) {
    console.error('Attendance verification error:', error);
    const message = error.message || 'Failed to mark attendance. Please scan the current code.';
    showStatus(message, 'error');
    showToast(message, 'error');
  } finally {
    processing = false;
  }
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

// ---- Academic Batch Change Functions ----
function openEditBatchModal() {
  const modal = document.getElementById('edit-batch-modal');
  const sel = document.getElementById('change-batch-select');
  if (sel && currentUser && currentUser.batch) {
    sel.value = currentUser.batch;
  }
  if (modal) modal.style.display = 'flex';
}

function closeEditBatchModal() {
  const modal = document.getElementById('edit-batch-modal');
  if (modal) modal.style.display = 'none';
}

async function saveStudentBatch() {
  const sel = document.getElementById('change-batch-select');
  if (!sel || !currentUser || !currentUser.uid) return;
  const newBatch = sel.value;
  if (!newBatch) return;

  const btn = document.getElementById('save-batch-btn');
  if (btn) btn.disabled = true;

  try {
    currentUser.batch = newBatch;
    await db.collection('users').doc(currentUser.uid).update({ batch: newBatch });
    localStorage.setItem(`user_profile_${currentUser.uid}`, JSON.stringify(currentUser));

    // Also update in settings/student_roster if enrolled
    try {
      const rosterDoc = await db.collection('settings').doc('student_roster').get();
      if (rosterDoc.exists) {
        const students = rosterDoc.data().students || [];
        const studentEmail = currentUser.email || currentUser.personalEmail;
        const studentMobile = currentUser.mobile;
        const idx = students.findIndex(s => 
          (studentEmail && s.email && s.email.toLowerCase() === studentEmail.toLowerCase()) ||
          (studentMobile && s.mobile && s.mobile.replace(/[^0-9]/g, '') === String(studentMobile).replace(/[^0-9]/g, ''))
        );
        if (idx !== -1) {
          students[idx].batch = newBatch;
          await db.collection('settings').doc('student_roster').set({ students }, { merge: true });
        }
      }
    } catch (rErr) {
      console.warn('Could not update roster batch:', rErr);
    }

    if (typeof window !== 'undefined' && window.ATTENDX_ROSTER && Array.isArray(window.ATTENDX_ROSTER.students)) {
      const liveIdx = window.ATTENDX_ROSTER.students.findIndex(s => 
        (currentUser.email && s.email && s.email.toLowerCase() === currentUser.email.toLowerCase()) ||
        (currentUser.mobile && s.mobile && s.mobile.replace(/[^0-9]/g, '') === String(currentUser.mobile).replace(/[^0-9]/g, ''))
      );
      if (liveIdx !== -1) {
        window.ATTENDX_ROSTER.students[liveIdx].batch = newBatch;
      }
    }

    populateStudentInfo();
    closeEditBatchModal();
    showToast(`Batch updated to ${newBatch}!`, 'success');
  } catch (err) {
    console.error('Failed to update batch:', err);
    showToast('Failed to update batch: ' + (err.message || 'Please try again'), 'error');
  } finally {
    if (btn) btn.disabled = false;
  }
}



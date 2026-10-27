// Global state for registration roster verification & lookup debouncing
var verifiedRosterData = null;
var emailLookupDebounce = null;
var mobileLookupDebounce = null;

// ---- Role Tabs Switcher (Student / Trainer / Overall Admin) ----
function switchRoleTab(role) {
  ['student', 'trainer', 'admin'].forEach(r => {
    const tab = document.getElementById(`tab-${r}`);
    const section = document.getElementById(r === 'admin' ? 'admin-form-section' : `${r}-form-section`);
    if (tab) tab.classList.toggle('active', r === role);
    if (section) section.classList.toggle('active', r === role);
  });
  hideError();
}

// ---- On page load: redirect students to student.html if authenticated ----
auth.onAuthStateChanged(async (user) => {
  if (user) {
    try {
      let role = null;
      try {
        const doc = await db.collection('users').doc(user.uid).get();
        if (doc.exists) {
          role = doc.data().role;
        }
      } catch (e) {
        console.warn('Firestore doc lookup restricted in onAuthStateChanged:', e);
      }

      if (!role) {
        const cached = localStorage.getItem(`user_profile_${user.uid}`);
        if (cached) {
          try { role = JSON.parse(cached).role; } catch (_) {}
        } else if (user.email && user.email.endsWith('@attendx.local')) {
          role = 'student';
        }
      }

      // Only redirect students to their dashboard from the home page.
      if (role === 'student') {
        window.location.href = 'student.html';
      }
    } catch (e) {
      console.error('Auth state check error:', e);
    }
  }
});

// ---- Helper: Merge any locally registered students into ATTENDX_ROSTER ----
function getMergedRosterStudents() {
  const list = [];
  if (typeof window !== 'undefined' && window.ATTENDX_ROSTER && Array.isArray(window.ATTENDX_ROSTER.students)) {
    list.push(...window.ATTENDX_ROSTER.students);
  }
  try {
    const custom = JSON.parse(localStorage.getItem('attendx_registered_students') || '[]');
    if (Array.isArray(custom)) {
      custom.forEach(c => {
        if (c && c.email && !list.some(s => s.email && s.email.toLowerCase() === c.email.toLowerCase())) {
          list.push(c);
        }
      });
    }
  } catch (_) {}
  return list;
}

// ---- Student Login (email address only; roster contact data stays private) ----
async function loginStudent() {
  const inputEl = document.getElementById('student-identifier') || document.getElementById('student-roll');
  const passInput = document.getElementById('student-password');
  if (!inputEl || !passInput) return;

  const email = inputEl.value.trim().toLowerCase();
  const password = passInput.value;
  if (!email || !password) return showError('Enter your registered email address and password.');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return showError('Sign in with your registered email address. Phone and name lookup has been disabled to protect student information.');
  }

  setLoading('student-login-btn', true);
  try {
    const cred = await auth.signInWithEmailAndPassword(email, password);
    const profile = await db.collection('users').doc(cred.user.uid).get();
    if (!profile.exists || profile.data().role !== 'student' || profile.data().status !== 'active') {
      await auth.signOut();
      return showError('Student registration is incomplete or pending review. Please contact your administrator.');
    }
    window.location.href = 'student.html';
  } catch (error) {
    showError(error.message || getFriendlyError(error.code));
  } finally {
    setLoading('student-login-btn', false);
  }
}// ---- Open & Close Student Registration Modal ----
function openStudentRegister() {
  const modal = document.getElementById('register-modal');
  if (modal) {
    modal.classList.add('show');
    const errEl = document.getElementById('register-error');
    if (errEl) {
      errEl.textContent = '';
      errEl.classList.remove('show');
    }
    const nameEl = document.getElementById('reg-name');
    if (nameEl) setTimeout(() => nameEl.focus(), 100);
  }
}

function closeStudentRegister() {
  const modal = document.getElementById('register-modal');
  if (modal) modal.classList.remove('show');
  
  const fields = ['reg-name', 'reg-email', 'reg-branch', 'reg-section', 'reg-batch', 'reg-roll', 'reg-password', 'reg-confirm-password'];
  fields.forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = '';
  });
  
  const errEl = document.getElementById('register-error');
  if (errEl) {
    errEl.textContent = '';
    errEl.classList.remove('show');
  }

  const hintEl = document.getElementById('roster-match-hint');
  if (hintEl) {
    hintEl.innerHTML = '';
    hintEl.className = 'password-match-hint';
  }

  const matchEl = document.getElementById('password-match-indicator');
  if (matchEl) {
    matchEl.innerHTML = '';
    matchEl.className = 'password-match-hint';
  }

  const strengthEl = document.getElementById('password-strength-indicator');
  if (strengthEl) {
    strengthEl.innerHTML = '';
    strengthEl.className = 'password-match-hint';
  }

  verifiedRosterData = null;
}

// ---- Real-time Password Match & Strength Check ----
function evaluatePasswordStrength(password) {
  if (!password) return null;
  if (password.length < 6) {
    return { level: 'weak', label: 'Password must be at least 6 characters long', color: '#ef4444' };
  }
  const hasLetter = /[a-zA-Z]/.test(password);
  const hasNumber = /[0-9]/.test(password);
  const hasSymbol = /[^a-zA-Z0-9]/.test(password);
  
  if (password.length >= 8 && hasLetter && hasNumber && hasSymbol) {
    return { level: 'strong', label: 'Strong password', color: '#10b981' };
  }
  if (password.length >= 6 && hasLetter && hasNumber) {
    return { level: 'good', label: 'Good password', color: '#2563eb' };
  }
  return { level: 'fair', label: 'Fair (add numbers or symbols for better security)', color: '#f59e0b' };
}

function checkRegPasswordMatch() {
  const passEl = document.getElementById('reg-password');
  const confirmEl = document.getElementById('reg-confirm-password');
  const indicator = document.getElementById('password-match-indicator');
  const strengthIndicator = document.getElementById('password-strength-indicator');
  if (!passEl) return;

  const p1 = passEl.value;
  const p2 = confirmEl ? confirmEl.value : '';

  // Password strength
  if (strengthIndicator) {
    const strength = evaluatePasswordStrength(p1);
    if (strength) {
      strengthIndicator.innerHTML = `<span style="color:${strength.color};font-size:0.82rem">• ${strength.label}</span>`;
    } else {
      strengthIndicator.innerHTML = '';
    }
  }

  if (!indicator) return;

  if (!p2) {
    indicator.innerHTML = '';
    indicator.className = 'password-match-hint';
    return;
  }

  if (p1 === p2 && p1.length >= 6) {
    indicator.className = 'password-match-hint text-success';
    indicator.innerHTML = '<svg class="icon-svg" viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"/></svg><span>Passwords match</span>';
  } else if (p1 !== p2) {
    indicator.className = 'password-match-hint text-warn';
    indicator.innerHTML = '<svg class="icon-svg" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg><span>Passwords do not match yet</span>';
  } else {
    indicator.innerHTML = '';
    indicator.className = 'password-match-hint';
  }
}

// Close modals on Escape
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    closeStudentRegister();
    closeTrainerRegister();
  }
});

// ---- Student Roster Lookup (Direct Firestore / Client-side) ----
var registrationLookupSequence = 0;
let cachedRosterStudents = null;

async function getRosterStudents() {
  if (cachedRosterStudents && cachedRosterStudents.length > 0) return cachedRosterStudents;
  const list = [];
  if (typeof window !== 'undefined' && window.ATTENDX_ROSTER && Array.isArray(window.ATTENDX_ROSTER.students)) {
    list.push(...window.ATTENDX_ROSTER.students);
  }
  try {
    const doc = await db.collection('settings').doc('student_roster').get();
    if (doc.exists && Array.isArray(doc.data().students)) {
      doc.data().students.forEach(s => {
        if (s && s.email && !list.some(existing => existing.email && existing.email.toLowerCase() === s.email.toLowerCase())) {
          list.push(s);
        }
      });
    }
  } catch (err) {
    console.warn('Could not read settings/student_roster directly:', err.message);
  }
  cachedRosterStudents = list;
  return list;
}

async function onStudentEmailRegInput(val) {
  clearTimeout(emailLookupDebounce);
  const sequence = ++registrationLookupSequence;
  const email = (val || '').trim().toLowerCase();
  const hintEl = document.getElementById('roster-match-hint');
  if (!hintEl) return;

  verifiedRosterData = null;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    hintEl.textContent = '';
    hintEl.className = 'password-match-hint';
    return;
  }

  hintEl.textContent = 'Checking college roster…';
  hintEl.className = 'password-match-hint';

  emailLookupDebounce = setTimeout(async () => {
    try {
      const students = await getRosterStudents();
      if (sequence !== registrationLookupSequence) return;
      const student = students.find(s => String(s.email || '').trim().toLowerCase() === email);

      const nameInput = document.getElementById('reg-name');
      const branchInput = document.getElementById('reg-branch');
      const sectionInput = document.getElementById('reg-section');
      const batchInput = document.getElementById('reg-batch');
      const mobileInput = document.getElementById('reg-mobile');
      const rollInput = document.getElementById('reg-roll');

      if (student) {
        verifiedRosterData = { ...student, email };
        if (nameInput && (!nameInput.value.trim() || nameInput.dataset.autofilled === 'true')) {
          nameInput.value = student.name || '';
          nameInput.dataset.autofilled = 'true';
        }
        if (branchInput && (!branchInput.value.trim() || branchInput.dataset.autofilled === 'true')) {
          branchInput.value = student.branch || '';
          branchInput.dataset.autofilled = 'true';
        }
        if (sectionInput && (!sectionInput.value.trim() || sectionInput.dataset.autofilled === 'true')) {
          sectionInput.value = student.section || '';
          sectionInput.dataset.autofilled = 'true';
        }
        if (batchInput && student.batch) {
          batchInput.value = student.batch;
        }
        if (mobileInput && student.mobile && (!mobileInput.value.trim() || mobileInput.dataset.autofilled === 'true')) {
          mobileInput.value = student.mobile;
          mobileInput.dataset.autofilled = 'true';
        }
        if (rollInput && student.rollNumber) {
          rollInput.value = student.rollNumber;
        }

        hintEl.textContent = `Verified in College Roster: ${student.name} (${student.branch || 'Branch'}${student.section ? ' - Sec ' + student.section : ''}${student.batch ? ' | ' + student.batch : ''})`;
        hintEl.className = 'password-match-hint text-success';
      } else {
        verifiedRosterData = null;
        hintEl.innerHTML = '<span style="color:#0284c7">New Student (not in pre-enrolled roster): Enter your details below to register.</span>';
        hintEl.className = 'password-match-hint';
      }
    } catch (error) {
      if (sequence !== registrationLookupSequence) return;
      verifiedRosterData = null;
      hintEl.textContent = 'Enter your academic details below to register.';
      hintEl.className = 'password-match-hint';
    }
  }, 250);
}

async function onStudentMobileRegInput(rawMobile) {
  clearTimeout(mobileLookupDebounce);
  const digits = String(rawMobile || '').replace(/[^0-9]/g, '');
  if (digits.length < 7) return;

  mobileLookupDebounce = setTimeout(async () => {
    try {
      const students = await getRosterStudents();
      const match = students.find(s => {
        const sm = String(s.mobile || '').replace(/[^0-9]/g, '');
        return sm && (sm === digits || sm.endsWith(digits) || digits.endsWith(sm));
      });
      if (!match) return;

      verifiedRosterData = { ...match };
      const nameInput = document.getElementById('reg-name');
      const emailInput = document.getElementById('reg-email');
      const branchInput = document.getElementById('reg-branch');
      const sectionInput = document.getElementById('reg-section');
      const batchInput = document.getElementById('reg-batch');

      if (nameInput && (!nameInput.value.trim() || nameInput.dataset.autofilled === 'true')) {
        nameInput.value = match.name || '';
        nameInput.dataset.autofilled = 'true';
      }
      if (emailInput && (!emailInput.value.trim() || emailInput.dataset.autofilled === 'true') && match.email) {
        emailInput.value = match.email;
        emailInput.dataset.autofilled = 'true';
      }
      if (branchInput && (!branchInput.value.trim() || branchInput.dataset.autofilled === 'true')) {
        branchInput.value = match.branch || '';
        branchInput.dataset.autofilled = 'true';
      }
      if (sectionInput && (!sectionInput.value.trim() || sectionInput.dataset.autofilled === 'true')) {
        sectionInput.value = match.section || '';
        sectionInput.dataset.autofilled = 'true';
      }
      if (batchInput && match.batch) {
        batchInput.value = match.batch;
      }
    } catch (_) {}
  }, 250);
}

function findStudentByMobile(mobile) {
  if (!mobile || !cachedRosterStudents) return null;
  const digits = String(mobile).replace(/[^0-9]/g, '');
  return cachedRosterStudents.find(s => {
    const sm = String(s.mobile || '').replace(/[^0-9]/g, '');
    return sm && (sm === digits || sm.endsWith(digits) || digits.endsWith(sm));
  });
}

function findStudentInRoster(email) {
  if (!email || !cachedRosterStudents) return null;
  const clean = String(email).trim().toLowerCase();
  return cachedRosterStudents.find(s => String(s.email || '').trim().toLowerCase() === clean);
}

// Backward-compatible alias for any legacy callers
const onStudentRollRegInput = onStudentEmailRegInput;

// ---- Register Student ----
async function registerStudent() {
  const nameInput = document.getElementById('reg-name');
  const emailInput = document.getElementById('reg-email');
  const passwordInput = document.getElementById('reg-password');
  const password = passwordInput ? passwordInput.value : '';
  const confirmPassword = document.getElementById('reg-confirm-password')?.value || password;
  const personalEmail = emailInput ? emailInput.value.trim().toLowerCase() : '';
  const name = nameInput ? nameInput.value.trim() : '';
  const branch = document.getElementById('reg-branch')?.value.trim() || '';
  const section = document.getElementById('reg-section')?.value.trim() || '';
  const batch = document.getElementById('reg-batch')?.value.trim() || 'BATCH - 1';
  const mobileInput = document.getElementById('reg-mobile');
  const mobile = mobileInput ? mobileInput.value.trim().replace(/[^0-9]/g, '') : '';
  const rollInput = document.getElementById('reg-roll');
  const roll = rollInput ? rollInput.value.trim() : '';

  if (!personalEmail || !password || !name || !branch) {
    return showRegError('Please fill in all required fields (Full Name, Personal Email ID, Branch, Batch, and Password).');
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(personalEmail)) {
    return showRegError('Enter a valid personal email address.');
  }
  if (password.length < 6) {
    return showRegError('Password must be at least 6 characters long.');
  }
  if (password !== confirmPassword) {
    return showRegError('Passwords do not match.');
  }

  setLoading('reg-btn', true);
  let cred = null;
  try {
    const students = await getRosterStudents();
    const rosterMatch = students.find(s => String(s.email || '').trim().toLowerCase() === personalEmail) || verifiedRosterData;

    cred = await auth.createUserWithEmailAndPassword(personalEmail, password);

    const studentName = rosterMatch?.name || name;
    try {
      await cred.user.updateProfile({ displayName: studentName });
    } catch (_) {}

    try {
      await cred.user.sendEmailVerification();
    } catch (verifErr) {
      console.warn('Could not send verification email:', verifErr);
    }

    const rollNumber = rosterMatch?.rollNumber || roll || '';
    const studentData = {
      name: studentName,
      college: rosterMatch?.college || 'AVN',
      branch: rosterMatch?.branch || branch,
      section: rosterMatch?.section || section || 'No Section',
      rollNumber: rollNumber,
      studentId: rollNumber,
      mobile: rosterMatch?.mobile || mobile || '',
      email: personalEmail,
      personalEmail: personalEmail,
      role: 'student',
      batch: rosterMatch?.batch || batch || 'BATCH - 1',
      status: 'active',
      createdAt: firebase.firestore.FieldValue.serverTimestamp()
    };

    await db.collection('users').doc(cred.user.uid).set(studentData);

    if (!rosterMatch) {
      try {
        await db.collection('settings').doc('student_roster').set({
          students: firebase.firestore.FieldValue.arrayUnion({
            name: studentData.name,
            email: personalEmail,
            mobile: studentData.mobile,
            branch: studentData.branch,
            section: studentData.section,
            batch: studentData.batch,
            rollNumber: rollNumber,
            college: 'AVN',
            status: 'verified',
            sourceSheet: 'Self-Registered'
          })
        }, { merge: true });
      } catch (rErr) {
        console.warn('Auto-add to roster notice:', rErr);
      }
    }

    localStorage.setItem(`user_profile_${cred.user.uid}`, JSON.stringify(studentData));
    closeStudentRegister();
    showToast('Account created successfully! Welcome to AttendX.', 'success');
    window.location.href = 'student.html';
  } catch (error) {
    console.error('Registration failed:', error);
    if (cred && cred.user) {
      try {
        await cred.user.delete();
      } catch (delErr) {
        console.warn('Could not roll back unactivated user account:', delErr);
      }
    }
    showRegError(getFriendlyRegError(error.code, error));
  } finally {
    setLoading('reg-btn', false);
  }
}// ---- Open & Close Trainer Registration Modal ----
function openTrainerRegister() {
  const modal = document.getElementById('trainer-register-modal');
  if (modal) {
    modal.classList.add('show');
    const errEl = document.getElementById('trainer-register-error');
    if (errEl) {
      errEl.textContent = '';
      errEl.classList.remove('show');
    }
    const nameEl = document.getElementById('trainer-reg-name');
    if (nameEl) setTimeout(() => nameEl.focus(), 100);
  }
}

function closeTrainerRegister() {
  const modal = document.getElementById('trainer-register-modal');
  if (modal) modal.classList.remove('show');
  
  ['trainer-reg-name', 'trainer-reg-dept', 'trainer-reg-email', 'trainer-reg-password', 'trainer-reg-confirm-password'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = '';
  });
  
  const errEl = document.getElementById('trainer-register-error');
  if (errEl) {
    errEl.textContent = '';
    errEl.classList.remove('show');
  }
  const matchEl = document.getElementById('trainer-password-match-indicator');
  if (matchEl) {
    matchEl.innerHTML = '';
    matchEl.className = 'password-match-hint';
  }
}

function checkTrainerRegPasswordMatch() {
  const passEl = document.getElementById('trainer-reg-password');
  const confirmEl = document.getElementById('trainer-reg-confirm-password');
  const indicator = document.getElementById('trainer-password-match-indicator');
  if (!passEl || !confirmEl || !indicator) return;

  const p1 = passEl.value;
  const p2 = confirmEl.value;

  if (!p2) {
    indicator.innerHTML = '';
    indicator.className = 'password-match-hint';
    return;
  }

  if (p1 === p2 && p1.length >= 6) {
    indicator.className = 'password-match-hint text-success';
    indicator.innerHTML = '<svg class="icon-svg" viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"/></svg><span>Passwords match</span>';
  } else if (p1 !== p2) {
    indicator.className = 'password-match-hint text-warn';
    indicator.innerHTML = '<svg class="icon-svg" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg><span>Passwords do not match yet</span>';
  } else {
    indicator.innerHTML = '';
    indicator.className = 'password-match-hint';
  }
}

async function registerTrainer() {
  const name = document.getElementById('trainer-reg-name').value.trim();
  const department = document.getElementById('trainer-reg-dept') ? document.getElementById('trainer-reg-dept').value.trim() : '';
  const email = document.getElementById('trainer-reg-email').value.trim().toLowerCase();
  const password = document.getElementById('trainer-reg-password').value;
  const confirmPassword = document.getElementById('trainer-reg-confirm-password') ? document.getElementById('trainer-reg-confirm-password').value : password;
  const errEl = document.getElementById('trainer-register-error');

  const showTrainerErr = (msg) => {
    if (errEl) {
      errEl.textContent = msg;
      errEl.classList.add('show');
    }
  };

  if (!name || !email || !password) {
    return showTrainerErr('Please fill in all required fields (Full Name, Trainer Email, and Password).');
  }

  if (password.length < 6) {
    return showTrainerErr('Password must be at least 6 characters long.');
  }

  if (confirmPassword && password !== confirmPassword) {
    return showTrainerErr('Passwords do not match. Please verify your password.');
  }

  setLoading('trainer-reg-btn', true);
  let cred = null;
  try {
    cred = await auth.createUserWithEmailAndPassword(email, password);
    
    if (cred.user && cred.user.updateProfile) {
      try {
        await cred.user.updateProfile({ displayName: name });
      } catch (_) {}
    }

    const trainerData = {
      name,
      email,
      department: department || 'General',
      role: 'trainer',
      status: 'pending',
      createdAt: firebase.firestore.FieldValue.serverTimestamp()
    };

    await db.collection('users').doc(cred.user.uid).set(trainerData);

    // Immediately sign out so pending trainer is not authenticated
    await auth.signOut();
    localStorage.removeItem(`user_profile_${cred.user.uid}`);

    closeTrainerRegister();
    showToast('Registration submitted! Awaiting administrator approval.', 'info');
    showError('Trainer registration submitted. Your account is pending administrator approval before you can sign in.');
  } catch (e) {
    console.error('Trainer registration failed:', e);
    if (cred && cred.user) {
      try {
        await cred.user.delete();
      } catch (delErr) {
        console.warn('Could not roll back trainer auth user:', delErr);
      }
    }
    showTrainerErr(getFriendlyRegError(e.code, e));
  } finally {
    setLoading('trainer-reg-btn', false);
  }
}

// ---- Admin Login (used on /admin) ----
async function loginAdmin() {
  const emailInput = document.getElementById('admin-email');
  const passInput  = document.getElementById('admin-password');
  
  if (!emailInput || !passInput) return;
  
  const email = emailInput.value.trim();
  const password = passInput.value;

  if (!email || !password) return showError('Please fill in all fields.');

  setLoading('admin-login-btn', true);
  try {
    const cred = await auth.signInWithEmailAndPassword(email, password);
    const doc  = await db.collection('users').doc(cred.user.uid).get();
    
    if (!doc.exists || doc.data().role !== 'admin') {
      await auth.signOut();
      showError('This account does not have administrator access.');
      return;
    }
    
    // Switch or refresh admin page
    if (typeof onAdminLoginSuccess === 'function') {
      onAdminLoginSuccess(doc.data(), cred.user);
    } else {
      window.location.reload();
    }
  } catch (e) {
    showError(getFriendlyError(e.code));
  } finally {
    setLoading('admin-login-btn', false);
  }
}


// ---- Trainer Login (used on index.html) ----
async function loginTrainer() {
  const emailInput = document.getElementById('trainer-email');
  const passInput  = document.getElementById('trainer-password');
  if (!emailInput || !passInput) return;

  const email = emailInput.value.trim();
  const password = passInput.value;

  if (!email || !password) return showError('Please fill in both email and password.');

  setLoading('trainer-login-btn', true);
  try {
    const cred = await auth.signInWithEmailAndPassword(email, password);
    const doc  = await db.collection('users').doc(cred.user.uid).get();

    if (!doc.exists || (doc.data().role !== 'trainer' && doc.data().role !== 'admin')) {
      await auth.signOut();
      showError('This account does not have trainer or instructor access.');
      return;
    }

    const userData = doc.data();
    // Strictly block pending or unapproved trainers
    if (userData.role === 'trainer' && userData.status !== 'approved') {
      await auth.signOut();
      showError('Your trainer account is awaiting administrator approval. Please contact the administrator.');
      return;
    }

    window.location.href = 'admin.html';
  } catch (e) {
    showError(getFriendlyError(e.code));
  } finally {
    setLoading('trainer-login-btn', false);
  }
}

// ---- Overall Admin Login (used on index.html) ----
async function loginOverallAdmin() {
  const emailInput = document.getElementById('overall-admin-email');
  const passInput  = document.getElementById('overall-admin-password');
  if (!emailInput || !passInput) return;

  const email = emailInput.value.trim();
  const password = passInput.value;

  if (!email || !password) return showError('Please fill in both email and password.');

  setLoading('overall-admin-login-btn', true);
  try {
    const cred = await auth.signInWithEmailAndPassword(email, password);
    const doc  = await db.collection('users').doc(cred.user.uid).get();

    if (!doc.exists || doc.data().role !== 'admin') {
      await auth.signOut();
      showError('This account does not have overall administrator access.');
      return;
    }

    window.location.href = 'admin.html';
  } catch (e) {
    showError(getFriendlyError(e.code));
  } finally {
    setLoading('overall-admin-login-btn', false);
  }
}

// ---- Forgot Password Handler ----
async function handleForgotPassword(role) {
  if (role === 'student') {
    const roll = document.getElementById('student-roll')?.value.trim();
    if (!roll) {
      showToast('Please enter your Roll Number in the input field first.', 'info');
      document.getElementById('student-roll')?.focus();
      return;
    }
    try {
      const authEmail = roll.includes('@') ? roll.toLowerCase() : `${roll.toLowerCase()}@attendx.local`;
      await auth.sendPasswordResetEmail(authEmail);
      showToast('Password reset link sent to registered email!', 'success');
    } catch (e) {
      showToast('If registered, a reset link was sent. Otherwise please contact administration.', 'info');
    }
  } else {
    const emailInput = role === 'trainer' ? document.getElementById('trainer-email') : document.getElementById('overall-admin-email');
    const email = emailInput?.value.trim();
    if (!email) {
      showToast('Please enter your email address first.', 'info');
      emailInput?.focus();
      return;
    }
    try {
      await auth.sendPasswordResetEmail(email);
      showToast(`Password reset link sent to ${email}!`, 'success');
    } catch (e) {
      showToast(getFriendlyError(e.code), 'error');
    }
  }
}

// ---- UI Helpers ----
function showError(msg) {
  const el = document.getElementById('error-msg');
  if (!el) return;
  el.textContent = msg;
  el.classList.add('show');
}

function hideError() {
  const el = document.getElementById('error-msg');
  if (el) el.classList.remove('show');
}

function showRegError(msg) {
  const el = document.getElementById('register-error') || document.getElementById('admin-reg-error');
  if (!el) return;
  el.textContent = msg;
  el.classList.add('show');
}

function setLoading(btnId, loading) {
  const btn = document.getElementById(btnId);
  if (!btn) return;
  btn.disabled = loading;
  if (!btn.dataset.originalHtml) {
    btn.dataset.originalHtml = btn.innerHTML;
  }
  btn.innerHTML = loading
    ? '<span class="spinner"></span> Please wait...'
    : btn.dataset.originalHtml;
}

function getFriendlyError(code) {
  const map = {
    'auth/user-not-found'      : 'No account found with this email. If you are new, click "Create account" below.',
    'auth/wrong-password'      : 'Incorrect password. Please verify and try again.',
    'auth/email-already-in-use': 'This email is already registered. Please sign in.',
    'auth/invalid-email'       : 'Invalid email address format.',
    'auth/weak-password'       : 'Password must be at least 6 characters.',
    'auth/too-many-requests'   : 'Too many attempts. Please wait a moment and try again.',
    'auth/invalid-credential'  : 'Invalid Email or Password. If you haven\'t created an account yet, click "Create account" below.',
    'permission-denied'        : 'Database permission restricted. Please check Cloud Firestore rules in Firebase Console.',
    'auth/network-request-failed': 'Network connection issue. Please check your internet connection.',
  };
  return map[code] || 'Authentication error. Please check your credentials and try again.';
}

function getFriendlyRegError(code, err) {
  const map = {
    'auth/email-already-in-use': 'This Email ID is already registered. Please sign in instead.',
    'auth/weak-password'       : 'Password must be at least 6 characters long.',
    'auth/invalid-email'       : 'Invalid email address format.',
    'auth/operation-not-allowed': 'Registration is currently disabled in Firebase Auth. Please contact administrator.',
    'auth/network-request-failed': 'Network connection issue. Please check your internet connection.',
    'permission-denied'        : 'Account created, but database profile setup was restricted by permissions. Please contact admin.',
    'internal'                 : 'Could not connect to registration service. Please verify details and try again.',
    'functions/internal'       : 'Registration service encountered an error. Please try again.',
  };
  return map[code] || (err && err.message && err.message !== 'internal' ? err.message : 'Failed to create account. Please try again.');
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

// ---- Password Visibility Toggle ----
function togglePasswordVisibility(inputId, btn) {
  const input = document.getElementById(inputId);
  if (!input) return;

  const isPassword = input.type === 'password';
  input.type = isPassword ? 'text' : 'password';

  const eyeIcon = `<svg class="icon-svg" viewBox="0 0 24 24"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>`;
  const eyeOffIcon = `<svg class="icon-svg" viewBox="0 0 24 24"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>`;

  if (btn) {
    btn.innerHTML = isPassword ? eyeOffIcon : eyeIcon;
    btn.setAttribute('aria-label', isPassword ? 'Hide password' : 'Show password');
    btn.setAttribute('title', isPassword ? 'Hide password' : 'Show password');
  }
}





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

// ---- Student Login (with Roll Number) ----
async function loginStudent() {
  const rollInput = document.getElementById('student-roll');
  const passInput = document.getElementById('student-password');
  
  if (!rollInput || !passInput) return;
  
  const roll = rollInput.value.trim();
  const password = passInput.value;

  if (!roll || !password) {
    return showError('Please enter both your Roll Number and Password.');
  }

  setLoading('student-login-btn', true);
  try {
    let authEmail;
    
    if (roll.includes('@')) {
      authEmail = roll.toLowerCase();
    } else {
      // Direct standard roll number email mapping
      authEmail = `${roll.toLowerCase()}@attendx.local`;
    }

    let cred;
    try {
      cred = await auth.signInWithEmailAndPassword(authEmail, password);
    } catch (authErr) {
      // Fallback: If not found and user typed roll without @, search Firestore for custom email
      if ((authErr.code === 'auth/user-not-found' || authErr.code === 'auth/invalid-credential') && !roll.includes('@')) {
        try {
          const snap = await db.collection('users')
            .where('studentId', '==', roll.toUpperCase())
            .limit(1)
            .get();
            
          if (!snap.empty) {
            const userDoc = snap.docs[0].data();
            if (userDoc.email) {
              cred = await auth.signInWithEmailAndPassword(userDoc.email, password);
            } else {
              throw authErr;
            }
          } else {
            throw authErr;
          }
        } catch (dbErr) {
          // If Firestore read fails (e.g. security rules require auth), preserve authErr
          throw authErr;
        }
      } else {
        throw authErr;
      }
    }

    let userRole = 'student';
    try {
      const doc = await db.collection('users').doc(cred.user.uid).get();
      if (doc.exists) {
        userRole = doc.data().role;
      }
    } catch (fsErr) {
      console.warn('Firestore doc read restricted, using local profile or role student:', fsErr);
      const cached = localStorage.getItem(`user_profile_${cred.user.uid}`);
      if (cached) {
        try { userRole = JSON.parse(cached).role || 'student'; } catch (_) {}
      }
    }

    if (userRole !== 'student') {
      await auth.signOut();
      showError('This account is not a student account.');
      return;
    }

    // Require email verification for personal emails (exempting local mock @attendx.local)
    const isLocalMock = cred.user.email && cred.user.email.endsWith('@attendx.local');
    if (!isLocalMock && !cred.user.emailVerified) {
      await auth.signOut();
      showError(`Please verify your personal email address (${cred.user.email}) before signing in. Check your inbox for the verification link.`);
      return;
    }

    window.location.href = 'student.html';
  } catch (e) {
    showError(getFriendlyError(e.code));
  } finally {
    setLoading('student-login-btn', false);
  }
}

// ---- Open & Close Student Registration Modal ----
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
  
  const fields = ['reg-name', 'reg-email', 'reg-branch', 'reg-section', 'reg-password', 'reg-confirm-password'];
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

// ---- Student Roster Auto-Check & Pre-population by Personal Email ----
let emailLookupDebounce = null;
let verifiedRosterData = null;

async function onStudentEmailRegInput(val) {
  clearTimeout(emailLookupDebounce);
  const email = (val || '').trim().toLowerCase();
  const hintEl = document.getElementById('roster-match-hint');
  if (!hintEl) return;

  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!email || !emailRegex.test(email)) {
    hintEl.innerHTML = '';
    hintEl.className = 'password-match-hint';
    verifiedRosterData = null;
    return;
  }

  emailLookupDebounce = setTimeout(async () => {
    try {
      if (typeof firebase !== 'undefined' && firebase.functions) {
        hintEl.className = 'password-match-hint';
        hintEl.innerHTML = '<span style="color:#64748b">Verifying email with college roster...</span>';

        const verifyFn = firebase.functions().httpsCallable('verifyStudentRegistration');
        const res = await verifyFn({ email: email });
        const data = res.data;

        if (data && data.verified && data.student) {
          verifiedRosterData = { ...data.student, email };
          const nameInput = document.getElementById('reg-name');
          const branchInput = document.getElementById('reg-branch');
          const sectionInput = document.getElementById('reg-section');

          if (nameInput && (!nameInput.value.trim() || nameInput.dataset.autofilled === 'true')) {
            nameInput.value = data.student.name || '';
            nameInput.dataset.autofilled = 'true';
          }
          if (branchInput) {
            branchInput.value = data.student.branch || '';
            branchInput.dataset.autofilled = 'true';
          }
          if (sectionInput) {
            sectionInput.value = data.student.section || '';
            sectionInput.dataset.autofilled = 'true';
          }

          hintEl.className = 'password-match-hint text-success';
          hintEl.innerHTML = `<svg class="icon-svg" viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"/></svg><span>Verified roster: <strong>${data.student.name}</strong> (${data.student.branch || 'Branch'}${data.student.section ? ' - Sec ' + data.student.section : ''})</span>`;
        } else {
          verifiedRosterData = null;
          hintEl.className = 'password-match-hint';
          hintEl.innerHTML = `<span style="color:#64748b">${data?.message || 'Manual registration allowed.'}</span>`;
        }
      }
    } catch (e) {
      console.warn('Roster email verification response:', e);
      verifiedRosterData = null;
      hintEl.className = 'password-match-hint text-danger';
      const errMsg = e.message || '';
      if (errMsg.includes('already been registered') || errMsg.includes('already-exists')) {
        hintEl.innerHTML = `<span style="color:#ef4444">This email has already been registered. Please sign in instead.</span>`;
      } else if (errMsg.includes('not found') || errMsg.includes('not-found')) {
        hintEl.innerHTML = `<span style="color:#ef4444">Email is not registered in the official college roster.</span>`;
      } else {
        hintEl.innerHTML = `<span style="color:#ef4444">${errMsg || 'Verification failed.'}</span>`;
      }
    }
  }, 400);
}

// Backward-compatible alias for any legacy callers
const onStudentRollRegInput = onStudentEmailRegInput;

// ---- Register Student ----
async function registerStudent() {
  const name = document.getElementById('reg-name').value.trim();
  const emailInput = document.getElementById('reg-email');
  const personalEmail = emailInput ? emailInput.value.trim().toLowerCase() : '';
  const branch = document.getElementById('reg-branch') ? document.getElementById('reg-branch').value.trim() : '';
  const section = document.getElementById('reg-section') ? document.getElementById('reg-section').value.trim() : '';
  const password = document.getElementById('reg-password').value;
  const confirmPassword = document.getElementById('reg-confirm-password') ? document.getElementById('reg-confirm-password').value : password;

  if (!name || !personalEmail || !branch || !password) {
    return showRegError('Please fill in all required fields (Full Name, Personal Email ID, Branch, and Password).');
  }

  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(personalEmail)) {
    return showRegError('Please enter a valid personal email address.');
  }

  if (password.length < 6) {
    return showRegError('Password must be at least 6 characters long.');
  }

  if (confirmPassword && password !== confirmPassword) {
    return showRegError('Passwords do not match. Please verify your password.');
  }

  setLoading('reg-btn', true);
  try {
    let academicData = verifiedRosterData;
    // Verify against trusted backend if not already verified or if email was edited
    if (typeof firebase !== 'undefined' && firebase.functions) {
      if (!academicData || academicData.email !== personalEmail) {
        try {
          const verifyFn = firebase.functions().httpsCallable('verifyStudentRegistration');
          const res = await verifyFn({ email: personalEmail });
          if (res.data && res.data.verified && res.data.student) {
            academicData = { ...res.data.student, email: personalEmail };
            verifiedRosterData = academicData;
          }
        } catch (verifyErr) {
          setLoading('reg-btn', false);
          const errMsg = verifyErr.message || 'Email verification failed against college roster.';
          return showRegError(errMsg);
        }
      }
    }

    // 1. Create account in Firebase Authentication using personal email
    const cred = await auth.createUserWithEmailAndPassword(personalEmail, password);
    
    if (cred.user && cred.user.updateProfile) {
      try {
        await cred.user.updateProfile({ displayName: academicData?.name || name });
      } catch (_) {}
    }

    // 2. Require Email Verification: send verification link to personal email
    try {
      await cred.user.sendEmailVerification();
    } catch (verifErr) {
      console.warn('Could not send verification email:', verifErr);
    }

    // 3. Build student profile strictly from verified roster (academic details cannot be forged)
    const rollNumber = academicData?.rollNumber || '';
    const studentData = {
      name: academicData?.name || name,
      college: academicData?.college || 'College',
      branch: academicData?.branch || branch,
      section: academicData?.section || section || '',
      rollNumber: rollNumber,
      studentId: rollNumber,
      email: personalEmail,
      personalEmail: personalEmail,
      role: 'student',
      batch: academicData?.batch || '',
      emailVerified: false,
      createdAt: firebase.firestore.FieldValue.serverTimestamp()
    };

    // Save profile to Firestore
    try {
      await db.collection('users').doc(cred.user.uid).set(studentData);
    } catch (fsErr) {
      console.warn('Firestore user doc write was restricted by security rules:', fsErr);
    }

    // Store student profile locally for offline/rule resilience
    localStorage.setItem(`user_profile_${cred.user.uid}`, JSON.stringify(studentData));

    // 4. Sign out immediately so unverified student cannot access dashboard until email is confirmed
    await auth.signOut();

    closeStudentRegister();
    showToast(`Account created! A verification link has been sent to ${personalEmail}. Please verify before logging in.`, 'success');
  } catch (e) {
    console.error('Registration failed:', e);
    showRegError(getFriendlyRegError(e.code, e));
  } finally {
    setLoading('reg-btn', false);
  }
}

// ---- Open & Close Trainer Registration Modal ----
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
  try {
    const cred = await auth.createUserWithEmailAndPassword(email, password);
    
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

    try {
      await db.collection('users').doc(cred.user.uid).set(trainerData);
    } catch (fsErr) {
      console.warn('Firestore trainer write restricted by security rules:', fsErr);
    }

    // Immediately sign out so pending trainer is not authenticated
    await auth.signOut();
    localStorage.removeItem(`user_profile_${cred.user.uid}`);

    closeTrainerRegister();
    showToast('Registration submitted! Awaiting administrator approval.', 'info');
    showError('Trainer registration submitted. Your account is pending administrator approval before you can sign in.');
  } catch (e) {
    console.error('Trainer registration failed:', e);
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
    'auth/user-not-found'      : 'No account found with this Roll Number. If you are new, click "Create account" below.',
    'auth/wrong-password'      : 'Incorrect password. Please verify and try again.',
    'auth/email-already-in-use': 'This Roll Number is already registered. Please sign in.',
    'auth/invalid-email'       : 'Invalid roll number format.',
    'auth/weak-password'       : 'Password must be at least 6 characters.',
    'auth/too-many-requests'   : 'Too many attempts. Please wait a moment and try again.',
    'auth/invalid-credential'  : 'Invalid Roll Number or Password. If you haven\'t created an account yet, click "Create account" below.',
    'permission-denied'        : 'Database permission restricted. Please check Cloud Firestore rules in Firebase Console.',
    'auth/network-request-failed': 'Network connection issue. Please check your internet connection.',
  };
  return map[code] || 'Authentication error. Please check your credentials and try again.';
}

function getFriendlyRegError(code, err) {
  const map = {
    'auth/email-already-in-use': 'This Roll Number is already registered. Please sign in.',
    'auth/weak-password'       : 'Password must be at least 6 characters long.',
    'auth/invalid-email'       : 'Invalid Roll Number format.',
    'auth/operation-not-allowed': 'Registration is currently disabled in Firebase Auth. Please contact administrator.',
    'auth/network-request-failed': 'Network connection issue. Please check your internet connection.',
    'permission-denied'        : 'Account created, but database profile setup was restricted by permissions. Please contact admin.',
  };
  return map[code] || (err && err.message ? err.message : 'Failed to create account. Please try again.');
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


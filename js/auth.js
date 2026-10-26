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

// ---- Student Login (supports Full Name, Phone Number, or Email) ----
async function loginStudent() {
  const inputEl = document.getElementById('student-identifier') || document.getElementById('student-roll');
  const passInput = document.getElementById('student-password');
  
  if (!inputEl || !passInput) return;
  
  const identifier = inputEl.value.trim();
  const password = passInput.value;

  if (!identifier || !password) {
    return showError('Please enter your Phone Number, Full Name, or Email, and your Password.');
  }

  setLoading('student-login-btn', true);
  try {
    let authEmail = null;
    
    // 1. Direct email format
    if (identifier.includes('@')) {
      authEmail = identifier.toLowerCase();
    } else {
      const cleanDigits = identifier.replace(/[^0-9]/g, '');
      const cleanText = identifier.toLowerCase().replace(/\s+/g, ' ');
      const rosterList = getMergedRosterStudents();

      // 2. Local Roster & LocalStorage Phone Match
      if (cleanDigits.length >= 7) {
        const phoneMatch = rosterList.find(s => {
          const m = String(s.mobile || '').replace(/[^0-9]/g, '');
          return m && (m === cleanDigits || m.endsWith(cleanDigits) || cleanDigits.endsWith(m));
        });
        if (phoneMatch && phoneMatch.email) {
          authEmail = phoneMatch.email;
        }
      }

      // 3. Local Roster & LocalStorage Name Match
      if (!authEmail && cleanText.length >= 2) {
        const nameMatch = rosterList.find(s => {
          const n = String(s.name || '').toLowerCase().replace(/\s+/g, ' ');
          return n && (n === cleanText || n.includes(cleanText) || cleanText.includes(n));
        });
        if (nameMatch && nameMatch.email) {
          authEmail = nameMatch.email;
        }
      }

      // 4. Firestore Cloud Lookup (for newly registered students not in static bundle)
      if (!authEmail) {
        try {
          // 4a. Mobile lookup in Firestore 'users'
          if (cleanDigits.length >= 7) {
            let pSnap = await db.collection('users').where('mobile', '==', cleanDigits).limit(1).get();
            if (pSnap.empty && cleanDigits.length > 10) {
              pSnap = await db.collection('users').where('mobile', '==', cleanDigits.slice(-10)).limit(1).get();
            }
            if (pSnap.empty && cleanDigits.length === 10) {
              pSnap = await db.collection('users').where('mobile', '==', '91' + cleanDigits).limit(1).get();
            }
            if (!pSnap.empty && pSnap.docs[0].data()?.email) {
              authEmail = pSnap.docs[0].data().email;
            }
          }

          // 4b. Name lookup in Firestore 'users'
          if (!authEmail && cleanText.length >= 2) {
            let nSnap = await db.collection('users').where('name', '==', identifier).limit(1).get();
            if (nSnap.empty) {
              const allStudentsSnap = await db.collection('users').where('role', '==', 'student').limit(50).get();
              allStudentsSnap.forEach(d => {
                if (authEmail) return;
                const dData = d.data();
                const dName = String(dData.name || '').toLowerCase().replace(/\s+/g, ' ');
                if (dName && (dName === cleanText || dName.includes(cleanText) || cleanText.includes(dName))) {
                  authEmail = dData.email;
                }
              });
            } else if (nSnap.docs[0].data()?.email) {
              authEmail = nSnap.docs[0].data().email;
            }
          }

          // 4c. Cloud Master Roster document lookup
          if (!authEmail) {
            const rosterDoc = await db.collection('settings').doc('student_roster').get();
            if (rosterDoc.exists) {
              const cloudStudents = rosterDoc.data().students || [];
              if (cleanDigits.length >= 7) {
                const cloudPhoneMatch = cloudStudents.find(s => {
                  const m = String(s.mobile || '').replace(/[^0-9]/g, '');
                  return m && (m === cleanDigits || m.endsWith(cleanDigits) || cleanDigits.endsWith(m));
                });
                if (cloudPhoneMatch && cloudPhoneMatch.email) {
                  authEmail = cloudPhoneMatch.email;
                }
              }
              if (!authEmail && cleanText.length >= 2) {
                const cloudNameMatch = cloudStudents.find(s => {
                  const n = String(s.name || '').toLowerCase().replace(/\s+/g, ' ');
                  return n && (n === cleanText || n.includes(cleanText) || cleanText.includes(n));
                });
                if (cloudNameMatch && cloudNameMatch.email) {
                  authEmail = cloudNameMatch.email;
                }
              }
            }
          }
        } catch (fsErr) {
          console.warn('Firestore directory lookup notice:', fsErr);
        }
      }

      // 5. If STILL not found:
      if (!authEmail) {
        if (/^[a-zA-Z0-9_-]+$/.test(identifier) && cleanDigits.length < 7) {
          authEmail = `${identifier.toLowerCase()}@attendx.local`;
        } else {
          return showError(`Could not find an account matching "${identifier}". Please check your spelling, or sign in using your registered Email address.`);
        }
      }
    }

    let cred;
    try {
      cred = await auth.signInWithEmailAndPassword(authEmail, password);
    } catch (authErr) {
      if (authErr.code === 'auth/user-not-found') {
        throw new Error(`No account found for "${authEmail}". If you haven't registered yet, please click "Create account".`);
      } else if (authErr.code === 'auth/wrong-password' || authErr.code === 'auth/invalid-credential') {
        throw new Error('Incorrect password. Please verify your password and try again.');
      }
      throw authErr;
    }

    let userRole = 'student';
    try {
      const doc = await db.collection('users').doc(cred.user.uid).get();
      if (doc.exists) {
        userRole = doc.data().role || 'student';
      } else {
        const newProfile = {
          name: cred.user.displayName || identifier,
          email: cred.user.email,
          role: 'student',
          status: 'active',
          updatedAt: firebase.firestore.FieldValue.serverTimestamp()
        };
        await db.collection('users').doc(cred.user.uid).set(newProfile, { merge: true });
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

    // Best-effort notice for unverified personal email without blocking access
    const isLocalMock = cred.user.email && cred.user.email.endsWith('@attendx.local');
    if (!isLocalMock && !cred.user.emailVerified) {
      console.log('Notice: Email verification link was sent to', cred.user.email);
    }

    window.location.href = 'student.html';
  } catch (e) {
    showError(e.message || getFriendlyError(e.code));
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

// ---- Student Roster Auto-Check & Pre-population by Personal Email ----
let emailLookupDebounce = null;
let verifiedRosterData = null;

async function onStudentEmailRegInput(val) {
  clearTimeout(emailLookupDebounce);
  const email = (val || '').trim().toLowerCase();
  const hintEl = document.getElementById('roster-match-hint');
  if (!hintEl) return;

  clearTimeout(emailLookupDebounce);

  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!email || !emailRegex.test(email)) {
    hintEl.innerHTML = '';
    hintEl.className = 'password-match-hint';
    verifiedRosterData = null;
    return;
  }

  emailLookupDebounce = setTimeout(() => {
    // 1. Instant client-side lookup from converted JSON roster
    const match = findStudentInRoster(email);

    const nameInput = document.getElementById('reg-name');
    const branchInput = document.getElementById('reg-branch');
    const sectionInput = document.getElementById('reg-section');
    const batchInput = document.getElementById('reg-batch');
    const rollInput = document.getElementById('reg-roll');

    if (match) {
      verifiedRosterData = { ...match, email };

      if (nameInput && (!nameInput.value.trim() || nameInput.dataset.autofilled === 'true')) {
        nameInput.value = match.name || '';
        nameInput.dataset.autofilled = 'true';
      }
      if (branchInput) {
        branchInput.value = match.branch || '';
        branchInput.dataset.autofilled = 'true';
      }
      if (sectionInput) {
        sectionInput.value = match.section || '';
        sectionInput.dataset.autofilled = 'true';
      }
      const mobileInput = document.getElementById('reg-mobile');
      if (mobileInput && match.mobile) {
        mobileInput.value = match.mobile;
        mobileInput.dataset.autofilled = 'true';
      }
      if (batchInput && match.batch) {
        batchInput.value = match.batch;
      }
      if (rollInput && match.rollNumber) {
        rollInput.value = match.rollNumber;
      }

      hintEl.className = 'password-match-hint text-success';
      hintEl.innerHTML = `<svg class="icon-svg" viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"/></svg><span>Verified in College Roster: <strong>${match.name}</strong> (${match.branch || 'Branch'}${match.section ? ' - Sec ' + match.section : ''}${match.batch ? ' | ' + match.batch : ''})</span>`;
    } else {
      // Student is NOT present in Excel sheet -> DO NOT BLOCK! Allow manual entry smoothly
      verifiedRosterData = null;
      hintEl.className = 'password-match-hint';
      hintEl.innerHTML = `<span style="color:#0284c7"><svg class="icon-svg" viewBox="0 0 24 24" style="width:14px;height:14px;vertical-align:-2px"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg> New Student (Not in pre-enrolled sheet): Enter your details below to register.</span>`;
    }
  }, 250);
}

// Auto-lookup by Phone / Mobile Number
let mobileLookupDebounce = null;
function onStudentMobileRegInput(rawMobile) {
  clearTimeout(mobileLookupDebounce);
  const digits = String(rawMobile || '').replace(/[^0-9]/g, '');
  if (digits.length < 7) return;

  mobileLookupDebounce = setTimeout(() => {
    const match = findStudentByMobile(digits);
    const hintEl = document.getElementById('student-reg-email-hint');
    if (!match) return;

    const nameInput = document.getElementById('reg-name');
    const emailInput = document.getElementById('reg-email');
    const branchInput = document.getElementById('reg-branch');
    const sectionInput = document.getElementById('reg-section');
    const batchInput = document.getElementById('reg-batch');

    verifiedRosterData = { ...match };

    if (nameInput && (!nameInput.value.trim() || nameInput.dataset.autofilled === 'true')) {
      nameInput.value = match.name || '';
      nameInput.dataset.autofilled = 'true';
    }
    if (emailInput && (!emailInput.value.trim() || emailInput.dataset.autofilled === 'true') && match.email) {
      emailInput.value = match.email;
      emailInput.dataset.autofilled = 'true';
    }
    if (branchInput) {
      branchInput.value = match.branch || '';
      branchInput.dataset.autofilled = 'true';
    }
    if (sectionInput) {
      sectionInput.value = match.section || '';
      sectionInput.dataset.autofilled = 'true';
    }
    if (batchInput && match.batch) {
      batchInput.value = match.batch;
    }

    if (hintEl) {
      hintEl.className = 'password-match-hint text-success';
      hintEl.innerHTML = `<svg class="icon-svg" viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"/></svg><span>Verified in College Roster by Phone: <strong>${match.name}</strong> (${match.branch || 'Branch'}${match.section ? ' - Sec ' + match.section : ''}${match.batch ? ' | ' + match.batch : ''})</span>`;
    }
  }, 250);
}

function findStudentByMobile(mobile) {
  if (!mobile) return null;
  const digits = String(mobile).replace(/[^0-9]/g, '');
  if (digits.length < 7) return null;
  if (typeof window !== 'undefined' && window.ATTENDX_ROSTER && Array.isArray(window.ATTENDX_ROSTER.students)) {
    return window.ATTENDX_ROSTER.students.find(s => {
      const sm = String(s.mobile || '').replace(/[^0-9]/g, '');
      return sm && (sm === digits || sm.endsWith(digits) || digits.endsWith(sm));
    });
  }
  return null;
}

// Helper to find student in converted JSON roster
function findStudentInRoster(email) {
  if (!email) return null;
  const clean = String(email).trim().toLowerCase();
  if (typeof window !== 'undefined' && window.ATTENDX_ROSTER && Array.isArray(window.ATTENDX_ROSTER.students)) {
    return window.ATTENDX_ROSTER.students.find(s => String(s.email || '').trim().toLowerCase() === clean);
  }
  return null;
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
  const batch = document.getElementById('reg-batch') ? document.getElementById('reg-batch').value.trim() : 'BATCH - 1';
  const rollInput = document.getElementById('reg-roll');
  const roll = rollInput ? rollInput.value.trim() : '';
  const mobileInput = document.getElementById('reg-mobile');
  const mobileEntered = mobileInput ? mobileInput.value.trim().replace(/[^0-9]/g, '') : '';
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
    let academicData = verifiedRosterData || findStudentInRoster(personalEmail) || (mobileEntered ? findStudentByMobile(mobileEntered) : null);

    // 1. Create account in Firebase Authentication using personal email
    const cred = await auth.createUserWithEmailAndPassword(personalEmail, password);
    
    if (cred.user && cred.user.updateProfile) {
      try {
        await cred.user.updateProfile({ displayName: academicData?.name || name });
      } catch (_) {}
    }

    // 2. Best-effort verification email link
    try {
      await cred.user.sendEmailVerification();
    } catch (verifErr) {
      console.warn('Could not send verification email:', verifErr);
    }

    // 3. Build student profile: using roster data if enrolled, or user-entered details if new student!
    const rollNumber = academicData?.rollNumber || roll || '';
    const studentMobile = academicData?.mobile || mobileEntered || '';
    const studentData = {
      name: academicData?.name || name,
      college: academicData?.college || 'AVN',
      branch: academicData?.branch || branch,
      section: academicData?.section || section || 'No Section',
      rollNumber: rollNumber,
      studentId: rollNumber,
      mobile: studentMobile,
      email: personalEmail,
      personalEmail: personalEmail,
      role: 'student',
      batch: academicData?.batch || batch || 'BATCH - 1',
      status: 'active',
      isNewRegistration: !academicData,
      createdAt: firebase.firestore.FieldValue.serverTimestamp()
    };

    // Save profile to Firestore users collection
    try {
      await db.collection('users').doc(cred.user.uid).set(studentData);
    } catch (fsErr) {
      console.warn('Firestore user doc write warning:', fsErr);
    }

    // If new student not originally in sheet, add them to student_roster so admin can track them
    if (!academicData) {
      try {
        await db.collection('settings').doc('student_roster').set({
          students: firebase.firestore.FieldValue.arrayUnion({
            name: studentData.name,
            email: personalEmail,
            mobile: studentMobile,
            branch: studentData.branch,
            section: studentData.section,
            batch: studentData.batch,
            rollNumber: rollNumber,
            college: 'AVN',
            status: 'verified',
            sourceSheet: 'Self-Registered'
          })
        }, { merge: true });
        
        if (typeof window !== 'undefined' && window.ATTENDX_ROSTER && Array.isArray(window.ATTENDX_ROSTER.students)) {
          window.ATTENDX_ROSTER.students.push({
            name: studentData.name,
            email: personalEmail,
            mobile: studentMobile,
            branch: studentData.branch,
            section: studentData.section,
            batch: studentData.batch,
            rollNumber: rollNumber,
            college: 'AVN',
            status: 'verified',
            sourceSheet: 'Self-Registered'
          });
        }
      } catch (rosterAddErr) {
        console.warn('Could not auto-add to roster collection:', rosterAddErr);
      }
    }

    // Store student profile locally for fast access
    localStorage.setItem(`user_profile_${cred.user.uid}`, JSON.stringify(studentData));
    try {
      const regList = JSON.parse(localStorage.getItem('attendx_registered_students') || '[]');
      regList.push({
        name: studentData.name,
        email: personalEmail,
        mobile: studentMobile,
        branch: studentData.branch,
        section: studentData.section,
        batch: studentData.batch,
        rollNumber: rollNumber
      });
      localStorage.setItem('attendx_registered_students', JSON.stringify(regList));
    } catch (_) {}

    closeStudentRegister();
    showToast('Account created successfully! Welcome to AttendX.', 'success');

    // Auto-redirect to student portal
    window.location.href = 'student.html';
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


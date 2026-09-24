// =============================================
// AUTH — Student (Roll Number) & Admin (Email)
// =============================================

// ---- On page load: redirect if already logged in ----
auth.onAuthStateChanged(async (user) => {
  if (user) {
    try {
      const doc = await db.collection('users').doc(user.uid).get();
      if (doc.exists) {
        const role = doc.data().role;
        const currentPath = window.location.pathname.toLowerCase();
        
        // If on home/student login page
        if (!currentPath.includes('/admin')) {
          if (role === 'admin') {
            window.location.href = '/admin';
          } else {
            window.location.href = 'student.html';
          }
        }
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
      // 1. Direct standard roll number email mapping
      authEmail = `${roll.toLowerCase()}@attendx.local`;
    }

    let cred;
    try {
      cred = await auth.signInWithEmailAndPassword(authEmail, password);
    } catch (authErr) {
      // Fallback: If not found and user typed roll without @, search Firestore for custom email
      if ((authErr.code === 'auth/user-not-found' || authErr.code === 'auth/invalid-credential') && !roll.includes('@')) {
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
      } else {
        throw authErr;
      }
    }

    const doc = await db.collection('users').doc(cred.user.uid).get();
    if (!doc.exists || doc.data().role !== 'student') {
      await auth.signOut();
      showError('This account is not a student account.');
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
  if (modal) modal.classList.add('show');
}

function closeStudentRegister() {
  const modal = document.getElementById('register-modal');
  if (modal) modal.classList.remove('show');
  
  const nameEl = document.getElementById('reg-name');
  const rollEl = document.getElementById('reg-roll');
  const passEl = document.getElementById('reg-password');
  const errEl  = document.getElementById('register-error');
  
  if (nameEl) nameEl.value = '';
  if (rollEl) rollEl.value = '';
  if (passEl) passEl.value = '';
  if (errEl)  errEl.classList.remove('show');
}

// ---- Register Student ----
async function registerStudent() {
  const name = document.getElementById('reg-name').value.trim();
  const roll = document.getElementById('reg-roll').value.trim().toUpperCase();
  const password = document.getElementById('reg-password').value;

  if (!name || !roll || !password) {
    return showRegError('Please fill in all fields.');
  }

  if (password.length < 6) {
    return showRegError('Password must be at least 6 characters.');
  }

  setLoading('reg-btn', true);
  try {
    const authEmail = `${roll.toLowerCase()}@attendx.local`;

    // Check if roll number already exists
    const checkSnap = await db.collection('users')
      .where('rollNumber', '==', roll)
      .limit(1)
      .get();

    if (!checkSnap.empty) {
      setLoading('reg-btn', false);
      return showRegError(`Roll Number "${roll}" is already registered. Please sign in.`);
    }

    const cred = await auth.createUserWithEmailAndPassword(authEmail, password);
    
    await db.collection('users').doc(cred.user.uid).set({
      name,
      rollNumber: roll,
      studentId: roll,
      email: authEmail,
      role: 'student',
      createdAt: firebase.firestore.FieldValue.serverTimestamp()
    });

    closeStudentRegister();
    showToast('Account created successfully! Logging you in...', 'success');
    window.location.href = 'student.html';
  } catch (e) {
    showRegError(getFriendlyError(e.code));
  } finally {
    setLoading('reg-btn', false);
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

// ---- Register Admin (used on /admin) ----
async function registerAdmin() {
  const name     = document.getElementById('admin-reg-name').value.trim();
  const email    = document.getElementById('admin-reg-email').value.trim();
  const password = document.getElementById('admin-reg-password').value;

  if (!name || !email || !password) {
    return showRegError('Please fill in all fields.');
  }

  if (password.length < 6) {
    return showRegError('Password must be at least 6 characters.');
  }

  setLoading('admin-reg-btn', true);
  try {
    const cred = await auth.createUserWithEmailAndPassword(email, password);
    await db.collection('users').doc(cred.user.uid).set({
      name,
      email,
      role: 'admin',
      createdAt: firebase.firestore.FieldValue.serverTimestamp()
    });

    const modal = document.getElementById('admin-register-modal');
    if (modal) modal.classList.remove('show');
    
    showToast('Admin account created successfully!', 'success');
    window.location.reload();
  } catch (e) {
    showRegError(getFriendlyError(e.code));
  } finally {
    setLoading('admin-reg-btn', false);
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
    'auth/user-not-found'      : 'No account found with these credentials.',
    'auth/wrong-password'      : 'Incorrect password. Please try again.',
    'auth/email-already-in-use': 'This Roll Number or Email is already registered.',
    'auth/invalid-email'       : 'Invalid credentials format.',
    'auth/weak-password'       : 'Password must be at least 6 characters.',
    'auth/too-many-requests'   : 'Too many attempts. Please wait a moment and try again.',
    'auth/invalid-credential'  : 'Invalid credentials or password.',
  };
  return map[code] || 'Authentication error. Please check your credentials and try again.';
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

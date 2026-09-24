// =============================================
// AUTH — Login, Register, Logout
// =============================================

let currentRole = 'admin';
let registerRole = 'admin';

// ---- On page load: redirect if already logged in ----
auth.onAuthStateChanged(async (user) => {
  if (user) {
    const doc = await db.collection('users').doc(user.uid).get();
    if (doc.exists) {
      const role = doc.data().role;
      if (role === 'admin') {
        window.location.href = 'admin.html';
      } else {
        window.location.href = 'student.html';
      }
    }
  }
});

// ---- Switch role tabs ----
function switchRole(role) {
  currentRole = role;
  document.querySelectorAll('.role-tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.form-section').forEach(s => s.classList.remove('active'));
  document.getElementById('tab-' + role).classList.add('active');
  document.getElementById('section-' + role).classList.add('active');
  hideError();
}

// ---- Login Admin ----
async function loginAdmin() {
  const email    = document.getElementById('admin-email').value.trim();
  const password = document.getElementById('admin-password').value;
  if (!email || !password) return showError('Please fill in all fields.');

  setLoading('admin-login-btn', true);
  try {
    const cred = await auth.signInWithEmailAndPassword(email, password);
    const doc  = await db.collection('users').doc(cred.user.uid).get();
    if (!doc.exists || doc.data().role !== 'admin') {
      await auth.signOut();
      showError('This account is not an admin account.');
      return;
    }
    window.location.href = 'admin.html';
  } catch (e) {
    showError(getFriendlyError(e.code));
  } finally {
    setLoading('admin-login-btn', false);
  }
}

// ---- Login Student ----
async function loginStudent() {
  const email    = document.getElementById('student-email').value.trim();
  const password = document.getElementById('student-password').value;
  if (!email || !password) return showError('Please fill in all fields.');

  setLoading('student-login-btn', true);
  try {
    const cred = await auth.signInWithEmailAndPassword(email, password);
    const doc  = await db.collection('users').doc(cred.user.uid).get();
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

// ---- Register ----
function openRegister(role) {
  registerRole = role;
  document.getElementById('register-title').innerHTML =
    role === 'admin'
      ? `<svg class="icon-svg" viewBox="0 0 24 24"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg> <span>Create Admin Account</span>`
      : `<svg class="icon-svg" viewBox="0 0 24 24"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg> <span>Create Student Account</span>`;
  document.getElementById('reg-studentid-group').style.display =
    role === 'student' ? 'block' : 'none';
  document.getElementById('register-modal').classList.add('show');
}

function closeRegister() {
  document.getElementById('register-modal').classList.remove('show');
  document.getElementById('reg-name').value = '';
  document.getElementById('reg-email').value = '';
  document.getElementById('reg-password').value = '';
  document.getElementById('reg-studentid').value = '';
  document.getElementById('register-error').classList.remove('show');
}

async function registerUser() {
  const name      = document.getElementById('reg-name').value.trim();
  const email     = document.getElementById('reg-email').value.trim();
  const password  = document.getElementById('reg-password').value;
  const studentId = document.getElementById('reg-studentid').value.trim();

  if (!name || !email || !password) {
    return showRegError('Please fill in all fields.');
  }
  if (registerRole === 'student' && !studentId) {
    return showRegError('Please enter your Student ID.');
  }
  if (password.length < 6) {
    return showRegError('Password must be at least 6 characters.');
  }

  setLoading('reg-btn', true);
  try {
    const cred = await auth.createUserWithEmailAndPassword(email, password);
    const userData = {
      name, email,
      role: registerRole,
      createdAt: firebase.firestore.FieldValue.serverTimestamp()
    };
    if (registerRole === 'student') userData.studentId = studentId;

    await db.collection('users').doc(cred.user.uid).set(userData);
    closeRegister();
    showToast('Account created! You can now log in.', 'success');
  } catch (e) {
    showRegError(getFriendlyError(e.code));
  } finally {
    setLoading('reg-btn', false);
  }
}

// ---- Helpers ----
function showError(msg) {
  const el = document.getElementById('error-msg');
  el.textContent = msg;
  el.classList.add('show');
}

function hideError() {
  document.getElementById('error-msg').classList.remove('show');
}

function showRegError(msg) {
  const el = document.getElementById('register-error');
  el.textContent = msg;
  el.classList.add('show');
}

function setLoading(btnId, loading) {
  const btn = document.getElementById(btnId);
  btn.disabled = loading;
  btn.innerHTML = loading
    ? '<span class="spinner"></span> Please wait...'
    : btn.dataset.label || btn.innerHTML;
}

function getFriendlyError(code) {
  const map = {
    'auth/user-not-found'      : 'No account found with this email.',
    'auth/wrong-password'      : 'Incorrect password.',
    'auth/email-already-in-use': 'This email is already registered.',
    'auth/invalid-email'       : 'Please enter a valid email address.',
    'auth/weak-password'       : 'Password must be at least 6 characters.',
    'auth/too-many-requests'   : 'Too many attempts. Please try again later.',
    'auth/invalid-credential'  : 'Invalid email or password.',
  };
  return map[code] || 'Something went wrong. Please try again.';
}

function showToast(msg, type = 'info') {
  const container = document.getElementById('toast-container');
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.textContent = msg;
  container.appendChild(toast);
  setTimeout(() => toast.remove(), 3500);
}

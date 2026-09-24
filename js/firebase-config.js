// ✅ Firebase CDN-compatible config (works in plain HTML)
const firebaseConfig = {
  apiKey: "AIzaSyCKrXpMGVrqxoZhXf0zeJCUSswr2yiHjzY",
  authDomain: "attendance-aacfc.firebaseapp.com",
  projectId: "attendance-aacfc",
  storageBucket: "attendance-aacfc.firebasestorage.app",
  messagingSenderId: "519244766023",
  appId: "1:519244766023:web:a2a02fd606ca9eed7e4a62"
};

// Initialize Firebase
firebase.initializeApp(firebaseConfig);

const auth = firebase.auth();
const db  = firebase.firestore();

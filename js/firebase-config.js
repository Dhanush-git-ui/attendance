// ✅ Firebase CDN-compatible config (works in plain HTML)
const firebaseConfig = {
  apiKey: "AIzaSyB6qOod12fH8h6anpLCfNeTjOS3akajr1c",
  authDomain: "attendx-ae324.firebaseapp.com",
  databaseURL: "https://attendx-ae324-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId: "attendx-ae324",
  storageBucket: "attendx-ae324.firebasestorage.app",
  messagingSenderId: "528375541523",
  appId: "1:528375541523:web:b84ea9cba1db493a1bf4e6",
  measurementId: "G-JBY9Q0G28G"
};

// Initialize Firebase
firebase.initializeApp(firebaseConfig);

const auth = firebase.auth();
const db  = firebase.firestore();
const functions = typeof firebase.functions === 'function' ? firebase.functions() : null;

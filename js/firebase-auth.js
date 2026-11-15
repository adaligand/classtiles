import { initializeApp } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-app.js";
import {
  getFirestore,
  collection,
  addDoc,
  getDocs,
  doc,
  setDoc,
  getDoc,
  updateDoc,
  deleteDoc
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";
import {
  getAuth,
  signInWithPopup,
  GoogleAuthProvider,
  signOut,
  onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js";

import { showView } from "./state-and-views.js";

const firebaseConfig = {
  apiKey: "AIzaSyBSU87WMLPKqBwpO_6fQzWF2vgXrkz1d0E",
  authDomain: "classtile-19e74.firebaseapp.com",
  projectId: "classtile-19e74",
  storageBucket: "classtile-19e74.firebasestorage.app",
  messagingSenderId: "826310108132",
  appId: "1:826310108132:web:315b6e4d3a732cabd75df1"
};

export const app = initializeApp(firebaseConfig);
export const db = getFirestore(app);
export const auth = getAuth(app);
export const googleProvider = new GoogleAuthProvider();

googleProvider.addScope("https://www.googleapis.com/auth/classroom.courses.readonly");
googleProvider.addScope("https://www.googleapis.com/auth/classroom.rosters.readonly");

export {
  collection,
  addDoc,
  getDocs,
  doc,
  setDoc,
  getDoc,
  updateDoc,
  deleteDoc
};

let googleAccessToken = null;

export function getGoogleAccessToken() {
  return googleAccessToken;
}

export function isTeacherEmail(email) {
  if (!email) return false;
  const clean = email.trim().toLowerCase();
  const isCedarsDomain = clean.endsWith("@cedarsupper.co.uk");
  const isStudent = /^\d/.test(clean);
  return isCedarsDomain && !isStudent;
}

export async function handleGoogleLogin() {
  const errorEl = document.getElementById("login-error");
  if (errorEl) errorEl.textContent = "";

  try {
    const result = await signInWithPopup(auth, googleProvider);
    const user = result.user;

    const credential = GoogleAuthProvider.credentialFromResult(result);
    if (credential) {
      googleAccessToken = credential.accessToken;
    }

    if (!isTeacherEmail(user.email)) {
      await signOut(auth);
      if (errorEl) {
        errorEl.textContent = "Access denied. Only teacher accounts (@cedarsupper.co.uk) are permitted.";
      }
    }
  } catch (err) {
    console.error("Login failed:", err);
    if (errorEl) {
      errorEl.textContent = "Sign-in failed. " + err.message;
    }
  }
}

export async function handleLogout() {
  await signOut(auth);
}

onAuthStateChanged(auth, async (user) => {
  const loginScreen = document.getElementById("login-screen");
  const userProfile = document.getElementById("user-profile");
  const userEmailDisplay = document.getElementById("user-email-display");
  const btnSignout = document.getElementById("btn-signout");
  const errorEl = document.getElementById("login-error");

  if (user) {
    if (isTeacherEmail(user.email)) {
      if (loginScreen) loginScreen.classList.add("hidden");
      if (userProfile) userProfile.classList.remove("hidden");
      if (btnSignout) btnSignout.classList.remove("hidden");
      if (userEmailDisplay) userEmailDisplay.textContent = user.email;

      showView("view-home");
    } else {
      await signOut(auth);
      if (loginScreen) loginScreen.classList.remove("hidden");
      if (userProfile) userProfile.classList.add("hidden");
      if (btnSignout) btnSignout.classList.add("hidden");
      if (errorEl) {
        errorEl.textContent = "Access denied. Student accounts starting with numbers cannot log in.";
      }
    }
  } else {
    if (loginScreen) loginScreen.classList.remove("hidden");
    if (userProfile) userProfile.classList.add("hidden");
    if (btnSignout) btnSignout.classList.add("hidden");
  }
});

// Expose functions called directly from HTML attributes
window.handleGoogleLogin = handleGoogleLogin;
window.handleLogout = handleLogout;

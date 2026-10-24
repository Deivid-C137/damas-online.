
import { initializeApp } from "https://www.gstatic.com/firebasejs/11.10.0/firebase-app.js";

import {
  getAuth,
  GoogleAuthProvider,
  signInWithPopup,
  onAuthStateChanged,
  signOut
} from "https://www.gstatic.com/firebasejs/11.10.0/firebase-auth.js";

// Configuração copiada do Firebase Console
const firebaseConfig = {
  apiKey: "AIzaSyArMuHtTim7TnqgKHqsl181P57YlaeZJRI",
  authDomain: "damas-online-fa10c.firebaseapp.com",
  projectId: "damas-online-fa10c",
  storageBucket: "damas-online-fa10c.firebasestorage.app",
  messagingSenderId: "951427213729",
  appId: "1:951427213729:web:6c346133de8f8b63a4c3e0",
  measurementId: "G-3HH65R2207"
};

// Inicializa o Firebase e o login
const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const provider = new GoogleAuthProvider();

// Elementos do login no index.html
const loginButton = document.getElementById("google-login");
const logoutButton = document.getElementById("google-logout");
const loginStatus = document.getElementById("login-status");
const loginEmail = document.getElementById("login-email");
const loginMessage = document.getElementById("login-message");

// Envia o token de autenticação para o jogo
function notifyGame(token) {
  window.dispatchEvent(
    new CustomEvent("firebase-user-token", {
      detail: { token }
    })
  );
}

if (
  !loginButton ||
  !logoutButton ||
  !loginStatus ||
  !loginEmail ||
  !loginMessage
) {
  console.error(
    "Não encontrei os elementos do login no index.html."
  );
} else {
  // Entrar com Google
  loginButton.addEventListener("click", async () => {
    loginButton.disabled = true;
    loginMessage.textContent = "Abrindo o login do Google...";

    try {
      await signInWithPopup(auth, provider);
      loginMessage.textContent = "Login realizado com sucesso!";
    } catch (error) {
      console.error("Erro no login:", error);
      loginMessage.textContent =
        "Erro no login: " + error.message;
    } finally {
      loginButton.disabled = false;
    }
  });

  // Sair da conta
  logoutButton.addEventListener("click", async () => {
    logoutButton.disabled = true;

    try {
      await signOut(auth);
      loginMessage.textContent = "Você saiu da sua conta.";
    } catch (error) {
      console.error("Erro ao sair:", error);
      loginMessage.textContent =
        "Erro ao sair: " + error.message;
    } finally {
      logoutButton.disabled = false;
    }
  });

  // Mantém a interface sincronizada com o estado da conta
  onAuthStateChanged(auth, async (user) => {
    if (user) {
      loginStatus.textContent =
        "Conectado como " + (user.displayName || "Jogador");

      loginEmail.textContent = user.email || "";
      loginButton.hidden = true;
      logoutButton.hidden = false;

      try {
        const token = await user.getIdToken();
        notifyGame(token);
      } catch (error) {
        console.error("Erro ao obter token:", error);
        loginMessage.textContent =
          "Não foi possível autenticar o jogo. Entre novamente.";
      }
    } else {
      loginStatus.textContent = "Você não está conectado.";
      loginEmail.textContent = "Entre para carregar sua conta.";

      loginButton.hidden = false;
      logoutButton.hidden = true;

      notifyGame(null);
    }
  });
}

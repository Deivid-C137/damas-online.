import { initializeApp } from "https://www.gstatic.com/firebasejs/11.10.0/firebase-app.js";

import {
  getAuth,
  GoogleAuthProvider,
  signInWithPopup,
  onAuthStateChanged,
  signOut,
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  sendPasswordResetEmail,
  setPersistence,
  browserLocalPersistence,
  browserSessionPersistence
} from "https://www.gstatic.com/firebasejs/11.10.0/firebase-auth.js";

// Configuração do Firebase já utilizada pelo Damas Online
const firebaseConfig = {
  apiKey: "AIzaSyArMuHtTim7TnqgKHqsl181P57YlaeZJRI",
  authDomain: "damas-online-fa10c.firebaseapp.com",
  projectId: "damas-online-fa10c",
  storageBucket: "damas-online-fa10c.firebasestorage.app",
  messagingSenderId: "951427213729",
  appId: "1:951427213729:web:6c346133de8f8b63a4c3e0",
  measurementId: "G-3HH65R2207"
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const provider = new GoogleAuthProvider();

const loginButton = document.getElementById("google-login");
const logoutButton = document.getElementById("google-logout");
const loginStatus = document.getElementById("login-status");
const loginEmail = document.getElementById("login-email");
const loginMessage = document.getElementById("login-message");

let mode = "login";

function notifyGame(token) {
  window.dispatchEvent(
    new CustomEvent("firebase-user-token", {
      detail: { token }
    })
  );
}

function errorMessage(error) {
  const messages = {
    "auth/invalid-email": "Digite um endereço de e-mail válido.",
    "auth/user-not-found": "Não encontramos uma conta com esse e-mail.",
    "auth/wrong-password": "A senha está incorreta.",
    "auth/invalid-credential": "E-mail ou senha incorretos.",
    "auth/email-already-in-use": "Este e-mail já possui uma conta.",
    "auth/weak-password": "A senha precisa ter pelo menos 6 caracteres.",
    "auth/too-many-requests": "Muitas tentativas. Aguarde um pouco e tente novamente.",
    "auth/popup-closed-by-user": "A janela do Google foi fechada.",
    "auth/popup-blocked": "O navegador bloqueou a janela. Permita pop-ups para este site.",
    "auth/network-request-failed": "Falha de conexão. Verifique sua internet.",
    "auth/operation-not-allowed": "Este método de login ainda não está ativado no Firebase."
  };

  return messages[error.code] || "Não foi possível concluir. Tente novamente.";
}

// Cria a tela de entrada sem alterar o tabuleiro ou o sistema de partidas.
const authScreen = document.createElement("section");
authScreen.id = "auth-screen";

authScreen.innerHTML = `
  <div class="auth-hero" aria-label="Arte do Damas Online"></div>
  <div class="auth-card">
    <div class="auth-brand-icon" aria-hidden="true">♛</div>
    <p class="auth-eyebrow">DAMAS ONLINE</p>
    <h1 class="auth-title">ENTRE NA SUA <span>CONTA</span></h1>
    <p class="auth-subtitle">Entre para jogar Damas Online</p>
    <div class="auth-tabs">
      <button type="button" id="auth-tab-login" class="auth-tab active">Entrar</button>
      <button type="button" id="auth-tab-register" class="auth-tab">Criar conta</button>
    </div>
    <button type="button" id="auth-google" class="auth-google">
      <span class="google-symbol">G</span> Continuar com Google
    </button>
    <div class="auth-divider"><span>OU ENTRE COM E-MAIL</span></div>
    <form id="auth-form">
      <label for="auth-email">E-MAIL</label>
      <input id="auth-email" type="email" placeholder="seuemail@exemplo.com" autocomplete="email" required>
      <div class="auth-password-heading">
        <label for="auth-password">SENHA</label>
        <button type="button" id="auth-toggle-password">Mostrar</button>
      </div>
      <input id="auth-password" type="password" placeholder="Digite sua senha" autocomplete="current-password" minlength="6" required>
      <div class="auth-options">
        <label class="auth-remember"><input type="checkbox" id="auth-remember" checked> Lembrar-me</label>
        <button type="button" id="auth-forgot">Esqueci minha senha</button>
      </div>
      <button type="submit" id="auth-submit" class="auth-submit">ENTRAR</button>
    </form>
    <p id="auth-message" class="auth-message" role="status" aria-live="polite">Sua conta será usada para salvar seu perfil de jogador.</p>
    <p class="auth-security"><span>●</span> PARTIDAS SEGURAS E CONEXÃO EM TEMPO REAL</p>
  </div>
`;

document.querySelector(".game").prepend(authScreen);

const authForm = document.getElementById("auth-form");
const emailInput = document.getElementById("auth-email");
const passwordInput = document.getElementById("auth-password");
const message = document.getElementById("auth-message");
const submitButton = document.getElementById("auth-submit");
const rememberInput = document.getElementById("auth-remember");
const googleButton = document.getElementById("auth-google");

function showMessage(text, error = false) {
  message.textContent = text;
  message.classList.toggle("error", error);
}

function setLoading(loading, text) {
  submitButton.disabled = loading;
  googleButton.disabled = loading;

  if (loading) {
    submitButton.textContent = text || "AGUARDE...";
    } else {
    submitButton.textContent =
      mode === "register" ? "CRIAR MINHA CONTA" : "ENTRAR NA ARENA";
  }
}

function updateMode() {
  const registering = mode === "register";

  document.getElementById("auth-tab-login").classList.toggle("active", !registering);
  document.getElementById("auth-tab-register").classList.toggle("active", registering);

  submitButton.textContent = registering ? "CRIAR MINHA CONTA" : "ENTRAR NA ARENA";

  passwordInput.autocomplete = registering ? "new-password" : "current-password";

  document.getElementById("auth-forgot").hidden = registering;

  showMessage(
    registering
      ? "Crie sua conta para entrar na arena."
      : "Entre para acessar sua conta e jogar online."
  );
}

document.getElementById("auth-tab-login").addEventListener("click", () => {
  mode = "login";
  updateMode();
});

document.getElementById("auth-tab-register").addEventListener("click", () => {
  mode = "register";
  updateMode();
});

document.getElementById("auth-toggle-password").addEventListener("click", (event) => {
  const showing = passwordInput.type === "text";
  passwordInput.type = showing ? "password" : "text";
  event.currentTarget.textContent = showing ? "Mostrar" : "Ocultar";
});

async function applyPersistence() {
  await setPersistence(
    auth,
    rememberInput.checked
      ? browserLocalPersistence
      : browserSessionPersistence
  );
}

// Login e cadastro com e-mail
authForm.addEventListener("submit", async (event) => {
  event.preventDefault();

  const email = emailInput.value.trim();
  const password = passwordInput.value;

  if (!email || !password) {
    showMessage("Preencha o e-mail e a senha.", true);
    return;
  }

  setLoading(true, mode === "register" ? "CRIANDO CONTA..." : "ENTRANDO...");

  try {
    await applyPersistence();

    if (mode === "register") {
      await createUserWithEmailAndPassword(auth, email, password);
    } else {
      await signInWithEmailAndPassword(auth, email, password);
    }
  } catch (error) {
    console.error("Erro na autenticação:", error);
    showMessage(errorMessage(error), true);
    setLoading(false);
  }
});

// Login com Google
googleButton.addEventListener("click", async () => {
  setLoading(true, "CONECTANDO...");

  try {
    await applyPersistence();
    await signInWithPopup(auth, provider);
  } catch (error) {
    console.error("Erro no Google:", error);
    showMessage(errorMessage(error), true);
    setLoading(false);
  }
});

// Recuperação de senha
document.getElementById("auth-forgot").addEventListener("click", async () => {
  const email = emailInput.value.trim();

  if (!email) {
    showMessage("Digite seu e-mail primeiro para receber o link de recuperação.", true);
    emailInput.focus();
    return;
  }

  try {
    await sendPasswordResetEmail(auth, email);
    showMessage("Se existir uma conta para esse e-mail, o link de recuperação será enviado.");
  } catch (error) {
    console.error("Erro ao recuperar senha:", error);
    showMessage(errorMessage(error), true);
  }
});

// Mantém o botão antigo de login funcional caso seja usado em outra parte da página.
if (loginButton) {
  loginButton.addEventListener("click", async () => {
    try {
      await applyPersistence();
      await signInWithPopup(auth, provider);
    } catch (error) {
      showMessage(errorMessage(error), true);
    }
  });
}

// Sair da conta
if (logoutButton) {
  logoutButton.addEventListener("click", async () => {
    try {
      await signOut(auth);
      showMessage("Você saiu da sua conta.");
    } catch (error) {
      showMessage(errorMessage(error), true);
    }
  });
}

// Estado da conta: mostra o jogo somente depois de autenticar.
onAuthStateChanged(auth, async (user) => {

  // Reativa os botões sempre que o estado da conta mudar.
  setLoading(false);

  if (user) {
    document.body.classList.remove("auth-locked");

    if (loginStatus) {
      loginStatus.textContent = "Conectado como " + (user.displayName || "Jogador");
    }

    if (loginEmail) {
      loginEmail.textContent = user.email || "";
    }

    if (loginButton) loginButton.hidden = true;
    if (logoutButton) logoutButton.hidden = false;

    authScreen.hidden = true;

    try {
      const token = await user.getIdToken();
      notifyGame(token);
    } catch (error) {
      console.error("Erro ao obter token:", error);
      showMessage("Não foi possível autenticar o jogo. Entre novamente.", true);
    }
  } else {
    document.body.classList.add("auth-locked");
    authScreen.hidden = false;

    if (loginStatus) loginStatus.textContent = "Você não está conectado.";
    if (loginEmail) loginEmail.textContent = "Entre para carregar sua conta.";

    if (loginButton) loginButton.hidden = false;
    if (logoutButton) logoutButton.hidden = true;

    notifyGame(null);
  }
});

document.body.classList.add("auth-locked");
updateMode();
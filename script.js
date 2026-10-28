"use strict";

// ==================================================
// ELEMENTOS DO HTML
// ==================================================

const boardElement = document.getElementById("board");
const statusElement = document.getElementById("status");
const resetButton = document.getElementById("reset");

const createRoomButton = document.getElementById("create-room");
const joinRoomButton = document.getElementById("join-room");
const roomCodeInput = document.getElementById("room-code");
const roomInfo = document.getElementById("room-info");
const blackPlayerLabel = document.getElementById("black-player");
const whitePlayerLabel = document.getElementById("white-player");

const turnBanner = document.getElementById("turn-banner");
const turnTitle = document.getElementById("turn-title");
const turnDescription = document.getElementById("turn-description");
const blackCard = document.getElementById("black-card");
const whiteCard = document.getElementById("white-card");

// ==================================================
// ESTADO DO JOGO
// ==================================================

let socket = null;
let firebaseToken = null;
let connectingSocket = false;

let board = [];
let turn = "black";
let selected = null;
let legalMoves = [];
let gameOver = false;
let mustContinue = null;
let movePending = false;

let onlineRoomCode = null;
let onlinePlayerColor = null;
let onlineGameActive = false;

let roomControlsRegistered = false;

// ==================================================
// TABULEIRO
// ==================================================

function createInitialBoard() {
  const newBoard = Array.from(
    { length: 8 },
    () => Array(8).fill(null)
  );

  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 8; c++) {
      if ((r + c) % 2 === 1) {
        newBoard[r][c] = {
          color: "black",
          king: false
        };
      }
    }
  }

  for (let r = 5; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      if ((r + c) % 2 === 1) {
        newBoard[r][c] = {
          color: "white",
          king: false
        };
      }
    }
  }

  return newBoard;
}

function newGame() {
  board = createInitialBoard();
  turn = "black";
  selected = null;
  legalMoves = [];
  gameOver = false;
  mustContinue = null;
  movePending = false;

  render();
}

function inside(r, c) {
  return r >= 0 && r < 8 && c >= 0 && c < 8;
}

function otherColor(color) {
  return color === "black" ? "white" : "black";
}

// ==================================================
// MOVIMENTOS E CAPTURAS
// ==================================================

function movesFor(r, c, capturesOnly = false) {
  if (!inside(r, c) || !board[r][c]) {
    return [];
  }

  const piece = board[r][c];
  const moves = [];

  // --------------------------------------------------
  // PEÇA COMUM
  // Anda para frente e captura para frente ou para trás.
  // --------------------------------------------------

  if (!piece.king) {
    const forward = piece.color === "black" ? 1 : -1;

    for (const dc of [-1, 1]) {
      // Movimento simples: somente para frente.
      const nextR = r + forward;
      const nextC = c + dc;

      if (
        !capturesOnly &&
        inside(nextR, nextC) &&
        !board[nextR][nextC]
      ) {
        moves.push({
          r: nextR,
          c: nextC,
          capture: null
        });
      }

      // Captura: pode ser para frente ou para trás.
      for (const dr of [-1, 1]) {
        const enemyR = r + dr;
        const enemyC = c + dc;
        const landingR = r + dr * 2;
        const landingC = c + dc * 2;

        if (
          !inside(enemyR, enemyC) ||
          !inside(landingR, landingC)
        ) {
          continue;
        }

        const enemy = board[enemyR][enemyC];

        if (
          enemy &&
          enemy.color !== piece.color &&
          !board[landingR][landingC]
        ) {
          moves.push({
            r: landingR,
            c: landingC,
            capture: {
              r: enemyR,
              c: enemyC
            }
          });
        }
      }
    }

    return moves;
  }

  // --------------------------------------------------
  // DAMA
  // Move pelas diagonais e captura peças adversárias.
  // --------------------------------------------------

  for (const dr of [-1, 1]) {
    for (const dc of [-1, 1]) {
      let nr = r + dr;
      let nc = c + dc;
      let enemy = null;

      while (inside(nr, nc)) {
        const occupant = board[nr][nc];

        if (!occupant) {
          if (enemy) {
            moves.push({
              r: nr,
              c: nc,
              capture: {
                r: enemy.r,
                c: enemy.c
              }
            });
          } else if (!capturesOnly) {
            moves.push({
              r: nr,
              c: nc,
              capture: null
            });
          }
        } else {
          if (occupant.color === piece.color || enemy) {
            break;
          }

          enemy = {
            r: nr,
            c: nc
          };
        }

        nr += dr;
        nc += dc;
      }
    }
  }

  return moves;
}

function allCaptures(color) {
  const result = [];

  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      if (board[r][c]?.color !== color) {
        continue;
      }

      if (movesFor(r, c, true).length > 0) {
        result.push({ r, c });
      }
    }
  }

  return result;
}

function hasAnyMove(color) {
  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      if (board[r][c]?.color !== color) {
        continue;
      }

      if (movesFor(r, c).length > 0) {
        return true;
      }
    }
  }

  return false;
}

// ==================================================
// AVISO DE TURNO
// ==================================================

function updateTurnBanner() {
  if (!turnBanner || !turnTitle || !turnDescription) {
    return;
  }

  turnBanner.classList.remove(
    "your-turn",
    "opponent-turn",
    "waiting",
    "finished"
  );

  if (blackCard) {
    blackCard.classList.toggle(
      "active",
      !gameOver && turn === "black"
    );
  }

  if (whiteCard) {
    whiteCard.classList.toggle(
      "active",
      !gameOver && turn === "white"
    );
  }

  if (gameOver) {
    turnBanner.classList.add("finished");
    turnTitle.textContent = "PARTIDA ENCERRADA";
    turnDescription.textContent =
      statusElement?.textContent || "A partida terminou.";
    return;
  }

  if (onlineRoomCode && !onlineGameActive) {
    turnBanner.classList.add("waiting");
    turnTitle.textContent = "AGUARDANDO OPONENTE";
    turnDescription.textContent =
      "A partida começará quando o adversário entrar.";
    return;
  }

  if (onlineRoomCode) {
    if (turn === onlinePlayerColor) {
      turnBanner.classList.add("your-turn");

      turnTitle.textContent = movePending
        ? "JOGADA ENVIADA"
        : "É SUA VEZ!";

      turnDescription.textContent = movePending
        ? "Aguardando confirmação do servidor."
        : mustContinue
          ? "Continue capturando com a mesma peça."
          : "Selecione uma peça e faça sua jogada.";
    } else {
      turnBanner.classList.add("opponent-turn");
      turnTitle.textContent = "VEZ DO OPONENTE";
      turnDescription.textContent =
        "Aguarde a jogada do outro jogador.";
    }

    return;
  }

  turnBanner.classList.add("your-turn");

  turnTitle.textContent =
    turn === "black" ? "VEZ DAS PRETAS" : "VEZ DAS BRANCAS";

  turnDescription.textContent = mustContinue
    ? "Continue a sequência de capturas."
    : "Selecione uma peça para jogar.";
}

// ==================================================
// DESENHAR TABULEIRO
// ==================================================

function render() {
  if (!boardElement || !statusElement || !board) {
    return;
  }

  boardElement.innerHTML = "";

  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      const cell = document.createElement("button");

      cell.type = "button";
      cell.className =
        "cell " + ((r + c) % 2 ? "dark" : "light");

      cell.setAttribute(
        "aria-label",
        `Linha ${r + 1}, coluna ${c + 1}`
      );

      if (selected?.r === r && selected?.c === c) {
        cell.classList.add("selected");
      }

      if (legalMoves.some(m => m.r === r && m.c === c)) {
        cell.classList.add("target");
      }

      const piece = board[r][c];

      if (piece) {
        const disk = document.createElement("div");
        disk.className = `piece ${piece.color}`;

        if (piece.king) {
          disk.classList.add("king");
          disk.textContent = "♛";
        }

        cell.appendChild(disk);
      }

      cell.addEventListener("click", () => {
        clickCell(r, c);
      });

      boardElement.appendChild(cell);
    }
  }

  if (!gameOver) {
    if (onlineRoomCode && !onlineGameActive) {
      statusElement.textContent = "Aguardando o adversário.";
    } else if (onlineRoomCode) {
      statusElement.textContent =
        turn === onlinePlayerColor
          ? "Sua vez de jogar."
          : "Vez do adversário.";
    } else {
      statusElement.textContent =
        `Vez das ${turn === "black" ? "pretas" : "brancas"}.`;
    }
  }

  updateTurnBanner();
}

// ==================================================
// CLIQUES NO TABULEIRO
// ==================================================

function clickCell(r, c) {
  if (gameOver || movePending) {
    return;
  }

  if (onlineRoomCode) {
    if (!onlineGameActive) {
      if (statusElement) {
        statusElement.textContent =
          "Aguardando o adversário entrar na sala.";
      }

      return;
    }

    clickOnlineCell(r, c);
    return;
  }

  clickLocalCell(r, c);
}

// ==================================================
// PARTIDA LOCAL
// ==================================================

function clickLocalCell(r, c) {
  const chosenMove = selected
    ? legalMoves.find(m => m.r === r && m.c === c)
    : null;

  if (chosenMove) {
    const piece = board[selected.r][selected.c];

    board[r][c] = piece;
    board[selected.r][selected.c] = null;

    if (chosenMove.capture) {
      board[chosenMove.capture.r][chosenMove.capture.c] = null;
    }

    // Promove a peça a dama ao chegar à última linha.
    if (
      (piece.color === "black" && r === 7) ||
      (piece.color === "white" && r === 0)
    ) {
      piece.king = true;
    }

    selected = null;
    legalMoves = [];

    // Se ainda houver captura, a mesma peça continua jogando.
    if (
      chosenMove.capture &&
      movesFor(r, c, true).length > 0
    ) {
      mustContinue = { r, c };
      selected = { r, c };
      legalMoves = movesFor(r, c, true);

      render();

      statusElement.textContent =
        "Continue capturando com a mesma peça.";

      updateTurnBanner();
      return;
    }

    finishLocalTurn();
    return;
  }

  if (board[r][c]?.color === turn) {
    if (
      mustContinue &&
      (r !== mustContinue.r || c !== mustContinue.c)
    ) {
      statusElement.textContent =
        "Continue a captura com a mesma peça.";
      return;
    }

    const captures = allCaptures(turn);

    if (
      !mustContinue &&
      captures.length > 0 &&
      !captures.some(p => p.r === r && p.c === c)
    ) {
      statusElement.textContent =
        "Captura obrigatória: escolha uma peça que possa capturar.";
      return;
    }

    selected = { r, c };

    legalMoves = movesFor(
      r,
      c,
      Boolean(mustContinue) || captures.length > 0
    );

    render();

    if (legalMoves.length === 0) {
      statusElement.textContent =
        "Essa peça não tem movimentos disponíveis.";
    }

    return;
  }

  if (!mustContinue) {
    selected = null;
    legalMoves = [];
    render();
  }
}

function finishLocalTurn() {
  mustContinue = null;
  selected = null;
  legalMoves = [];

  turn = otherColor(turn);

  if (!hasAnyMove(turn)) {
    gameOver = true;

    statusElement.textContent =
      `Fim de jogo! ${otherColor(turn) === "black" ? "Pretas" : "Brancas"} venceram!`;
  }

  render();
}

// ==================================================
// PARTIDA ONLINE
// ==================================================

function clickOnlineCell(r, c) {
  if (movePending || gameOver) {
    return;
  }

  if (!socket?.connected) {
    statusElement.textContent =
      "Conexão perdida com o servidor.";
    return;
  }

  if (turn !== onlinePlayerColor) {
    statusElement.textContent = "Aguarde a sua vez.";
    return;
  }

  const chosenMove = selected
    ? legalMoves.find(m => m.r === r && m.c === c)
    : null;

  if (chosenMove) {
    movePending = true;

    socket.emit("moveAttempt", {
      from: {
        r: selected.r,
        c: selected.c
      },
      to: { r, c }
    });

    statusElement.textContent = "Enviando jogada.";
    updateTurnBanner();
    return;
  }

  if (board[r][c]?.color === onlinePlayerColor) {
    if (
      mustContinue &&
      (r !== mustContinue.r || c !== mustContinue.c)
    ) {
      statusElement.textContent =
        "Continue a captura com a mesma peça.";
      return;
    }

    const captures = allCaptures(turn);

    if (
      !mustContinue &&
      captures.length > 0 &&
      !captures.some(p => p.r === r && p.c === c)
    ) {
      statusElement.textContent =
        "Captura obrigatória: escolha uma peça que possa capturar.";
      return;
    }

    selected = { r, c };

    legalMoves = movesFor(
      r,
      c,
      Boolean(mustContinue) || captures.length > 0
    );

    render();

    if (legalMoves.length === 0) {
      statusElement.textContent =
        "Essa peça não tem movimentos disponíveis.";
    }

    return;
  }

  if (!mustContinue) {
    selected = null;
    legalMoves = [];
    render();
  }
}

// ==================================================
// CONTROLES DAS SALAS
// ==================================================

function registerRoomControls() {
  if (roomControlsRegistered) {
    return;
  }

  if (!createRoomButton || !joinRoomButton || !roomCodeInput) {
    console.error("Elementos de sala não encontrados no HTML.");
    return;
  }

  roomControlsRegistered = true;

  createRoomButton.addEventListener("click", () => {
    if (!socket?.connected) {
      if (roomInfo) {
        roomInfo.textContent =
          "Faça login com Google e aguarde a conexão.";
      }

      return;
    }

    if (onlineRoomCode) {
      if (roomInfo) {
        roomInfo.textContent = "Você já está em uma sala.";
      }

      return;
    }

    socket.emit("createRoom");
  });

  joinRoomButton.addEventListener("click", () => {
    if (!socket?.connected) {
      if (roomInfo) {
        roomInfo.textContent =
          "Faça login com Google e aguarde a conexão.";
      }

      return;
    }

    const code = roomCodeInput.value.trim().toUpperCase();

    if (!code) {
      if (roomInfo) {
        roomInfo.textContent = "Digite o código da sala.";
      }

      return;
    }

    if (onlineRoomCode) {
      if (roomInfo) {
        roomInfo.textContent = "Você já está em uma sala.";
      }

      return;
    }

    socket.emit("joinRoom", code);
  });

  roomCodeInput.addEventListener("input", () => {
    roomCodeInput.value = roomCodeInput.value
      .toUpperCase()
      .replace(/[^A-HJ-NP-Z2-9]/g, "");
  });
}

// ==================================================
// EVENTOS DO SOCKET
// ==================================================

function registerSocketEvents(gameSocket) {
  gameSocket.on("connect", () => {
    if (gameSocket !== socket) return;

    connectingSocket = false;

    console.log("Conectado ao servidor do jogo.");

    if (roomInfo) {
      roomInfo.textContent =
        "Conectado ao servidor. Crie ou entre em uma sala.";
    }
  });

  gameSocket.on("connect_error", error => {
    if (gameSocket !== socket) return;

    connectingSocket = false;

    console.error("Erro na conexão:", error.message);

    if (roomInfo) {
      roomInfo.textContent = "Erro de conexão: " + error.message;
    }
  });

  gameSocket.on("roomCreated", data => {
    if (gameSocket !== socket) return;

    onlineRoomCode = data.code;
    onlinePlayerColor = data.color;
    onlineGameActive = false;

    movePending = false;
    gameOver = false;
    mustContinue = null;
    selected = null;
    legalMoves = [];

    if (roomCodeInput) {
      roomCodeInput.value = data.code;
    }

    if (roomInfo) {
      roomInfo.textContent =
        `Sua sala: ${data.code}. Compartilhe o código com o adversário.`;
    }

    if (blackPlayerLabel) {
      blackPlayerLabel.textContent =
        data.color === "black"
          ? "Você (pretas)"
          : "Jogador 1 (pretas)";
    }

    if (whitePlayerLabel) {
      whitePlayerLabel.textContent = "Aguardando adversário";
    }

    if (createRoomButton) createRoomButton.disabled = true;
    if (joinRoomButton) joinRoomButton.disabled = true;

    updateTurnBanner();
  });

  gameSocket.on("roomJoined", data => {
    if (gameSocket !== socket) return;

    onlineRoomCode = data.code;
    onlinePlayerColor = data.color;
    onlineGameActive = false;

    movePending = false;
    gameOver = false;
    mustContinue = null;
    selected = null;
    legalMoves = [];

    if (roomInfo) {
      roomInfo.textContent = `Você entrou na sala ${data.code}.`;
    }

    if (blackPlayerLabel) {
      blackPlayerLabel.textContent =
        data.color === "black"
          ? "Você (pretas)"
          : "Jogador 1 (pretas)";
    }

    if (whitePlayerLabel) {
      whitePlayerLabel.textContent =
        data.color === "white"
          ? "Você (brancas)"
          : "Jogador 2 (brancas)";
    }

    if (createRoomButton) createRoomButton.disabled = true;
    if (joinRoomButton) joinRoomButton.disabled = true;

    updateTurnBanner();
  });

  gameSocket.on("gameReady", data => {
    if (gameSocket !== socket) return;

    board = data.board;
    turn = data.turn;

    selected = null;
    legalMoves = [];
    mustContinue = null;
    gameOver = false;
    movePending = false;
    onlineGameActive = true;

    if (roomInfo) {
      roomInfo.textContent = data.message || "Partida iniciada!";
    }

    if (statusElement) {
      statusElement.textContent = "Partida iniciada.";
    }

    render();
  });

  gameSocket.on("boardUpdate", data => {
    if (gameSocket !== socket) return;

    board = data.board;
    turn = data.turn;
    mustContinue = data.mustContinue || null;
    gameOver = Boolean(data.gameOver);

    selected = null;
    legalMoves = [];
    movePending = false;

    if (gameOver && statusElement) {
      statusElement.textContent =
        data.message ||
        (data.winner === onlinePlayerColor
          ? "Você venceu!"
          : "Você perdeu!");
    } else if (data.message && statusElement) {
      statusElement.textContent = data.message;
    }

    render();
    updateTurnBanner();
  });

  gameSocket.on("moveRejected", message => {
    if (gameSocket !== socket) return;

    movePending = false;
    selected = null;
    legalMoves = [];

    render();

    if (statusElement) {
      statusElement.textContent =
        typeof message === "string"
          ? message
          : "Jogada inválida. Tente novamente.";
    }

    updateTurnBanner();
  });

  gameSocket.on("roomError", message => {
    if (gameSocket !== socket) return;

    if (roomInfo) {
      roomInfo.textContent =
        typeof message === "string"
          ? message
          : "Não foi possível entrar na sala.";
    }
  });

  gameSocket.on("playerLeft", data => {
    if (gameSocket !== socket) return;

    if (roomInfo) {
      roomInfo.textContent =
        data.message || "O adversário saiu da partida.";
    }

    onlineRoomCode = null;
    onlinePlayerColor = null;
    onlineGameActive = false;

    mustContinue = null;
    selected = null;
    legalMoves = [];
    movePending = false;
    gameOver = false;

    if (blackPlayerLabel) {
      blackPlayerLabel.textContent = "Aguardando jogador";
    }

    if (whitePlayerLabel) {
      whitePlayerLabel.textContent = "Aguardando jogador";
    }

    if (createRoomButton) createRoomButton.disabled = false;
    if (joinRoomButton) joinRoomButton.disabled = false;

    newGame();
  });

  gameSocket.on("disconnect", () => {
    if (gameSocket !== socket) return;

    movePending = false;
    connectingSocket = false;

    if (roomInfo) {
      roomInfo.textContent = onlineRoomCode
        ? "Conexão perdida. Tentando reconectar..."
        : "Desconectado do servidor.";
    }

    updateTurnBanner();
  });
}

// ==================================================
// CONEXÃO COM FIREBASE
// ==================================================

function connectGameSocket(token) {
  if (!token) {
    firebaseToken = null;
    connectingSocket = false;

    if (socket) {
      socket.disconnect();
      socket = null;
    }

    if (roomInfo) {
      roomInfo.textContent =
        "Faça login com Google para jogar online.";
    }

    return;
  }

  if (token === firebaseToken && socket) {
    return;
  }

  firebaseToken = token;

  if (socket) {
    socket.disconnect();
    socket = null;
  }

  connectingSocket = true;

  if (roomInfo) {
    roomInfo.textContent = "Conectando ao servidor...";
  }

  const gameSocket = io({
    auth: {
      token: firebaseToken
    }
  });

  socket = gameSocket;

  registerSocketEvents(gameSocket);
}

// O auth.js deve emitir esse evento após login/logout.
window.addEventListener("firebase-user-token", event => {
  connectGameSocket(event.detail?.token || null);
});

// ==================================================
// REINICIAR PARTIDA LOCAL
// ==================================================

if (resetButton) {
  resetButton.addEventListener("click", () => {
    if (onlineRoomCode) {
      if (statusElement) {
        statusElement.textContent =
          "O reinício online está desativado para evitar dessincronização.";
      }

      return;
    }

    newGame();
  });
}

// ==================================================
// INICIALIZAÇÃO
// ==================================================

registerRoomControls();
newGame();

console.log("Script do Damas Online carregado.");
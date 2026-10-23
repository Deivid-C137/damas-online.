
const boardElement = document.getElementById("board");
const statusElement = document.getElementById("status");
const resetButton = document.getElementById("reset");

const socket = io();

const createRoomButton = document.getElementById("create-room");
const joinRoomButton = document.getElementById("join-room");
const roomCodeInput = document.getElementById("room-code");
const roomInfo = document.getElementById("room-info");
const blackPlayerLabel = document.getElementById("black-player");
const whitePlayerLabel = document.getElementById("white-player");

// Elementos visuais opcionais do tema neon.
const turnBanner = document.getElementById("turn-banner");
const turnTitle = document.getElementById("turn-title");
const turnDescription = document.getElementById("turn-description");
const blackCard = document.getElementById("black-card");
const whiteCard = document.getElementById("white-card");

let board;
let turn = "black";
let selected = null;
let legalMoves = [];
let gameOver = false;

let onlineRoomCode = null;
let onlinePlayerColor = null;
let onlineGameActive = false;

// Quando há captura em sequência, a mesma peça deve continuar.
let mustContinue = null;

// Evita enviar várias jogadas antes de receber a resposta do servidor.
let movePending = false;

// ==================================================
// TABULEIRO INICIAL
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
  mustContinue = null;
  gameOver = false;
  movePending = false;

  render();
}

function inside(r, c) {
  return r >= 0 && r < 8 && c >= 0 && c < 8;
}

// ==================================================
// MOVIMENTOS E CAPTURAS
// ==================================================

// Gera os movimentos possíveis de uma peça.
// Damas podem andar várias casas na diagonal.
function movesFor(r, c, capturesOnly = false) {
  if (!inside(r, c) || !board[r][c]) {
    return [];
  }

  const piece = board[r][c];
  const moves = [];
  const directions = [-1, 1];

  for (const dr of directions) {
    for (const dc of directions) {
      let nr = r + dr;
      let nc = c + dc;

      if (!piece.king) {
        // Peças comuns andam para a frente.
        const forward = piece.color === "black" ? 1 : -1;

        if (dr !== forward) continue;

        if (!inside(nr, nc)) continue;

        if (!board[nr][nc]) {
          if (!capturesOnly) {
            moves.push({
              r: nr,
              c: nc,
              capture: null
            });
          }

          continue;
        }

        // Captura de uma peça comum.
        if (board[nr][nc].color !== piece.color) {
          const landR = nr + dr;
          const landC = nc + dc;

          if (
            inside(landR, landC) &&
            !board[landR][landC]
          ) {
            moves.push({
              r: landR,
              c: landC,
              capture: { r: nr, c: nc }
            });
          }
        }

        continue;
      }

      // Dama: percorre a diagonal até encontrar uma peça.
      let enemy = null;

      while (inside(nr, nc)) {
        const occupant = board[nr][nc];

        if (!occupant) {
          if (enemy) {
            // Casas vazias depois da peça inimiga são destinos válidos.
            moves.push({
              r: nr,
              c: nc,
              capture: { r: enemy.r, c: enemy.c }
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

          enemy = { r: nr, c: nc };
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
      if (board[r][c]?.color !== color) continue;

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
      if (board[r][c]?.color !== color) continue;

      if (movesFor(r, c).length > 0) {
        return true;
      }
    }
  }

  return false;
}

// ==================================================
// PAINEL DE TURNO
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
      statusElement.textContent || "A partida terminou.";
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
  if (!boardElement || !statusElement) return;

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

      cell.addEventListener("click", () => clickCell(r, c));
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
  if (gameOver) return;

  if (onlineRoomCode) {
    if (!onlineGameActive) {
      statusElement.textContent =
        "Aguardando o adversário entrar na sala.";
      return;
    }

    clickOnlineCell(r, c);
    return;
  }

  clickLocalCell(r, c);
}

// ==================================================
// JOGO LOCAL
// ==================================================

function clickLocalCell(r, c) {
  const chosenMove = selected &&
    legalMoves.find(m => m.r === r && m.c === c);

  if (chosenMove) {
    const piece = board[selected.r][selected.c];

    board[r][c] = piece;
    board[selected.r][selected.c] = null;

    if (chosenMove.capture) {
      board[chosenMove.capture.r][chosenMove.capture.c] = null;
    }

    if (
      (piece.color === "black" && r === 7) ||
      (piece.color === "white" && r === 0)
    ) {
      piece.king = true;
    }

    selected = null;
    legalMoves = [];

    // Se ainda pode capturar, a vez não muda.
    if (chosenMove.capture && movesFor(r, c, true).length > 0) {
      selected = { r, c };
      legalMoves = movesFor(r, c, true);

      statusElement.textContent = "Continue capturando!";
      render();
      return;
    }

    finishLocalTurn();
    return;
  }

  if (board[r][c]?.color === turn) {
    // Durante a sequência, só pode selecionar a mesma peça.
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
  turn = turn === "black" ? "white" : "black";

  if (!hasAnyMove(turn)) {
    gameOver = true;
    statusElement.textContent =
      `Fim de jogo! ${turn === "black" ? "Brancas" : "Pretas"} venceram!`;
  }

  render();
}

// ==================================================
// JOGO ONLINE
// O servidor continua sendo responsável por validar
// as jogadas e sincronizar os dois jogadores.
// ==================================================

function clickOnlineCell(r, c) {
  if (movePending) {
    statusElement.textContent =
      "Aguarde a confirmação da jogada.";
    return;
  }

  if (turn !== onlinePlayerColor) {
    statusElement.textContent = "Aguarde a sua vez.";
    return;
  }

  const chosenMove = selected &&
    legalMoves.find(m => m.r === r && m.c === c);

  if (chosenMove) {
    movePending = true;

    socket.emit("moveAttempt", {
      from: { r: selected.r, c: selected.c },
      to: { r, c }
    });

    statusElement.textContent = "Enviando jogada...";
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
// REINICIAR PARTIDA LOCAL
// ==================================================

if (resetButton) {
  resetButton.addEventListener("click", () => {
    if (onlineRoomCode) {
      statusElement.textContent =
        "O reinício online está desativado para evitar dessincronização.";
      return;
    }

    newGame();
  });
}

// Inicia uma partida local ao abrir a página.
newGame();

// ==================================================
// CONEXÃO COM O SERVIDOR
// ==================================================

socket.on("connect", () => {
  roomInfo.textContent =
    "Conectado ao servidor. Crie ou entre em uma sala.";
});

socket.on("connect_error", () => {
  roomInfo.textContent =
    "Não foi possível conectar ao servidor.";
});

// ==================================================
// CRIAR SALA
// ==================================================

createRoomButton.addEventListener("click", () => {
  if (!socket.connected) {
    roomInfo.textContent =
      "Aguarde a conexão com o servidor.";
    return;
  }

  if (onlineRoomCode) {
    roomInfo.textContent = "Você já está em uma sala.";
    return;
  }

  socket.emit("createRoom");
});

// ==================================================
// ENTRAR EM SALA
// ==================================================

joinRoomButton.addEventListener("click", () => {
  const code = roomCodeInput.value.trim().toUpperCase();

  if (!socket.connected) {
    roomInfo.textContent =
      "Aguarde a conexão com o servidor.";
    return;
  }

  if (!code) {
    roomInfo.textContent = "Digite o código da sala.";
    return;
  }

  if (onlineRoomCode) {
    roomInfo.textContent = "Você já está em uma sala.";
    return;
  }

  socket.emit("joinRoom", code);
});

roomCodeInput.addEventListener("input", () => {
  roomCodeInput.value = roomCodeInput.value
    .toUpperCase()
    .replace(/[^A-HJ-NP-Z2-9]/g, "");
});

// ==================================================
// RESPOSTA: SALA CRIADA
// ==================================================

socket.on("roomCreated", (data) => {
  onlineRoomCode = data.code;
  onlinePlayerColor = data.color;
  onlineGameActive = false;
  movePending = false;

  roomCodeInput.value = data.code;
  roomInfo.textContent =
    `Sua sala: ${data.code}. Compartilhe o código com o adversário.`;

  blackPlayerLabel.textContent =
    data.color === "black" ? "Você (pretas)" : "Jogador 1 (pretas)";

  whitePlayerLabel.textContent = "Aguardando adversário";

  createRoomButton.disabled = true;
  joinRoomButton.disabled = true;

  updateTurnBanner();
});

// ==================================================
// RESPOSTA: ENTROU NA SALA
// ==================================================

socket.on("roomJoined", (data) => {
  onlineRoomCode = data.code;
  onlinePlayerColor = data.color;
  onlineGameActive = false;
  movePending = false;

  roomInfo.textContent = `Você entrou na sala ${data.code}.`;

  blackPlayerLabel.textContent = "Jogador 1 (pretas)";
  whitePlayerLabel.textContent =
    data.color === "white" ? "Você (brancas)" : "Jogador 2 (brancas)";

  createRoomButton.disabled = true;
  joinRoomButton.disabled = true;

  updateTurnBanner();
});

// ==================================================
// PARTIDA PRONTA
// ==================================================

socket.on("gameReady", (data) => {
  board = data.board;
  turn = data.turn;
  selected = null;
  legalMoves = [];
  mustContinue = null;
  gameOver = false;
  movePending = false;
  onlineGameActive = true;

  render();

  roomInfo.textContent =
    data.message || "Partida iniciada!";

  statusElement.textContent = "Partida iniciada. Vez das pretas.";
  updateTurnBanner();
});

// ==================================================
// TABULEIRO ATUALIZADO PELO SERVIDOR
// ==================================================

socket.on("boardUpdate", (data) => {
  board = data.board;
  turn = data.turn;

  // O servidor informa se uma captura precisa continuar.
  mustContinue = data.mustContinue || null;

  selected = null;
  legalMoves = [];
  movePending = false;

  render();

  if (data.message) {
    statusElement.textContent = data.message;
  }

  updateTurnBanner();
});

// ==================================================
// JOGADA RECUSADA PELO SERVIDOR
// ==================================================

socket.on("moveRejected", (message) => {
  movePending = false;
  selected = null;
  legalMoves = [];

  render();

  statusElement.textContent =
    typeof message === "string"
      ? message
      : "Jogada inválida. Tente novamente.";

  updateTurnBanner();
});

// ==================================================
// ERROS DE SALA
// ==================================================

socket.on("roomError", (message) => {
  roomInfo.textContent =
    typeof message === "string"
      ? message
      : "Não foi possível entrar na sala.";
});

// ==================================================
// ADVERSÁRIO SAIU
// ==================================================

socket.on("playerLeft", (data) => {
  roomInfo.textContent =
    data.message || "O adversário saiu da partida.";

  onlineRoomCode = null;
  onlinePlayerColor = null;
  onlineGameActive = false;
  mustContinue = null;
  selected = null;
  legalMoves = [];
  movePending = false;
  gameOver = false;

  blackPlayerLabel.textContent = "Aguardando jogador";
  whitePlayerLabel.textContent = "Aguardando jogador";

  createRoomButton.disabled = false;
  joinRoomButton.disabled = false;

  newGame();
});

// ==================================================
// DESCONECTOU DO SERVIDOR
// ==================================================

socket.on("disconnect", () => {
  movePending = false;

  if (onlineRoomCode) {
    roomInfo.textContent =
      "Conexão perdida. Tentando reconectar ao servidor...";
  } else {
    roomInfo.textContent = "Desconectado do servidor.";
  }

  updateTurnBanner();
});

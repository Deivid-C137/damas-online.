
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

let board;
let turn = "black";
let selected = null;
let legalMoves = [];
let gameOver = false;

let onlineRoomCode = null;
let onlinePlayerColor = null;
let onlineGameActive = false;
let mustContinue = null;

// =====================================================
// TABULEIRO
// =====================================================

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

  render();
  statusElement.textContent = "Vez das pretas";
}

function inside(r, c) {
  return r >= 0 && r < 8 && c >= 0 && c < 8;
}

function cloneBoard(sourceBoard) {
  return sourceBoard.map(row =>
    row.map(piece =>
      piece
        ? { color: piece.color, king: piece.king }
        : null
    )
  );
}

function promotionRow(color) {
  return color === "black" ? 7 : 0;
}

// =====================================================
// MOVIMENTOS E CAPTURAS
// =====================================================

const DIAGONALS = [
  [-1, -1],
  [-1, 1],
  [1, -1],
  [1, 1]
];

function simpleMovesFor(sourceBoard, r, c) {
  const piece = sourceBoard[r]?.[c];

  if (!piece) return [];

  const moves = [];

  // A dama pode andar várias casas na diagonal.
  if (piece.king) {
    for (const [dr, dc] of DIAGONALS) {
      let nr = r + dr;
      let nc = c + dc;

      while (
        inside(nr, nc) &&
        !sourceBoard[nr][nc]
      ) {
        moves.push({
          r: nr,
          c: nc,
          capture: null
        });

        nr += dr;
        nc += dc;
      }
    }

    return moves;
  }

  // A peça comum anda para frente.
  const forward = piece.color === "black" ? 1 : -1;

  for (const dc of [-1, 1]) {
    const nr = r + forward;
    const nc = c + dc;

    if (
      inside(nr, nc) &&
      !sourceBoard[nr][nc]
    ) {
      moves.push({
        r: nr,
        c: nc,
        capture: null
      });
    }
  }

  return moves;
}

function capturesFor(sourceBoard, r, c) {
  const piece = sourceBoard[r]?.[c];

  if (!piece) return [];

  const moves = [];

  // Peça comum: captura para frente ou para trás.
  if (!piece.king) {
    for (const [dr, dc] of DIAGONALS) {
      const enemyR = r + dr;
      const enemyC = c + dc;
      const landR = r + dr * 2;
      const landC = c + dc * 2;

      if (
        inside(enemyR, enemyC) &&
        inside(landR, landC) &&
        sourceBoard[enemyR][enemyC] &&
        sourceBoard[enemyR][enemyC].color !== piece.color &&
        !sourceBoard[landR][landC]
      ) {
        moves.push({
          r: landR,
          c: landC,
          capture: {
            r: enemyR,
            c: enemyC
          }
        });
      }
    }

    return moves;
  }

  // Dama: encontra a primeira peça na diagonal.
  // Se for inimiga, pode pousar em qualquer casa vazia
  // depois dela, na mesma diagonal.
  for (const [dr, dc] of DIAGONALS) {
    let nr = r + dr;
    let nc = c + dc;
    let enemy = null;

    while (inside(nr, nc)) {
      const occupant = sourceBoard[nr][nc];

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
        }

        nr += dr;
        nc += dc;
        continue;
      }

      if (occupant.color === piece.color || enemy) {
        break;
      }

      enemy = {
        r: nr,
        c: nc
      };

      nr += dr;
      nc += dc;
    }
  }

  return moves;
}

function simulateMove(sourceBoard, fromR, fromC, move) {
  const nextBoard = cloneBoard(sourceBoard);
  const piece = nextBoard[fromR][fromC];

  nextBoard[fromR][fromC] = null;
  nextBoard[move.r][move.c] = piece;

  if (move.capture) {
    nextBoard[move.capture.r][move.capture.c] = null;
  }

  let promoted = false;

  if (
    !piece.king &&
    move.r === promotionRow(piece.color)
  ) {
    piece.king = true;
    promoted = true;
  }

  return {
    board: nextBoard,
    promoted
  };
}

// Calcula a maior quantidade de capturas possíveis
// a partir de uma peça.
function maxCapturesFrom(sourceBoard, r, c) {
  const captures = capturesFor(sourceBoard, r, c);

  if (captures.length === 0) return 0;

  let best = 0;

  for (const move of captures) {
    const result = simulateMove(
      sourceBoard,
      r,
      c,
      move
    );

    // A promoção encerra a sequência nesta versão.
    const total = result.promoted
      ? 1
      : 1 + maxCapturesFrom(
          result.board,
          move.r,
          move.c
        );

    best = Math.max(best, total);
  }

  return best;
}

function allCapturesForColor(color) {
  const options = [];
  let globalMaximum = 0;

  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      if (board[r][c]?.color !== color) continue;

      const pieceMaximum = maxCapturesFrom(
        board,
        r,
        c
      );

      if (pieceMaximum > globalMaximum) {
        globalMaximum = pieceMaximum;
        options.length = 0;
      }

      if (
        pieceMaximum > 0 &&
        pieceMaximum === globalMaximum
      ) {
        options.push({ r, c });
      }
    }
  }

  return {
    pieces: options,
    maximum: globalMaximum
  };
}

function legalMovesForPiece(r, c, continuing = false) {
  const captures = capturesFor(board, r, c);

  if (continuing || captures.length > 0) {
    if (captures.length === 0) return [];

    const best = maxCapturesFrom(board, r, c);

    return captures.filter(move => {
      const result = simulateMove(
        board,
        r,
        c,
        move
      );

      const total = result.promoted
        ? 1
        : 1 + maxCapturesFrom(
            result.board,
            move.r,
            move.c
          );

      return total === best;
    });
  }

  return simpleMovesFor(board, r, c);
}

function movesFor(r, c, capturesOnly = false) {
  if (capturesOnly) {
    return capturesFor(board, r, c);
  }

  return legalMovesForPiece(r, c, false);
}

function allCaptures(color) {
  return allCapturesForColor(color).pieces;
}

function hasAnyMove(color) {
  const captureInfo = allCapturesForColor(color);

  if (captureInfo.maximum > 0) {
    return true;
  }

  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      if (
        board[r][c]?.color === color &&
        simpleMovesFor(board, r, c).length > 0
      ) {
        return true;
      }
    }
  }

  return false;
}

// =====================================================
// DESENHAR TABULEIRO
// =====================================================

function render() {
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

      if (
        selected?.r === r &&
        selected?.c === c
      ) {
        cell.classList.add("selected");
      }

      if (
        legalMoves.some(
          move => move.r === r && move.c === c
        )
      ) {
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

      cell.addEventListener(
        "click",
        () => clickCell(r, c)
      );

      boardElement.appendChild(cell);
    }
  }

  if (!gameOver && !onlineRoomCode) {
    statusElement.textContent =
      `Vez das ${turn === "black" ? "pretas" : "brancas"}`;
  } else if (
    !gameOver &&
    onlineRoomCode &&
    onlineGameActive
  ) {
    statusElement.textContent =
      turn === onlinePlayerColor
        ? "Sua vez de jogar."
        : "Vez do adversário.";
  }
}

// =====================================================
// CLIQUES NO TABULEIRO
// =====================================================

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

function clickLocalCell(r, c) {
  const chosenMove = selected &&
    legalMoves.find(
      move => move.r === r && move.c === c
    );

  if (chosenMove) {
    const from = {
      r: selected.r,
      c: selected.c
    };

    const result = simulateMove(
      board,
      from.r,
      from.c,
      chosenMove
    );

    board = result.board;
    selected = null;
    legalMoves = [];

    if (
      chosenMove.capture &&
      !result.promoted &&
      capturesFor(
        board,
        chosenMove.r,
        chosenMove.c
      ).length > 0
    ) {
      selected = {
        r: chosenMove.r,
        c: chosenMove.c
      };

      legalMoves = legalMovesForPiece(
        chosenMove.r,
        chosenMove.c,
        true
      );

      render();
      statusElement.textContent =
        "Continue capturando com a mesma peça!";
      return;
    }

    turn = turn === "black" ? "white" : "black";

    if (!hasAnyMove(turn)) {
      gameOver = true;

      statusElement.textContent =
        `Fim de jogo! ${turn === "black" ? "Brancas" : "Pretas"} venceram!`;
    }

    render();
    return;
  }

  if (board[r][c]?.color === turn) {
    const captureInfo = allCapturesForColor(turn);

    if (
      captureInfo.maximum > 0 &&
      !captureInfo.pieces.some(
        piece => piece.r === r && piece.c === c
      )
    ) {
      statusElement.textContent =
        `Captura obrigatória: faça a maior captura possível (${captureInfo.maximum}).`;
      return;
    }

    selected = { r, c };

    legalMoves = legalMovesForPiece(r, c, false);

    render();

    if (legalMoves.length === 0) {
      statusElement.textContent =
        "Essa peça não tem movimentos disponíveis.";
    }
  } else {
    selected = null;
    legalMoves = [];
    render();
  }
}

// =====================================================
// JOGADAS ONLINE
// O servidor valida cada jogada e envia o tabuleiro.
// =====================================================

function clickOnlineCell(r, c) {
  if (gameOver) return;

  if (turn !== onlinePlayerColor) {
    statusElement.textContent = "Aguarde a sua vez.";
    return;
  }

  const chosenMove = selected &&
    legalMoves.find(
      move => move.r === r && move.c === c
    );

  if (chosenMove) {
    socket.emit("moveAttempt", {
      from: {
        r: selected.r,
        c: selected.c
      },
      to: { r, c }
    });

    statusElement.textContent = "Enviando jogada...";
    return;
  }

  if (board[r][c]?.color === onlinePlayerColor) {
    if (
      mustContinue &&
      (
        r !== mustContinue.r ||
        c !== mustContinue.c
      )
    ) {
      statusElement.textContent =
        "Continue a captura com a mesma peça.";
      return;
    }

    const captureInfo = allCapturesForColor(turn);

    if (
      !mustContinue &&
      captureInfo.maximum > 0 &&
      !captureInfo.pieces.some(
        piece => piece.r === r && piece.c === c
      )
    ) {
      statusElement.textContent =
        `Captura obrigatória: faça a maior captura possível (${captureInfo.maximum}).`;
      return;
    }

    selected = { r, c };

    legalMoves = legalMovesForPiece(
      r,
      c,
      Boolean(mustContinue)
    );

    render();

    if (legalMoves.length === 0) {
      statusElement.textContent =
        "Essa peça não tem movimentos disponíveis.";
    }

    return;
  }

  selected = null;
  legalMoves = [];
  render();
}

// =====================================================
// REINICIAR JOGO LOCAL
// =====================================================

resetButton.addEventListener("click", () => {
  if (onlineRoomCode) {
    statusElement.textContent =
      "Para não dessincronizar a partida, o reinício online está desativado.";
    return;
  }

  newGame();
});

newGame();

// =====================================================
// CONEXÃO E SALAS ONLINE
// =====================================================

socket.on("connect", () => {
  roomInfo.textContent =
    "Conectado ao servidor. Crie ou entre em uma sala.";
});

socket.on("connect_error", () => {
  roomInfo.textContent =
    "Não foi possível conectar ao servidor.";
});

createRoomButton.addEventListener("click", () => {
  if (!socket.connected) {
    roomInfo.textContent =
      "Aguarde a conexão com o servidor.";
    return;
  }

  if (onlineRoomCode) {
    roomInfo.textContent =
      "Você já está em uma sala.";
    return;
  }

  socket.emit("createRoom");
});

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
    roomInfo.textContent =
      "Você já está em uma sala.";
    return;
  }

  socket.emit("joinRoom", code);
});

roomCodeInput.addEventListener("input", () => {
  roomCodeInput.value = roomCodeInput.value
    .toUpperCase()
    .replace(/[^A-HJ-NP-Z2-9]/g, "");
});

socket.on("roomCreated", data => {
  onlineRoomCode = data.code;
  onlinePlayerColor = data.color;
  onlineGameActive = false;

  roomCodeInput.value = data.code;

  roomInfo.textContent =
    `Sua sala: ${data.code}. Compartilhe esse código com o adversário.`;

  blackPlayerLabel.textContent = "Você (pretas)";
  whitePlayerLabel.textContent = "Aguardando adversário";

  createRoomButton.disabled = true;
  joinRoomButton.disabled = true;
});

socket.on("roomJoined", data => {
  onlineRoomCode = data.code;
  onlinePlayerColor = data.color;
  onlineGameActive = false;

  roomInfo.textContent =
    `Você entrou na sala ${data.code}.`;

  blackPlayerLabel.textContent = "Jogador 1 (pretas)";
  whitePlayerLabel.textContent = "Você (brancas)";

  createRoomButton.disabled = true;
  joinRoomButton.disabled = true;
});

socket.on("gameReady", data => {
  board = data.board;
  turn = data.turn;
  selected = null;
  legalMoves = [];
  mustContinue = null;
  gameOver = false;
  onlineGameActive = true;

  render();

  roomInfo.textContent =
    data.message || "Partida iniciada!";

  statusElement.textContent =
    "Partida iniciada. Vez das pretas.";
});

socket.on("boardUpdate", data => {
  board = data.board;
  turn = data.turn;
  mustContinue = data.mustContinue || null;
  gameOver = Boolean(data.gameOver);

  selected = null;
  legalMoves = [];

  render();

  if (data.message) {
    statusElement.textContent = data.message;
  }

  if (gameOver && data.winner) {
    statusElement.textContent =
      `Fim de jogo! ${data.winner === "black" ? "Pretas" : "Brancas"} venceram!`;
  }
});

socket.on("moveRejected", message => {
  selected = null;
  legalMoves = [];

  render();

  statusElement.textContent =
    typeof message === "string"
      ? message
      : "Jogada não permitida.";
});

socket.on("roomError", message => {
  roomInfo.textContent = message;
});

socket.on("playerLeft", data => {
  roomInfo.textContent = data.message;

  onlineRoomCode = null;
  onlinePlayerColor = null;
  onlineGameActive = false;
  mustContinue = null;
  selected = null;
  legalMoves = [];

  blackPlayerLabel.textContent = "Aguardando jogador";
  whitePlayerLabel.textContent = "Aguardando jogador";

  createRoomButton.disabled = false;
  joinRoomButton.disabled = false;

  newGame();
});

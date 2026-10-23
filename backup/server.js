
const express = require("express");
const http = require("http");
const path = require("path");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;
const rooms = new Map();

app.use(express.static(__dirname));

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

// ==========================================
// TABULEIRO
// ==========================================

function createInitialBoard() {
  const board = Array.from(
    { length: 8 },
    () => Array(8).fill(null)
  );

  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 8; c++) {
      if ((r + c) % 2 === 1) {
        board[r][c] = { color: "black", king: false };
      }
    }
  }

  for (let r = 5; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      if ((r + c) % 2 === 1) {
        board[r][c] = { color: "white", king: false };
      }
    }
  }

  return board;
}

function inside(r, c) {
  return r >= 0 && r < 8 && c >= 0 && c < 8;
}

function cloneBoard(board) {
  return board.map(row =>
    row.map(piece => piece ? { ...piece } : null)
  );
}

function promotionRow(color) {
  return color === "white" ? 0 : 7;
}

function promoteIfNeeded(piece, r) {
  if (!piece.king && r === promotionRow(piece.color)) {
    piece.king = true;
    return true;
  }

  return false;
}

const DIRECTIONS = [
  [-1, -1],
  [-1, 1],
  [1, -1],
  [1, 1]
];

// ==========================================
// MOVIMENTOS SIMPLES
// ==========================================

function simpleMovesFor(board, r, c) {
  const piece = board[r][c];

  if (!piece) return [];

  const moves = [];

  const directions = piece.king
    ? DIRECTIONS
    : DIRECTIONS.filter(([dr]) =>
        dr === (piece.color === "white" ? -1 : 1)
      );

  for (const [dr, dc] of directions) {
    let nr = r + dr;
    let nc = c + dc;

    if (!piece.king) {
      if (inside(nr, nc) && !board[nr][nc]) {
        moves.push({
          r: nr,
          c: nc,
          capture: false
        });
      }

      continue;
    }

    // A dama pode andar por toda a diagonal livre.
    while (inside(nr, nc) && !board[nr][nc]) {
      moves.push({
        r: nr,
        c: nc,
        capture: false
      });

      nr += dr;
      nc += dc;
    }
  }

  return moves;
}

// ==========================================
// CAPTURAS
// ==========================================

function captureMovesFor(board, r, c) {
  const piece = board[r][c];

  if (!piece) return [];

  const moves = [];

  // Peça comum: captura para frente e para trás.
  if (!piece.king) {
    for (const [dr, dc] of DIRECTIONS) {
      const enemyR = r + dr;
      const enemyC = c + dc;
      const landR = r + dr * 2;
      const landC = c + dc * 2;

      if (
        inside(enemyR, enemyC) &&
        inside(landR, landC) &&
        board[enemyR][enemyC] &&
        board[enemyR][enemyC].color !== piece.color &&
        !board[landR][landC]
      ) {
        moves.push({
          r: landR,
          c: landC,
          capture: true,
          capturedR: enemyR,
          capturedC: enemyC
        });
      }
    }

    return moves;
  }

  // Dama: captura a primeira peça adversária na diagonal.
  for (const [dr, dc] of DIRECTIONS) {
    let nr = r + dr;
    let nc = c + dc;

    while (inside(nr, nc) && !board[nr][nc]) {
      nr += dr;
      nc += dc;
    }

    if (
      !inside(nr, nc) ||
      board[nr][nc].color === piece.color
    ) {
      continue;
    }

    const capturedR = nr;
    const capturedC = nc;

    nr += dr;
    nc += dc;

    // Pode pousar em qualquer casa livre depois da peça capturada.
    while (inside(nr, nc) && !board[nr][nc]) {
      moves.push({
        r: nr,
        c: nc,
        capture: true,
        capturedR,
        capturedC
      });

      nr += dr;
      nc += dc;
    }
  }

  return moves;
}

// Executa um movimento e informa se houve promoção.
function applyMove(board, from, move) {
  const piece = board[from.r][from.c];

  board[move.r][move.c] = piece;
  board[from.r][from.c] = null;

  if (move.capture) {
    board[move.capturedR][move.capturedC] = null;
  }

  return promoteIfNeeded(piece, move.r);
}

// ==========================================
// CÁLCULO DE CAPTURAS MÚLTIPLAS
// ==========================================

function maxCapturesFrom(board, r, c) {
  const captures = captureMovesFor(board, r, c);

  if (captures.length === 0) return 0;

  let best = 0;

  for (const move of captures) {
    const nextBoard = cloneBoard(board);

    const promoted = applyMove(
      nextBoard,
      { r, c },
      move
    );

    const remaining = promoted
      ? 0
      : maxCapturesFrom(nextBoard, move.r, move.c);

    best = Math.max(best, 1 + remaining);
  }

  return best;
}

function maximumCapturesForColor(board, color) {
  let maximum = 0;

  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      if (board[r][c]?.color === color) {
        maximum = Math.max(
          maximum,
          maxCapturesFrom(board, r, c)
        );
      }
    }
  }

  return maximum;
}

// ==========================================
// JOGADAS PERMITIDAS
// ==========================================

function legalMovesFor(board, color, mustContinue) {
  // Se estiver numa sequência de capturas,
  // somente a mesma peça pode continuar.
  if (mustContinue) {
    const { r, c } = mustContinue;
    const piece = board[r]?.[c];

    if (!piece || piece.color !== color) return [];

    const captures = captureMovesFor(board, r, c);
    const maximum = maxCapturesFrom(board, r, c);

    return captures.filter(move => {
      const nextBoard = cloneBoard(board);

      const promoted = applyMove(
        nextBoard,
        { r, c },
        move
      );

      const remaining = promoted
        ? 0
        : maxCapturesFrom(nextBoard, move.r, move.c);

      return 1 + remaining === maximum;
    });
  }

  const captures = [];
  let maximum = 0;

  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      if (board[r][c]?.color !== color) continue;

      const pieceCaptures = captureMovesFor(board, r, c);

      if (pieceCaptures.length > 0) {
        const count = maxCapturesFrom(board, r, c);

        maximum = Math.max(maximum, count);

        for (const move of pieceCaptures) {
          captures.push({
            from: { r, c },
            move,
            count
          });
        }
      }
    }
  }

  // Captura obrigatória e maior sequência de capturas.
  if (captures.length > 0) {
    return captures
      .filter(item => item.count === maximum)
      .map(item => ({
        from: item.from,
        ...item.move
      }));
  }

  // Se não houver captura, permite movimentos simples.
  const moves = [];

  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      if (board[r][c]?.color !== color) continue;

      for (const move of simpleMovesFor(board, r, c)) {
        moves.push({
          from: { r, c },
          ...move
        });
      }
    }
  }

  return moves;
}

function hasPieces(board, color) {
  return board.some(row =>
    row.some(piece => piece?.color === color)
  );
}

// ==========================================
// SALAS
// ==========================================

function createRoomCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code;

  do {
    code = "";

    for (let i = 0; i < 6; i++) {
      code += chars[Math.floor(Math.random() * chars.length)];
    }
  } while (rooms.has(code));

  return code;
}

function sendGameState(code, message) {
  const room = rooms.get(code);

  if (!room) return;

  io.to(code).emit("boardUpdate", {
    board: room.board,
    turn: room.turn,
    mustContinue: room.mustContinue
      ? {
          r: room.mustContinue.r,
          c: room.mustContinue.c
        }
      : null,
    gameOver: room.status === "finished",
    winner: room.winner || null,
    message
  });
}

function finishIfNeeded(room) {
  const opponent = room.turn;

  const possibleMoves = legalMovesFor(
    room.board,
    opponent,
    room.mustContinue
  );

  if (
    !hasPieces(room.board, opponent) ||
    possibleMoves.length === 0
  ) {
    room.status = "finished";
    room.winner = opponent === "black" ? "white" : "black";

    return room.winner === "black"
      ? "Fim de jogo! As pretas venceram!"
      : "Fim de jogo! As brancas venceram!";
  }

  return null;
}

// ==========================================
// GERENCIAMENTO DE SAÍDA
// ==========================================

function leaveCurrentRoom(socket) {
  const code = socket.data.roomCode;

  if (!code) return;

  const room = rooms.get(code);

  delete socket.data.roomCode;
  delete socket.data.playerColor;

  socket.leave(code);

  if (!room) return;

  for (const playerId of room.players) {
    if (playerId === socket.id) continue;

    const other = io.sockets.sockets.get(playerId);

    if (other) {
      other.emit("playerLeft", {
        message: "O adversário saiu. Crie uma nova sala."
      });

      delete other.data.roomCode;
      delete other.data.playerColor;

      other.leave(code);
    }
  }

  rooms.delete(code);

  console.log(`Sala ${code} encerrada.`);
}

// ==========================================
// CONEXÕES SOCKET.IO
// ==========================================

io.on("connection", socket => {
  console.log("Jogador conectado:", socket.id);

  // Criar uma sala.
  socket.on("createRoom", () => {
    if (socket.data.roomCode) {
      socket.emit("roomError", "Você já está em uma sala.");
      return;
    }

    const code = createRoomCode();

    rooms.set(code, {
      players: [socket.id],
      status: "waiting",
      board: createInitialBoard(),
      turn: "black",
      mustContinue: null,
      winner: null
    });

    socket.join(code);

    socket.data.roomCode = code;
    socket.data.playerColor = "black";

    socket.emit("roomCreated", {
      code,
      color: "black",
      message: "Sala criada. Aguardando o adversário."
    });

    console.log(`Sala ${code} criada.`);
  });

  // Entrar numa sala.
  socket.on("joinRoom", rawCode => {
    if (socket.data.roomCode) {
      socket.emit("roomError", "Você já está em uma sala.");
      return;
    }

    const code = String(rawCode || "").trim().toUpperCase();
    const room = rooms.get(code);

    if (!room) {
      socket.emit("roomError", "Sala não encontrada.");
      return;
    }

    if (room.status !== "waiting" || room.players.length >= 2) {
      socket.emit("roomError", "Essa sala já está cheia.");
      return;
    }

    room.players.push(socket.id);
    room.status = "playing";

    socket.join(code);

    socket.data.roomCode = code;
    socket.data.playerColor = "white";

    socket.emit("roomJoined", {
      code,
      color: "white",
      message: "Você entrou na sala."
    });

    io.to(code).emit("gameReady", {
      code,
      board: room.board,
      turn: room.turn,
      message: "Os dois jogadores estão conectados."
    });

    console.log(`Sala ${code} iniciada.`);
  });

  // Receber e validar uma jogada.
  socket.on("moveAttempt", data => {
    const code = socket.data.roomCode;
    const room = rooms.get(code);

    if (!room || room.status !== "playing") {
      socket.emit("moveRejected", "A partida não está ativa.");
      return;
    }

    if (room.turn !== socket.data.playerColor) {
      socket.emit("moveRejected", "Não é a sua vez.");
      return;
    }

    const from = data?.from;
    const to = data?.to;

    if (
      !from ||
      !to ||
      !Number.isInteger(from.r) ||
      !Number.isInteger(from.c) ||
      !Number.isInteger(to.r) ||
      !Number.isInteger(to.c) ||
      !inside(from.r, from.c) ||
      !inside(to.r, to.c)
    ) {
      socket.emit("moveRejected", "Movimento inválido.");
      return;
    }

    const piece = room.board[from.r][from.c];

    if (!piece || piece.color !== socket.data.playerColor) {
      socket.emit("moveRejected", "Essa peça não é sua.");
      return;
    }

    if (room.board[to.r][to.c]) {
      socket.emit("moveRejected", "A casa de destino está ocupada.");
      return;
    }

    if (
      room.mustContinue &&
      (
        from.r !== room.mustContinue.r ||
        from.c !== room.mustContinue.c
      )
    ) {
      socket.emit(
        "moveRejected",
        "Continue capturando com a mesma peça."
      );
      return;
    }

    const legalMoves = legalMovesFor(
      room.board,
      room.turn,
      room.mustContinue
    );

    const move = legalMoves.find(candidate =>
      candidate.from.r === from.r &&
      candidate.from.c === from.c &&
      candidate.r === to.r &&
      candidate.c === to.c
    );

    if (!move) {
      socket.emit(
        "moveRejected",
        "Movimento inválido. Confira as capturas obrigatórias."
      );
      return;
    }

    const promoted = applyMove(room.board, from, move);

    // Mantém a vez do jogador se houver outra captura.
    if (
      move.capture &&
      !promoted &&
      captureMovesFor(room.board, to.r, to.c).length > 0
    ) {
      room.mustContinue = {
        r: to.r,
        c: to.c
      };

      sendGameState(
        code,
        "Continue capturando com a mesma peça."
      );

      return;
    }

    // Sequência concluída: passa a vez ao adversário.
    room.mustContinue = null;
    room.turn = room.turn === "black" ? "white" : "black";

    const endMessage = finishIfNeeded(room);

    sendGameState(
      code,
      endMessage ||
        (room.turn === "black"
          ? "Vez das pretas."
          : "Vez das brancas.")
    );
  });

  // Saída voluntária.
  socket.on("leaveRoom", () => {
    leaveCurrentRoom(socket);
  });

  // Registrar a causa de uma desconexão.
  socket.on("disconnect", reason => {
    console.log("=== DESCONEXÃO DETECTADA ===");
    console.log("Jogador:", socket.id);
    console.log("Motivo:", reason);
    console.log("Sala:", socket.data.roomCode || "Nenhuma");

    leaveCurrentRoom(socket);
  });
});

// ==========================================
// INICIAR SERVIDOR
// ==========================================

server.listen(PORT, () => {
  console.log(`Servidor DAMAS iniciado em http://localhost:${PORT}`);
});

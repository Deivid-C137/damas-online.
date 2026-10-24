
const express = require("express");
const http = require("http");
const path = require("path");
const { Server } = require("socket.io");

const { initializeApp, getApps, cert } = require("firebase-admin/app");
const { getAuth } = require("firebase-admin/auth");

// ==========================================
// FIREBASE ADMIN
// Render: FIREBASE_SERVICE_ACCOUNT
// Local: firebase-service-account.json
// ==========================================

let firebaseAuth;

try {
  if (getApps().length === 0) {
    let serviceAccount;

    if (process.env.FIREBASE_SERVICE_ACCOUNT) {
      serviceAccount = JSON.parse(
        process.env.FIREBASE_SERVICE_ACCOUNT
      );
    } else {
      serviceAccount = require("./firebase-service-account.json");
    }

    initializeApp({
      credential: cert(serviceAccount)
    });
  }

  firebaseAuth = getAuth();
  console.log("Firebase Admin inicializado com sucesso.");
} catch (error) {
  console.error(
    "Erro ao inicializar o Firebase Admin:",
    error.message
  );
  process.exit(1);
}

// ==========================================
// SERVIDOR HTTP E SOCKET.IO
// ==========================================

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: true,
    credentials: true
  }
});

const PORT = process.env.PORT || 3000;

app.use(express.static(__dirname));

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

app.get("/health", (req, res) => {
  res.status(200).json({
    status: "online",
    jogo: "Damas Online"
  });
});

// ==========================================
// SALAS
// ==========================================

const rooms = new Map();

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

function generateRoomCode() {
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

function inside(r, c) {
  return r >= 0 && r < 8 && c >= 0 && c < 8;
}

function otherColor(color) {
  return color === "black" ? "white" : "black";
}

// ==========================================
// MOVIMENTOS E CAPTURAS
// ==========================================

function movesFor(board, r, c, capturesOnly = false) {
  if (!inside(r, c) || !board[r][c]) return [];

  const piece = board[r][c];
  const moves = [];

  for (const dr of [-1, 1]) {
    for (const dc of [-1, 1]) {
      let nr = r + dr;
      let nc = c + dc;

      // Peça comum
      if (!piece.king) {
        const forward = piece.color === "black" ? 1 : -1;

        if (dr !== forward || !inside(nr, nc)) continue;

        if (!board[nr][nc]) {
          if (!capturesOnly) {
            moves.push({ r: nr, c: nc, capture: null });
          }
          continue;
        }

        if (board[nr][nc].color !== piece.color) {
          const landR = nr + dr;
          const landC = nc + dc;

          if (inside(landR, landC) && !board[landR][landC]) {
            moves.push({
              r: landR,
              c: landC,
              capture: { r: nr, c: nc }
            });
          }
        }

        continue;
      }

      // Dama: percorre as diagonais e pode capturar à distância
      let enemy = null;

      while (inside(nr, nc)) {
        const occupant = board[nr][nc];

        if (!occupant) {
          if (enemy) {
            moves.push({
              r: nr,
              c: nc,
              capture: { r: enemy.r, c: enemy.c }
            });
          } else if (!capturesOnly) {
            moves.push({ r: nr, c: nc, capture: null });
          }
        } else {
          if (occupant.color === piece.color || enemy) break;

          enemy = { r: nr, c: nc };
        }

        nr += dr;
        nc += dc;
      }
    }
  }

  return moves;
}

function allCaptures(board, color) {
  const result = [];

  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      if (board[r][c]?.color !== color) continue;

      if (movesFor(board, r, c, true).length > 0) {
        result.push({ r, c });
      }
    }
  }

  return result;
}

function hasAnyMove(board, color) {
  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      if (board[r][c]?.color !== color) continue;

      if (movesFor(board, r, c).length > 0) return true;
    }
  }

  return false;
}

function broadcastBoard(room, message = "") {
  io.to(room.code).emit("boardUpdate", {
    board: room.board,
    turn: room.turn,
    mustContinue: room.mustContinue,
    gameOver: room.gameOver,
    winner: room.winner,
    message
  });
}

// ==========================================
// AUTENTICAÇÃO FIREBASE
// ==========================================

io.use(async (socket, next) => {
  try {
    const token = socket.handshake.auth?.token;

    if (!token || typeof token !== "string") {
      return next(
        new Error("Faça login com o Google antes de jogar.")
      );
    }

    const decodedToken = await firebaseAuth.verifyIdToken(token);

    socket.data.user = {
      uid: decodedToken.uid,
      email: decodedToken.email || "",
      name: decodedToken.name || "Jogador"
    };

    next();
  } catch (error) {
    console.error("Falha ao verificar token Firebase:", error.message);

    next(
      new Error(
        "Login inválido ou expirado. Entre novamente com o Google."
      )
    );
  }
});

// ==========================================
// CONEXÃO DOS JOGADORES
// ==========================================

io.on("connection", socket => {
  console.log(
    "Jogador conectado:",
    socket.data.user.name,
    "|",
    socket.data.user.uid
  );

  // Criar sala
  socket.on("createRoom", () => {
    if (socket.data.roomCode) {
      socket.emit("roomError", "Você já está em uma sala.");
      return;
    }

    const code = generateRoomCode();

    const room = {
      code,
      players: {
        black: socket.id,
        white: null
      },
      board: createInitialBoard(),
      turn: "black",
      mustContinue: null,
      gameOver: false,
      winner: null
    };

    rooms.set(code, room);
    socket.join(code);

    socket.data.roomCode = code;
    socket.data.color = "black";

    socket.emit("roomCreated", {
      code,
      color: "black"
    });

    console.log("Sala criada:", code);
  });

  // Entrar em sala
  socket.on("joinRoom", input => {
    if (socket.data.roomCode) {
      socket.emit("roomError", "Você já está em uma sala.");
      return;
    }

    const code = String(
      typeof input === "string" ? input : input?.code || ""
    ).trim().toUpperCase();

    if (!code) {
      socket.emit("roomError", "Digite o código da sala.");
      return;
    }

    const room = rooms.get(code);

    if (!room) {
      socket.emit("roomError", "Sala não encontrada.");
      return;
    }

    if (room.players.white || room.gameOver) {
      socket.emit("roomError", "Esta sala não está disponível.");
      return;
    }

    room.players.white = socket.id;

    socket.join(code);
    socket.data.roomCode = code;
    socket.data.color = "white";

    socket.emit("roomJoined", {
      code,
      color: "white"
    });

    io.to(code).emit("gameReady", {
      board: room.board,
      turn: room.turn,
      message: "Partida iniciada!"
    });

    console.log("Partida iniciada na sala:", code);
  });

  // Receber e validar jogadas
  socket.on("moveAttempt", move => {
    const code = socket.data.roomCode;
    const color = socket.data.color;
    const room = rooms.get(code);

    if (!room || !color) {
      socket.emit("moveRejected", "Você não está em uma sala.");
      return;
    }

    if (room.gameOver) {
      socket.emit("moveRejected", "A partida já terminou.");
      return;
    }

    if (!room.players.white) {
      socket.emit("moveRejected", "Aguardando o adversário.");
      return;
    }

    if (room.turn !== color) {
      socket.emit("moveRejected", "Não é a sua vez.");
      return;
    }

    if (
      !move?.from ||
      !move?.to ||
      !Number.isInteger(move.from.r) ||
      !Number.isInteger(move.from.c) ||
      !Number.isInteger(move.to.r) ||
      !Number.isInteger(move.to.c) ||
      !inside(move.from.r, move.from.c) ||
      !inside(move.to.r, move.to.c)
    ) {
      socket.emit("moveRejected", "Movimento inválido.");
      return;
    }

    const from = move.from;
    const to = move.to;
    const piece = room.board[from.r][from.c];

    if (!piece || piece.color !== color) {
      socket.emit("moveRejected", "Essa peça não é sua.");
      return;
    }

    if (room.board[to.r][to.c]) {
      socket.emit("moveRejected", "A casa de destino está ocupada.");
      return;
    }

    if (
      room.mustContinue &&
      (from.r !== room.mustContinue.r ||
        from.c !== room.mustContinue.c)
    ) {
      socket.emit(
        "moveRejected",
        "Você precisa continuar a captura com a mesma peça."
      );
      return;
    }

    const captures = allCaptures(room.board, color);

    if (
      !room.mustContinue &&
      captures.length > 0 &&
      !captures.some(p => p.r === from.r && p.c === from.c)
    ) {
      socket.emit(
        "moveRejected",
        "Captura obrigatória: escolha uma peça que possa capturar."
      );
      return;
    }

    const possibleMoves = movesFor(
      room.board,
      from.r,
      from.c,
      Boolean(room.mustContinue) || captures.length > 0
    );

    const chosenMove = possibleMoves.find(
      m => m.r === to.r && m.c === to.c
    );

    if (!chosenMove) {
      socket.emit("moveRejected", "Jogada inválida.");
      return;
    }

    // Executar jogada
    room.board[to.r][to.c] = piece;
    room.board[from.r][from.c] = null;

    if (chosenMove.capture) {
      room.board[chosenMove.capture.r][chosenMove.capture.c] = null;
    }

    // Promover a dama
    if (
      (piece.color === "black" && to.r === 7) ||
      (piece.color === "white" && to.r === 0)
    ) {
      piece.king = true;
    }

    // Captura múltipla: a mesma peça continua jogando
    if (
      chosenMove.capture &&
      movesFor(room.board, to.r, to.c, true).length > 0
    ) {
      room.mustContinue = { r: to.r, c: to.c };
      broadcastBoard(room, "Continue capturando com a mesma peça.");
      return;
    }

    room.mustContinue = null;
    room.turn = otherColor(room.turn);

    if (!hasAnyMove(room.board, room.turn)) {
      room.gameOver = true;
      room.winner = color;

      broadcastBoard(
        room,
        color === "black"
          ? "Fim de jogo! Pretas venceram!"
          : "Fim de jogo! Brancas venceram!"
      );

      console.log("Partida encerrada. Vencedor:", color);
      return;
    }

    broadcastBoard(
      room,
      room.turn === "black" ? "Vez das pretas." : "Vez das brancas."
    );
  });

  // Saída voluntária
  socket.on("leaveRoom", () => {
    leaveCurrentRoom(socket);
  });

  // Desconexão
  socket.on("disconnect", reason => {
    console.log(
      "Jogador desconectado:",
      socket.id,
      "| Motivo:",
      reason
    );

    leaveCurrentRoom(socket);
  });
});

// ==========================================
// REMOVER JOGADOR DA SALA
// ==========================================

function leaveCurrentRoom(socket) {
  const code = socket.data.roomCode;

  if (!code) return;

  const room = rooms.get(code);

  socket.leave(code);

  delete socket.data.roomCode;
  delete socket.data.color;

  if (!room) return;

  const color =
    room.players.black === socket.id
      ? "black"
      : room.players.white === socket.id
        ? "white"
        : null;

  if (!color) return;

  room.players[color] = null;

  socket.to(code).emit("playerLeft", {
    message: "O adversário saiu da partida."
  });

  // A sala é removida quando um jogador sai.
  // Isso impede que um jogador novo entre numa partida abandonada.
  rooms.delete(code);

  console.log("Sala encerrada após saída de jogador:", code);
}

// ==========================================
// INICIAR SERVIDOR
// ==========================================

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Damas Online rodando na porta ${PORT}`);
});


const express = require("express");
const http = require("http");
const path = require("path");
const crypto = require("crypto");
const { Server } = require("socket.io");
const { cert, initializeApp, getApps } = require("firebase-admin/app");
const { getAuth } = require("firebase-admin/auth");

// ==================================================
// CONFIGURAÇÃO DO SERVIDOR
// ==================================================

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;
const rooms = new Map();

// Inicializa o Firebase Admin para autenticação Google.
// O arquivo de credenciais não deve ser publicado.
try {
  if (getApps().length === 0) {
    const serviceAccount = require("./firebase-service-account.json");

    initializeApp({
      credential: cert(serviceAccount)
    });
  }
} catch (error) {
  console.error(
    "Erro ao inicializar o Firebase Admin:",
    error.message
  );
  process.exit(1);
}

app.use(express.static(__dirname));

app.get("/", (_req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

app.get("/health", (_req, res) => {
  res.json({
    status: "online",
    rooms: rooms.size
  });
});

// ==================================================
// AUTENTICAÇÃO OPCIONAL
// ==================================================

io.use(async (socket, next) => {
  try {
    const token = socket.handshake.auth?.token;

    // Sem token: jogador convidado.
    if (!token) {
      socket.user = {
        uid: `guest-${crypto.randomUUID()}`,
        name: "Convidado",
        email: ""
      };

      socket.data.isGuest = true;
      return next();
    }

    // Com token: validar a conta no Firebase.
    const decoded = await getAuth().verifyIdToken(token);

    socket.user = {
      uid: decoded.uid,
      name: decoded.name || "Jogador",
      email: decoded.email || ""
    };

    socket.data.isGuest = false;
    return next();
  } catch (error) {
    console.error("Falha na autenticação:", error.message);
    return next(
      new Error("Login inválido. Entre novamente com o Google.")
    );
  }
});

// ==================================================
// FUNÇÕES DO JOGO
// ==================================================

function inside(r, c) {
  return Number.isInteger(r) &&
    Number.isInteger(c) &&
    r >= 0 && r < 8 &&
    c >= 0 && c < 8;
}

function otherColor(color) {
  return color === "black" ? "white" : "black";
}

function createInitialBoard() {
  const board = Array.from(
    { length: 8 },
    () => Array(8).fill(null)
  );

  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 8; c++) {
      if ((r + c) % 2 === 1) {
        board[r][c] = {
          color: "black",
          king: false
        };
      }
    }
  }

  for (let r = 5; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      if ((r + c) % 2 === 1) {
        board[r][c] = {
          color: "white",
          king: false
        };
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
      code += chars[
        crypto.randomInt(0, chars.length)
      ];
    }
  } while (rooms.has(code));

  return code;
}

// ==================================================
// MOVIMENTOS E CAPTURAS
// ==================================================

function movesFor(board, r, c, capturesOnly = false) {
  if (!inside(r, c) || !board[r][c]) {
    return [];
  }

  const piece = board[r][c];
  const moves = [];
  const directions = [
    [-1, -1],
    [-1, 1],
    [1, -1],
    [1, 1]
  ];

  for (const [dr, dc] of directions) {
    if (!piece.king) {
      const nr = r + dr;
      const nc = c + dc;
      const forward = piece.color === "white" ? -1 : 1;

      // Movimento simples para a frente.
      if (
        !capturesOnly &&
        dr === forward &&
        inside(nr, nc) &&
        !board[nr][nc]
      ) {
        moves.push({
          r: nr,
          c: nc,
          capture: null
        });
      }

      // Captura para a frente ou para trás.
      const lr = r + 2 * dr;
      const lc = c + 2 * dc;

      if (
        inside(nr, nc) &&
        inside(lr, lc) &&
        board[nr][nc] &&
        board[nr][nc].color !== piece.color &&
        !board[lr][lc]
      ) {
        moves.push({
          r: lr,
          c: lc,
          capture: { r: nr, c: nc }
        });
      }

      continue;
    }

    // Dama percorre as diagonais.
    let nr = r + dr;
    let nc = c + dc;
    let enemy = null;

    while (inside(nr, nc)) {
      const target = board[nr][nc];

      if (target) {
        if (target.color === piece.color || enemy) {
          break;
        }

        enemy = { r: nr, c: nc };
      } else if (enemy) {
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

      nr += dr;
      nc += dc;
    }
  }

  return moves;
}

function allCaptures(board, color) {
  const captures = [];

  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      const piece = board[r][c];

      if (!piece || piece.color !== color) {
        continue;
      }

      for (const move of movesFor(board, r, c, true)) {
        if (move.capture) {
          captures.push({
            from: { r, c },
            to: { r: move.r, c: move.c }
          });
        }
      }
    }
  }

  return captures;
}

function hasAnyMove(board, color) {
  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      const piece = board[r][c];

      if (
        piece &&
        piece.color === color &&
        movesFor(board, r, c).length > 0
      ) {
        return true;
      }
    }
  }

  return false;
}

// ==================================================
// SALA E ESTADO PÚBLICO
// ==================================================

function publicRoomState(room) {
  return {
    code: room.code,
    board: room.board,
    turn: room.turn,
    players: {
      black: room.players.black
        ? room.players.black.name
        : null,
      white: room.players.white
        ? room.players.white.name
        : null
    },
    gameOver: room.gameOver,
    winner: room.winner,
    mustContinue: room.mustContinue
  };
}

function broadcastBoard(room) {
  io.to(room.code).emit(
    "boardUpdate",
    publicRoomState(room)
  );
}

function getRoomForSocket(socket) {
  if (!socket.roomCode) {
    return null;
  }

  const room = rooms.get(socket.roomCode);

  if (!room) {
    return null;
  }

  const color = room.playerColors.get(socket.id);

  if (!color) {
    return null;
  }

  return { room, color };
}

function removePlayerFromRoom(socket, notify = true) {
  const result = getRoomForSocket(socket);

  if (!result) {
    socket.roomCode = null;
    return;
  }

  const { room, color } = result;
  const player = room.players[color];

  if (player && player.socketId === socket.id) {
    room.players[color] = null;
  }

  room.playerColors.delete(socket.id);
  socket.roomCode = null;

  if (notify) {
    socket.to(room.code).emit("playerLeft", {
      message: `${socket.user.name} saiu da partida.`
    });
  }

  // Mantém a sala aberta para o jogador restante.
  // Se ficar vazia, remove a sala.
  if (!room.players.white && !room.players.black) {
    rooms.delete(room.code);
  } else {
    broadcastBoard(room);
  }
}

// ==================================================
// CONEXÃO DOS JOGADORES
// ==================================================

io.on("connection", (socket) => {
  console.log(
    "Jogador conectado:",
    socket.user.name,
    socket.data.isGuest ? "(convidado)" : "(Google)"
  );

  // ------------------------------------------------
  // CRIAR SALA
  // ------------------------------------------------

  socket.on("createRoom", () => {
    if (socket.roomCode) {
      socket.emit(
        "roomError",
        "Você já está em uma sala."
      );
      return;
    }

    const code = generateRoomCode();

    const room = {
      code,
      board: createInitialBoard(),
      turn: "white",
      players: {
        white: {
          uid: socket.user.uid,
          name: socket.user.name,
          socketId: socket.id
        },
        black: null
      },
      playerColors: new Map([
        [socket.id, "white"]
      ]),
      mustContinue: null,
      gameOver: false,
      winner: null
    };

    rooms.set(code, room);
    socket.join(code);
    socket.roomCode = code;

    socket.emit("roomCreated", {
      code,
      color: "white"
    });

    socket.emit(
      "gameReady",
      publicRoomState(room)
    );

    broadcastBoard(room);

    console.log(
      `Sala ${code} criada por ${socket.user.name}`
    );
  });

  // ------------------------------------------------
  // ENTRAR EM SALA
  // ------------------------------------------------

  socket.on("joinRoom", (rawCode) => {
    if (socket.roomCode) {
      socket.emit(
        "roomError",
        "Você já está em uma sala."
      );
      return;
    }

    const code = String(rawCode || "")
      .trim()
      .toUpperCase();

    if (!/^[A-HJ-NP-Z2-9]{6}$/.test(code)) {
      socket.emit(
        "roomError",
        "Código inválido. Confira os seis caracteres."
      );
      return;
    }

    const room = rooms.get(code);

    if (!room) {
      socket.emit(
        "roomError",
        "Sala não encontrada."
      );
      return;
    }

    if (room.gameOver) {
      socket.emit(
        "roomError",
        "Esta partida já terminou."
      );
      return;
    }

    if (room.players.white && room.players.black) {
      socket.emit(
        "roomError",
        "Esta sala já está cheia."
      );
      return;
    }

    const alreadyPlaying = Object.values(room.players)
      .some((player) =>
        player &&
        player.uid === socket.user.uid
      );

    if (alreadyPlaying) {
      socket.emit(
        "roomError",
        "Este jogador já está nesta partida."
      );
      return;
    }

    const color = room.players.white
      ? "black"
      : "white";

    room.players[color] = {
      uid: socket.user.uid,
      name: socket.user.name,
      socketId: socket.id
    };

    room.playerColors.set(socket.id, color);
    socket.join(code);
    socket.roomCode = code;

    socket.emit("roomJoined", {
      code,
      color
    });

    io.to(code).emit(
      "gameReady",
      publicRoomState(room)
    );

    broadcastBoard(room);

    console.log(
      `${socket.user.name} entrou na sala ${code} como ${color}`
    );
  });

  // ------------------------------------------------
  // MOVIMENTAR PEÇA
  // ------------------------------------------------

  socket.on("moveAttempt", (data) => {
    const result = getRoomForSocket(socket);

    if (!result) {
      socket.emit(
        "moveRejected",
        "Você não está em uma sala."
      );
      return;
    }

    const { room, color } = result;

    if (room.gameOver) {
      socket.emit(
        "moveRejected",
        "A partida já terminou."
      );
      return;
    }

    if (!room.players.white || !room.players.black) {
      socket.emit(
        "moveRejected",
        "Aguardando o segundo jogador."
      );
      return;
    }

    if (room.turn !== color) {
      socket.emit(
        "moveRejected",
        "Não é sua vez."
      );
      return;
    }

    const from = data && data.from;
    const to = data && data.to;

    if (
      !from ||
      !to ||
      !inside(from.r, from.c) ||
      !inside(to.r, to.c) ||
      (from.r === to.r && from.c === to.c)
    ) {
      socket.emit(
        "moveRejected",
        "Coordenadas inválidas."
      );
      return;
    }

    const piece = room.board[from.r][from.c];

    if (!piece || piece.color !== color) {
      socket.emit(
        "moveRejected",
        "Essa peça não é sua."
      );
      return;
    }

    if (
      room.mustContinue &&
      (
        room.mustContinue.r !== from.r ||
        room.mustContinue.c !== from.c
      )
    ) {
      socket.emit(
        "moveRejected",
        "Continue capturando com a mesma peça."
      );
      return;
    }

    const move = movesFor(
      room.board,
      from.r,
      from.c
    ).find((candidate) =>
      candidate.r === to.r &&
      candidate.c === to.c
    );

    if (!move) {
      socket.emit(
        "moveRejected",
        "Movimento inválido."
      );
      return;
    }

    // Captura obrigatória.
    if (
      allCaptures(room.board, color).length > 0 &&
      !move.capture
    ) {
      socket.emit(
        "moveRejected",
        "Você precisa capturar uma peça."
      );
      return;
    }

    if (room.mustContinue && !move.capture) {
      socket.emit(
        "moveRejected",
        "Você precisa continuar capturando."
      );
      return;
    }

    // Executa o movimento.
    room.board[to.r][to.c] = piece;
    room.board[from.r][from.c] = null;

    if (move.capture) {
      room.board[move.capture.r][move.capture.c] = null;
    }

    // Promove a peça a dama.
    if (
      (piece.color === "white" && to.r === 0) ||
      (piece.color === "black" && to.r === 7)
    ) {
      piece.king = true;
    }

    // Verifica se a captura continua com a mesma peça.
    if (move.capture) {
      const furtherCaptures = movesFor(
        room.board,
        to.r,
        to.c,
        true
      ).filter((candidate) => candidate.capture);

      if (furtherCaptures.length > 0) {
        room.mustContinue = {
          r: to.r,
          c: to.c
        };

        broadcastBoard(room);
        return;
      }
    }

    room.mustContinue = null;
    room.turn = otherColor(color);

    // Verifica se o adversário ainda pode jogar.
    if (!hasAnyMove(room.board, room.turn)) {
      room.gameOver = true;
      room.winner = color;
    }

    broadcastBoard(room);

    if (room.gameOver) {
      io.to(room.code).emit("gameOver", {
        winner: room.winner,
        winnerName: room.players[room.winner]
          ? room.players[room.winner].name
          : "Jogador"
      });

      console.log(
        `Partida ${room.code} encerrada. Vencedor: ${room.winner}`
      );
    }
  });

  // ------------------------------------------------
  // SAIR DA SALA
  // ------------------------------------------------

  socket.on("leaveRoom", () => {
    const code = socket.roomCode;

    removePlayerFromRoom(socket);

    if (code) {
      socket.leave(code);
    }
  });

  // ------------------------------------------------
  // DESCONECTAR
  // ------------------------------------------------

  socket.on("disconnect", (reason) => {
    console.log(
      "Jogador desconectado:",
      socket.user.name,
      `(${reason})`
    );

    removePlayerFromRoom(socket);
  });
});

// ==================================================
// INICIALIZAÇÃO
// ==================================================

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Damas Online rodando na porta ${PORT}`);
  console.log(`Acesse: http://localhost:${PORT}`);
});

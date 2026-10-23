
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;

// ==================================================
// CONFIGURAÇÃO DO SITE
// ==================================================

app.use(express.static(path.join(__dirname)));

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

// ==================================================
// SALAS E PARTIDAS
// ==================================================

const rooms = new Map();

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
  const characters = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code;

  do {
    code = "";

    for (let i = 0; i < 6; i++) {
      code += characters[
        Math.floor(Math.random() * characters.length)
      ];
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

// ==================================================
// REGRAS E MOVIMENTOS
// ==================================================

function movesFor(board, r, c, capturesOnly = false) {
  if (!inside(r, c) || !board[r][c]) {
    return [];
  }

  const piece = board[r][c];
  const moves = [];

  for (const dr of [-1, 1]) {
    for (const dc of [-1, 1]) {
      let nr = r + dr;
      let nc = c + dc;

      if (!piece.king) {
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

      // Dama: percorre as diagonais.
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

      if (movesFor(board, r, c).length > 0) {
        return true;
      }
    }
  }

  return false;
}

// ==================================================
// ENVIAR ESTADO DA PARTIDA
// ==================================================

function broadcastBoard(room, message = "") {
  const data = {
    board: room.board,
    turn: room.turn,
    mustContinue: room.mustContinue,
    gameOver: room.gameOver,
    winner: room.winner,
    message
  };

  io.to(room.code).emit("boardUpdate", data);
}

// ==================================================
// CRIAR SALA
// ==================================================

io.on("connection", socket => {
  console.log("Jogador conectado:", socket.id);

  socket.on("createRoom", () => {
    // Evita criar várias salas com o mesmo jogador.
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

  // ==================================================
  // ENTRAR EM SALA
  // ==================================================

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

    const startData = {
      board: room.board,
      turn: room.turn,
      message: "Partida iniciada!"
    };

    io.to(code).emit("gameReady", startData);

    console.log("Dois jogadores na sala:", code);
  });

  // ==================================================
  // RECEBER E VALIDAR JOGADA
  // ==================================================

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
      !move ||
      !move.from ||
      !move.to ||
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
      (
        from.r !== room.mustContinue.r ||
        from.c !== room.mustContinue.c
      )
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

    // Executa a jogada validada.
    room.board[to.r][to.c] = piece;
    room.board[from.r][from.c] = null;

    if (chosenMove.capture) {
      room.board[chosenMove.capture.r][chosenMove.capture.c] = null;
    }

    // Promove a peça a dama.
    if (
      (piece.color === "black" && to.r === 7) ||
      (piece.color === "white" && to.r === 0)
    ) {
      piece.king = true;
    }

    // Continua capturando com a mesma peça, se possível.
    if (
      chosenMove.capture &&
      movesFor(room.board, to.r, to.c, true).length > 0
    ) {
      room.mustContinue = {
        r: to.r,
        c: to.c
      };

      broadcastBoard(room, "Continue capturando com a mesma peça.");
      return;
    }

    room.mustContinue = null;

    // Passa a vez ao adversário.
    room.turn = otherColor(room.turn);

    // Verifica se o adversário ainda pode jogar.
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

    broadcastBoard(room);
  });

  // ==================================================
  // DESCONECTAR
  // ==================================================

  socket.on("disconnect", () => {
    console.log("Jogador desconectado:", socket.id);

    const code = socket.data.roomCode;
    if (!code) return;

    const room = rooms.get(code);
    if (!room) return;

    const color = socket.data.color;

    // Avisa o outro jogador que o adversário saiu.
    socket.to(code).emit("playerLeft", {
      message: "O adversário saiu da partida."
    });

    // Remove a sala para não deixar partidas abandonadas.
    rooms.delete(code);
  });
});

// ==================================================
// INICIAR SERVIDOR
// ==================================================

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Damas Online rodando na porta ${PORT}`);
  console.log(`Acesse: http://localhost:${PORT}`);
});

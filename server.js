
"use strict";
require("dotenv").config();
const express = require("express");
const http = require("http");
const path = require("path");
const crypto = require("crypto");
const { Pool } = require("pg");

const { Server } = require("socket.io");
const {
  initializeApp,
  cert,
  getApps
} = require("firebase-admin/app");
const { getAuth } = require("firebase-admin/auth");

// ======================================================
// CONFIGURAÇÃO
// ======================================================

const app = express();
const httpServer = http.createServer(app);

const io = new Server(httpServer, {
  cors: { origin: true, methods: ["GET", "POST"] },
  pingInterval: 25000,
  pingTimeout: 20000
});

const PORT = Number(process.env.PORT) || 3000;
// ======================================================
// CONEXÃO COM O POSTGRESQL — SUPABASE
// ======================================================

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === "true"
    ? { rejectUnauthorized: false }
    : false,
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000
});

pool.on("error", error => {
  console.error("[PostgreSQL] Erro inesperado:", error.message);
});
async function getOrCreateWallet(uid) {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const created = await client.query(
      `INSERT INTO public.wallet_accounts (firebase_uid, balance)
       VALUES ($1, 500.00)
       ON CONFLICT (firebase_uid) DO NOTHING
       RETURNING firebase_uid`,
      [uid]
    );

    // Só registra os 500 créditos se a carteira acabou de ser criada.
    if (created.rowCount === 1) {
      await client.query(
        `INSERT INTO public.wallet_transactions
         (firebase_uid, type, amount, description)
         VALUES ($1, $2, $3, $4)`,
        [uid, "initial_credit", 500.00, "Crédito inicial da carteira"]
      );
    }

    const result = await client.query(
      `SELECT balance
       FROM public.wallet_accounts
       WHERE firebase_uid = $1`,
      [uid]
    );

    await client.query("COMMIT");

    return result.rows[0].balance;

  } catch (error) {
    await client.query("ROLLBACK");
    throw error;

  } finally {
    client.release();
  }
}
async function getWalletBalance(uid) {
  const result = await pool.query(
    `SELECT balance
     FROM public.wallet_accounts
     WHERE firebase_uid = $1`,
    [uid]
  );

  if (result.rowCount === 0) {
    throw new Error("Carteira do jogador não encontrada.");
  }

  return Number(result.rows[0].balance);
}
const SIZE = 8;
const BLACK = "black";
const WHITE = "white";
const RECONNECT_GRACE_MS = 120000;

const rooms = new Map();
const socketRooms = new Map();
const userSockets = new Map();
const reconnectTimers = new Map();

const ROOM_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

// ======================================================
// FIREBASE ADMIN
// ======================================================

let firebaseReady = false;

function initializeFirebase() {
  try {
    if (getApps().length > 0) {
      firebaseReady = true;
      console.log("[Firebase] Aplicativo já inicializado.");
      return;
    }

    let serviceAccount;
    const env = process.env.FIREBASE_SERVICE_ACCOUNT;

    if (env) {
      serviceAccount = JSON.parse(env);
    } else {
      serviceAccount = require(
        path.join(__dirname, "firebase-service-account.json")
      );
    }

    initializeApp({ credential: cert(serviceAccount) });
    firebaseReady = true;
    console.log("[Firebase] Inicializado.");
  } catch (error) {
    firebaseReady = false;
    console.error("[Firebase] Erro:", error.message);
  }
}

initializeFirebase();

// ======================================================
// EXPRESS
// ======================================================

app.disable("x-powered-by");
app.use(express.json({ limit: "32kb" }));

app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    service: "damas-online",
    firebaseReady,
    activeRooms: rooms.size,
    timestamp: new Date().toISOString()
  });
});
app.get("/health/db", async (_req, res) => {
  try {
    const result = await pool.query(
      "SELECT NOW() AS database_time"
    );

    res.json({
      status: "ok",
      database: "connected",
      time: result.rows[0].database_time
    });
  } catch (error) {
    console.error("[PostgreSQL] Falha no teste:", error.message);

    res.status(503).json({
      status: "error",
      database: "disconnected"
    });
  }
});
app.use(express.static(__dirname));

app.get(/.*/, (req, res, next) => {
    if (
    req.path.startsWith("/socket.io/") ||
    req.path === "/health" ||
    req.path === "/health/db"
  ) {
    return next();
  }

  res.sendFile(path.join(__dirname, "index.html"), error => {
    if (error && !res.headersSent) {
      res.status(404).send("Página não encontrada.");
    }
  });
});

// ======================================================
// UTILITÁRIOS
// ======================================================

function inside(r, c) {
  return Number.isInteger(r) &&
    Number.isInteger(c) &&
    r >= 0 && r < SIZE &&
    c >= 0 && c < SIZE;
}

function otherColor(color) {
  return color === BLACK ? WHITE : BLACK;
}

function positionKey(r, c) {
  return `${r},${c}`;
}

function cloneBoard(board) {
  return board.map(row => row.map(piece =>
    piece
      ? { color: piece.color, king: Boolean(piece.king) }
      : null
  ));
}

function createInitialBoard() {
  const board = Array.from(
    { length: SIZE },
    () => Array(SIZE).fill(null)
  );

  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < SIZE; c++) {
      if ((r + c) % 2 === 1) {
        board[r][c] = { color: BLACK, king: false };
      }
    }
  }

  for (let r = 5; r < SIZE; r++) {
    for (let c = 0; c < SIZE; c++) {
      if ((r + c) % 2 === 1) {
        board[r][c] = { color: WHITE, king: false };
      }
    }
  }

  return board;
}

function createRoomCode() {
  let code = "";

  for (let i = 0; i < 6; i++) {
    code += ROOM_ALPHABET[
      crypto.randomInt(0, ROOM_ALPHABET.length)
    ];
  }

  return code;
}

function getAvailableRoomCode() {
  for (let i = 0; i < 50; i++) {
    const code = createRoomCode();
    if (!rooms.has(code)) return code;
  }

  throw new Error("Não foi possível gerar um código de sala.");
}

function getSocketRoom(socket) {
  const code = socketRooms.get(socket.id);
  return code ? rooms.get(code) || null : null;
}

function getPlayerColor(room, socketId) {
  if (room.players.black === socketId) return BLACK;
  if (room.players.white === socketId) return WHITE;
  return null;
}

function emitRoomError(socket, message) {
  socket.emit("roomError", { message });
}

function emitMoveRejected(socket, message) {
  socket.emit("moveRejected", { message });
}

function roomSnapshot(room) {
  return {
    code: room.code,
    board: cloneBoard(room.board),
    turn: room.turn,
    mustContinue: room.mustContinue
      ? { ...room.mustContinue }
      : null,
    capturedThisTurn: room.capturedThisTurn.map(pos => ({ ...pos })),
    gameOver: room.gameOver,
    winner: room.winner,
    started: room.started,
    bet: room.bet ? {
  id: room.bet.id,
  amount: room.bet.amount,
  status: room.bet.status
} : null,
    players: {
      black: Boolean(room.players.black),
      white: Boolean(room.players.white)
    }
  };
}

function createRoomState(code, socketId, uid) {
  return {
    code,
    board: createInitialBoard(),
    turn: WHITE,

    players: {
      black: socketId,
      white: null
    },

    playerUids: {
      black: uid,
      white: null
    },

    mustContinue: null,
    capturedThisTurn: [],

    gameOver: false,
winner: null,
started: false,

// SISTEMA DE APOSTAS
bet: null,

    createdAt: Date.now(),
    lastMoveAt: null
  };
}

// ======================================================
// TEMPORIZADORES DE RECONEXÃO
// ======================================================

function clearReconnectTimer(code, color) {
  const key = `${code}:${color}`;
  const timer = reconnectTimers.get(key);

  if (timer) {
    clearTimeout(timer);
    reconnectTimers.delete(key);
  }
}

function scheduleReconnectExpiry(room, color, disconnectedSocketId) {
  const code = room.code;
  const key = `${code}:${color}`;

  clearReconnectTimer(code, color);

  const timer = setTimeout(() => {
    reconnectTimers.delete(key);

    const currentRoom = rooms.get(code);
    if (!currentRoom || currentRoom.gameOver) return;

    // Só encerra a vaga se o jogador ainda estiver desconectado.
    if (currentRoom.players[color] !== null) return;

    if (currentRoom.playerUids[color] === null) return;

    currentRoom.playerUids[color] = null;

    io.to(code).emit("playerLeft", {
      color,
      message: "O prazo para reconexão terminou."
    });

    console.log(
      `[Sala] ${code}: prazo de reconexão expirou para ${color}.`
    );

    // Uma sala sem jogadores conectados pode ser removida.
    if (!currentRoom.players.black && !currentRoom.players.white) {
      deleteRoom(code);
    } else {
      currentRoom.started = false;
    }
  }, RECONNECT_GRACE_MS);

  timer.unref?.();
  reconnectTimers.set(key, timer);
}

function deleteRoom(code) {
  const room = rooms.get(code);
  if (!room) return;

  clearReconnectTimer(code, BLACK);
  clearReconnectTimer(code, WHITE);

  for (const color of [BLACK, WHITE]) {
    const socketId = room.players[color];

    if (socketId) {
      socketRooms.delete(socketId);

      const socket = io.sockets.sockets.get(socketId);
      if (socket) socket.leave(code);
    }
  }

  rooms.delete(code);
  console.log(`[Sala] ${code} removida.`);
}

// ======================================================
// MOVIMENTOS SIMPLES
// ======================================================

function getSimpleMoves(room, r, c) {
  const piece = room.board[r]?.[c];
  if (!piece) return [];

  const moves = [];
  const directions = piece.king
    ? [[-1, -1], [-1, 1], [1, -1], [1, 1]]
    : [[piece.color === BLACK ? 1 : -1, -1],
       [piece.color === BLACK ? 1 : -1, 1]];

  for (const [dr, dc] of directions) {
    let nr = r + dr;
    let nc = c + dc;

    while (inside(nr, nc) && !room.board[nr][nc]) {
      moves.push({ r: nr, c: nc, capture: null });

      if (!piece.king) break;

      nr += dr;
      nc += dc;
    }
  }

  return moves;
}

// ======================================================
// CAPTURAS
// ======================================================

function getCaptures(room, r, c) {
  const piece = room.board[r]?.[c];
  if (!piece) return [];

  const board = room.board;
  const captures = [];

  const alreadyCaptured = new Set(
    (room.capturedThisTurn || []).map(pos =>
      positionKey(pos.r, pos.c)
    )
  );

  const directions = [
    [-1, -1], [-1, 1], [1, -1], [1, 1]
  ];

  for (const [dr, dc] of directions) {
    let nr = r + dr;
    let nc = c + dc;

    if (!piece.king) {
      if (!inside(nr, nc)) continue;

      const target = board[nr][nc];

      if (!target || target.color === piece.color) continue;
      if (alreadyCaptured.has(positionKey(nr, nc))) continue;

      const landR = nr + dr;
      const landC = nc + dc;

      if (inside(landR, landC) && !board[landR][landC]) {
        captures.push({
          r: landR,
          c: landC,
          capture: { r: nr, c: nc }
        });
      }

      continue;
    }

    let enemy = null;

    while (inside(nr, nc)) {
      const occupant = board[nr][nc];

      if (!occupant) {
        if (enemy) {
          captures.push({
            r: nr,
            c: nc,
            capture: { r: enemy.r, c: enemy.c }
          });
        }
      } else {
        if (occupant.color === piece.color || enemy) break;

        if (alreadyCaptured.has(positionKey(nr, nc))) break;

        enemy = { r: nr, c: nc };
      }

      nr += dr;
      nc += dc;
    }
  }

  return captures;
}

function getAllCaptures(room, color) {
  const result = [];

  for (let r = 0; r < SIZE; r++) {
    for (let c = 0; c < SIZE; c++) {
      const piece = room.board[r][c];

      if (!piece || piece.color !== color) continue;

      for (const move of getCaptures(room, r, c)) {
        result.push({
          from: { r, c },
          to: { r: move.r, c: move.c },
          capture: move.capture
        });
      }
    }
  }

  return result;
}

// ======================================================
// CAPTURA MÁXIMA
// ======================================================

function countMaximumCaptures(board, r, c, captured = []) {
  const piece = board[r]?.[c];
  if (!piece) return 0;

  const simulatedRoom = {
    board,
    capturedThisTurn: captured
  };

  const moves = getCaptures(simulatedRoom, r, c);
  let maximum = 0;

  for (const move of moves) {
    const nextBoard = cloneBoard(board);
    const movingPiece = nextBoard[r][c];

    nextBoard[r][c] = null;
    nextBoard[move.r][move.c] = movingPiece;

    const nextCaptured = [
      ...captured,
      { r: move.capture.r, c: move.capture.c }
    ];

    const continuation = countMaximumCaptures(
      nextBoard,
      move.r,
      move.c,
      nextCaptured
    );

    maximum = Math.max(maximum, 1 + continuation);
  }

  return maximum;
}

function getMaximumCaptureCount(room, color) {
  let maximum = 0;

  for (let r = 0; r < SIZE; r++) {
    for (let c = 0; c < SIZE; c++) {
      const piece = room.board[r][c];

      if (!piece || piece.color !== color) continue;

      maximum = Math.max(
        maximum,
        countMaximumCaptures(room.board, r, c, [])
      );
    }
  }

  return maximum;
}

function getLegalMoves(room, r, c, color) {
  if (!inside(r, c)) return [];

  const piece = room.board[r][c];

  if (!piece || piece.color !== color) return [];

  if (room.mustContinue) {
    if (
      room.mustContinue.r !== r ||
      room.mustContinue.c !== c
    ) {
      return [];
    }

    return getCaptures(room, r, c);
  }

  const allCaptures = getAllCaptures(room, color);

  if (allCaptures.length > 0) {
    const maximum = getMaximumCaptureCount(room, color);

    return allCaptures
      .filter(move =>
        move.from.r === r &&
        move.from.c === c &&
        countMaximumCaptures(room.board, r, c, []) === maximum
      )
      .map(move => ({
        r: move.to.r,
        c: move.to.c,
        capture: move.capture
      }));
  }

  return getSimpleMoves(room, r, c);
}

function hasAnyLegalMove(room, color) {
  if (getAllCaptures(room, color).length > 0) return true;

  for (let r = 0; r < SIZE; r++) {
    for (let c = 0; c < SIZE; c++) {
      const piece = room.board[r][c];

      if (piece && piece.color === color &&
          getSimpleMoves(room, r, c).length > 0) {
        return true;
      }
    }
  }

  return false;
}

function countPieces(room, color) {
  let count = 0;

  for (const row of room.board) {
    for (const piece of row) {
      if (piece && piece.color === color) count++;
    }
  }

  return count;
}

function promotePiece(piece, row) {
  if (!piece || piece.king) return;

  if (
    (piece.color === BLACK && row === SIZE - 1) ||
    (piece.color === WHITE && row === 0)
  ) {
    piece.king = true;
  }
}

function removeCapturedPieces(room) {
  for (const pos of room.capturedThisTurn) {
    if (inside(pos.r, pos.c)) {
      room.board[pos.r][pos.c] = null;
    }
  }

  room.capturedThisTurn = [];
}

// ======================================================
// ESTADO E FIM DA PARTIDA
// ======================================================

function broadcastBoard(room, message) {
  io.to(room.code).emit("boardUpdate", {
    ...roomSnapshot(room),
    message
  });
}
// ======================================================
// VALIDAÇÃO DE APOSTAS
// ======================================================

function validateBetAmount(amount) {
  const value = Number(amount);

  if (!Number.isFinite(value) || value <= 0 || value > 5) {
    return {
      valid: false,
      message: "A aposta deve ser maior que zero e de no máximo 5 créditos."
    };
  }

  return {
    valid: true,
    amount: Math.round(value * 100) / 100
  };
}
// ======================================================
// CRIAR PEDIDO DE APOSTA
// ======================================================
async function createBetRequest(room, creatorUid, amount) {
  const validation = validateBetAmount(amount);

  if (!validation.valid) {
    throw new Error(validation.message);
  }

  if (!room.started || room.gameOver) {
    throw new Error("A partida não está disponível para apostas.");
  }

  if (!room.playerUids.black || !room.playerUids.white) {
    throw new Error("Os dois jogadores precisam estar na sala.");
  }

  if (room.bet) {
    throw new Error("Esta partida já possui uma aposta.");
  }

  const opponentUid = creatorUid === room.playerUids.black
    ? room.playerUids.white
    : creatorUid === room.playerUids.white
      ? room.playerUids.black
      : null;

  if (!opponentUid) {
    throw new Error("Você não pertence a esta partida.");
  }

  const balance = await getWalletBalance(creatorUid);

  if (balance < validation.amount) {
    throw new Error("Saldo insuficiente para essa aposta.");
  }

  let result;

  try {
    result = await pool.query(
      `INSERT INTO public.bets
        (room_code, creator_uid, opponent_uid, amount, status)
       VALUES ($1, $2, $3, $4, 'pending')
       RETURNING id`,
      [room.code, creatorUid, opponentUid, validation.amount]
    );
  } catch (error) {
    if (error.code === "23505") {
      throw new Error(
        "Esta sala já possui uma aposta pendente ou ativa."
      );
    }

    throw error;
  }

  room.bet = {
    id: result.rows[0].id,
    creatorUid,
    opponentUid,
    amount: validation.amount,
    status: "pending"
  };

  return room.bet;
}

// ======================================================
// RESPONDER AO PEDIDO DE APOSTA
// ======================================================

async function respondToBet(room, opponentUid, accepted) {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    if (!room.bet || room.bet.status !== "pending") {
      throw new Error("Não existe uma aposta pendente.");
    }

    if (room.bet.opponentUid !== opponentUid) {
      throw new Error("Somente o adversário pode responder à aposta.");
    }

    if (accepted !== true && accepted !== false) {
      throw new Error("Resposta de aposta inválida.");
    }

    const betResult = await client.query(
      `SELECT *
       FROM public.bets
       WHERE id = $1
       FOR UPDATE`,
      [room.bet.id]
    );

    if (betResult.rowCount !== 1 ||
        betResult.rows[0].status !== "pending") {
      throw new Error("Esta aposta já foi respondida.");
    }

    const bet = betResult.rows[0];

    if (!accepted) {
      await client.query(
        `UPDATE public.bets
         SET status = 'cancelled'
         WHERE id = $1`,
        [bet.id]
      );

      await client.query("COMMIT");

      room.bet.status = "cancelled";

      return {
        accepted: false,
        status: "cancelled",
        message: "A aposta foi recusada."
      };
    }

    const players = [bet.creator_uid, bet.opponent_uid].sort();

    const wallets = await client.query(
      `SELECT firebase_uid, balance
       FROM public.wallet_accounts
       WHERE firebase_uid = ANY($1::text[])
       ORDER BY firebase_uid
       FOR UPDATE`,
      [players]
    );

    if (wallets.rowCount !== 2) {
      throw new Error("Não foi possível localizar as duas carteiras.");
    }

    const amount = Number(bet.amount);

    for (const wallet of wallets.rows) {
      if (Number(wallet.balance) < amount) {
        throw new Error("Um dos jogadores não possui saldo suficiente.");
      }
    }

    for (const uid of players) {
      await client.query(
        `UPDATE public.wallet_accounts
         SET balance = balance - $1,
             updated_at = NOW()
         WHERE firebase_uid = $2`,
        [amount, uid]
      );

      await client.query(
        `INSERT INTO public.bet_transactions
         (bet_id, firebase_uid, type, amount, idempotency_key)
         VALUES ($1, $2, 'stake_reserved', $3, $4)`,
        [bet.id, uid, amount, `bet:${bet.id}:reserve:${uid}`]
      );

      await client.query(
        `INSERT INTO public.wallet_transactions
         (firebase_uid, type, amount, description)
         VALUES ($1, $2, $3, $4)`,
        [uid, "stake_reserved", -amount, `Reserva da aposta ${bet.id}`]
      );
    }

    await client.query(
      `UPDATE public.bets
       SET status = 'reserved',
           accepted_at = NOW()
       WHERE id = $1`,
      [bet.id]
    );

    await client.query("COMMIT");

    room.bet.status = "reserved";

    return {
      accepted: true,
      status: "reserved",
      amount,
      message: "Aposta aceita! Créditos dos dois jogadores reservados."
    };

  } catch (error) {
    await client.query("ROLLBACK");
    throw error;

  } finally {
    client.release();
  }
}
// ======================================================
// PAGAMENTO DO VENCEDOR DA APOSTA
// ======================================================

async function settleBet(room, winnerColor) {
  if (!room.bet || room.bet.status !== "reserved") {
    return null;
  }

  const winnerUid = room.playerUids[winnerColor];

  if (!winnerUid) {
    throw new Error("Não foi possível identificar o vencedor.");
  }

  const betId = room.bet.id;
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const betResult = await client.query(
      `SELECT *
       FROM public.bets
       WHERE id = $1
       FOR UPDATE`,
      [betId]
    );

    if (
      betResult.rowCount !== 1 ||
      betResult.rows[0].status !== "reserved"
    ) {
      await client.query("ROLLBACK");
      return null;
    }

    const bet = betResult.rows[0];

    if (
      winnerUid !== bet.creator_uid &&
      winnerUid !== bet.opponent_uid
    ) {
      throw new Error("O vencedor não pertence a esta aposta.");
    }

    const loserUid =
      winnerUid === bet.creator_uid
        ? bet.opponent_uid
        : bet.creator_uid;

    const amount = Number(bet.amount);
    const commission = Math.round(amount * 10) / 100;
    const payout = amount * 2 - commission;

    const players = [winnerUid, loserUid].sort();

    const wallets = await client.query(
      `SELECT firebase_uid
       FROM public.wallet_accounts
       WHERE firebase_uid = ANY($1::text[])
       ORDER BY firebase_uid
       FOR UPDATE`,
      [players]
    );

    if (wallets.rowCount !== 2) {
      throw new Error("Não foi possível localizar as carteiras.");
    }

    await client.query(
      `UPDATE public.wallet_accounts
       SET balance = balance + $1,
           updated_at = NOW()
       WHERE firebase_uid = $2`,
      [payout, winnerUid]
    );

    await client.query(
      `INSERT INTO public.bet_transactions
       (bet_id, firebase_uid, type, amount, idempotency_key)
       VALUES ($1, $2, 'winner_payout', $3, $4)`,
      [
        betId,
        winnerUid,
        payout,
        `bet:${betId}:payout:${winnerUid}`
      ]
    );

    await client.query(
      `INSERT INTO public.bet_transactions
       (bet_id, firebase_uid, type, amount, idempotency_key)
       VALUES ($1, $2, 'commission', $3, $4)`,
      [
        betId,
        loserUid,
        commission,
        `bet:${betId}:commission`
      ]
    );

    await client.query(
      `INSERT INTO public.wallet_transactions
       (firebase_uid, type, amount, description)
       VALUES ($1, $2, $3, $4)`,
      [
        winnerUid,
        "bet_payout",
        payout,
        `Prêmio da aposta ${betId}, já descontada a comissão`
      ]
    );

    await client.query(
      `UPDATE public.bets
       SET status = 'finished',
           winner_uid = $1,
           settled_at = NOW()
       WHERE id = $2`,
      [winnerUid, betId]
    );

    await client.query("COMMIT");

    room.bet.status = "finished";

    console.log(
      `[Aposta] ${betId}: vencedor recebeu ${payout.toFixed(2)} créditos.`
    );

    return {
      winnerUid,
      loserUid,
      payout,
      commission
    };

  } catch (error) {
    await client.query("ROLLBACK");
    throw error;

  } finally {
    client.release();
  }
}
async function finishGame(room, winner, message) {
  room.gameOver = true;
  room.winner = winner;
  room.mustContinue = null;

  removeCapturedPieces(room);

  let betResult = null;

  try {
    betResult = await settleBet(room, winner);

    // Atualiza o saldo dos dois jogadores.
    if (betResult) {
      for (const uid of [betResult.winnerUid, betResult.loserUid]) {
        const balance = await getWalletBalance(uid);
        const socketIds = userSockets.get(uid) || new Set();

        for (const socketId of socketIds) {
          io.to(socketId).emit("wallet:response", {
            success: true,
            balance
          });
        }
      }

      message += ` Prêmio recebido: ${betResult.payout.toFixed(2)} créditos.`;
    }
  } catch (error) {
    console.error("[Aposta] Erro ao pagar vencedor:", error);

    io.to(room.code).emit("bet:error", {
      message: "A partida terminou, mas houve um erro ao processar o prêmio. Entre em contato com o suporte."
    });
  }

  const result = {
    ...roomSnapshot(room),
    winner,
    gameOver: true,
    message
  };

  io.to(room.code).emit("boardUpdate", result);
  io.to(room.code).emit("gameOver", result);
}
 
async function checkGameEnd(room) {
  if (countPieces(room, BLACK) === 0) {
    await finishGame(room, WHITE, "As brancas venceram!");
    return true;
  }

  if (countPieces(room, WHITE) === 0) {
    await finishGame(room, BLACK, "As pretas venceram!");
    return true;
  }

  if (!hasAnyLegalMove(room, room.turn)) {
    const winner = otherColor(room.turn);

    await finishGame(
      room,
      winner,
      `${winner === BLACK ? "As pretas" : "As brancas"} venceram!`
    );

    return true;
  }

  return false;
}
  

// ======================================================
// JOGADAS
// ======================================================

function parseCoordinate(value) {
  if (!value || typeof value !== "object") return null;

  const r = Number.isInteger(value.r) ? value.r : value.row;
  const c = Number.isInteger(value.c) ? value.c : value.col;

  return inside(r, c) ? { r, c } : null;
}
async function handleMoveAttempt(socket, payload) {
  const room = getSocketRoom(socket);

  if (!room) {
    emitMoveRejected(socket, "Você não está em uma sala.");
    return;
  }

  if (!room.started || room.gameOver) {
    emitMoveRejected(socket, "A partida não está ativa.");
    return;
  }

  const color = getPlayerColor(room, socket.id);

  if (!color) {
    emitMoveRejected(socket, "Você não pertence a esta partida.");
    return;
  }

  if (color !== room.turn) {
    emitMoveRejected(socket, "Não é a sua vez.");
    return;
  }

  const from = parseCoordinate(payload?.from);
  const to = parseCoordinate(payload?.to);

  if (!from || !to ||
      (from.r === to.r && from.c === to.c)) {
    emitMoveRejected(socket, "Coordenadas da jogada inválidas.");
    return;
  }

  const piece = room.board[from.r][from.c];

  if (!piece || piece.color !== color) {
    emitMoveRejected(
      socket,
      "Peça inválida ou pertencente ao adversário."
    );
    return;
  }

  const legalMoves = getLegalMoves(room, from.r, from.c, color);
  const move = legalMoves.find(m =>
    m.r === to.r && m.c === to.c
  );

  if (!move) {
    emitMoveRejected(
      socket,
      room.mustContinue
        ? "Continue capturando com a mesma peça."
        : "Jogada inválida, ou existe uma captura obrigatória maior."
    );
    return;
  }

  const movingPiece = room.board[from.r][from.c];

  room.board[from.r][from.c] = null;
  room.board[to.r][to.c] = movingPiece;

  if (move.capture) {
    room.capturedThisTurn.push({
      r: move.capture.r,
      c: move.capture.c
    });

    room.mustContinue = { r: to.r, c: to.c };

    const nextCaptures = getCaptures(room, to.r, to.c);

    if (nextCaptures.length > 0) {
      room.lastMoveAt = Date.now();

      broadcastBoard(
        room,
        "Continue capturando com a mesma peça."
      );

      return;
    }
  }

  removeCapturedPieces(room);
  promotePiece(movingPiece, to.r);

  room.mustContinue = null;
  room.turn = otherColor(room.turn);
  room.lastMoveAt = Date.now();

if (await checkGameEnd(room)) return;

  broadcastBoard(room, "Jogada sincronizada.");
}

// ======================================================
// SALAS E SAÍDA VOLUNTÁRIA
// ======================================================

function leaveCurrentRoom(socket, reason = "O jogador saiu da sala.") {
  const room = getSocketRoom(socket);

  if (!room) {
    socketRooms.delete(socket.id);
    socket.emit("roomLeft", {
      message: "Você não está em uma sala."
    });
    return;
  }

  const code = room.code;
  const color = getPlayerColor(room, socket.id);

  socket.leave(code);
  socketRooms.delete(socket.id);

  if (color) {
    clearReconnectTimer(code, color);

    room.players[color] = null;
    room.playerUids[color] = null;
  }

  socket.emit("roomLeft", {
    code,
    message: "Você saiu da sala."
  });

  io.to(code).emit("playerLeft", {
    code,
    color,
    message: reason
  });

  // Uma saída voluntária encerra esta sala.
  deleteRoom(code);
}

function createRoom(socket) {
  if (getSocketRoom(socket)) {
    emitRoomError(
      socket,
      "Você já está em uma sala. Saia dela antes de criar outra."
    );
    return;
  }

  let code;

  try {
    code = getAvailableRoomCode();
  } catch (error) {
    emitRoomError(socket, error.message);
    return;
  }

  const room = createRoomState(
    code,
    socket.id,
    socket.data.uid
  );

  rooms.set(code, room);
  socketRooms.set(socket.id, code);
  socket.join(code);

  socket.emit("roomCreated", {
    code,
    color: BLACK,
    message: "Sala criada. Aguardando o adversário."
  });

  socket.emit("roomInfo", roomSnapshot(room));

  console.log(`[Sala] ${code} criada.`);
}

function joinRoom(socket, payload) {
  if (getSocketRoom(socket)) {
    emitRoomError(
      socket,
      "Você já está em uma sala. Saia dela antes de entrar em outra."
    );
    return;
  }

  const rawCode = typeof payload === "string"
    ? payload
    : payload?.code ?? payload?.roomCode;

  const code = typeof rawCode === "string"
    ? rawCode.trim().toUpperCase()
    : "";

  if (!/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/.test(code)) {
    emitRoomError(socket, "Código de sala inválido.");
    return;
  }

  const room = rooms.get(code);

  if (!room) {
    emitRoomError(socket, "Sala não encontrada ou já encerrada.");
    return;
  }

  if (room.started || room.players.white ||
      room.playerUids.white) {
    emitRoomError(socket, "Esta sala já está cheia.");
    return;
  }

  room.players.white = socket.id;
  room.playerUids.white = socket.data.uid;
  room.started = true;

  socketRooms.set(socket.id, code);
  socket.join(code);

  socket.emit("roomJoined", {
    code,
    color: WHITE,
    message: "Entrou na sala. Preparando partida."
  });

  io.to(code).emit("gameReady", {
    ...roomSnapshot(room),
    message: "Partida iniciada!"
  });

  console.log(`[Sala] ${code} iniciada.`);
}

// ======================================================
// RECONEXÃO
// ======================================================

function resumeRoomForSocket(socket) {
  const uid = socket.data.uid;

  for (const room of rooms.values()) {
    if (!room.started || room.gameOver) continue;

    let color = null;

    if (room.playerUids.black === uid) {
      color = BLACK;
    } else if (room.playerUids.white === uid) {
      color = WHITE;
    }

    if (!color) continue;

    const previousSocketId = room.players[color];

    if (previousSocketId && previousSocketId !== socket.id) {
      const previousSocket =
        io.sockets.sockets.get(previousSocketId);

      // A nova conexão autenticada assume a vaga.
      // O disconnect antigo não poderá limpar a vaga nova.
      if (previousSocket) {
        socketRooms.delete(previousSocketId);
        previousSocket.disconnect(true);
      }
    }

    clearReconnectTimer(room.code, color);

    room.players[color] = socket.id;
    socketRooms.set(socket.id, room.code);
    socket.join(room.code);

    socket.emit("roomResumed", {
      ...roomSnapshot(room),
      color,
      message: "Partida recuperada com sucesso."
    });

    io.to(room.code).emit("playerReconnected", {
      color,
      message: "O adversário voltou à partida."
    });

    console.log(
      `[Sala] ${room.code} recuperada por ${color}.`
    );

    return true;
  }

  return false;
}

// ======================================================
// AUTENTICAÇÃO SOCKET.IO
// ======================================================

io.use(async (socket, next) => {
  try {
    if (!firebaseReady) {
      return next(
        new Error("Autenticação indisponível: configure o Firebase Admin.")
      );
    }

    const token = socket.handshake.auth?.token;

    if (typeof token !== "string" || !token.trim()) {
      return next(
        new Error("Faça login com o Google para jogar online.")
      );
    }

    const decoded = await getAuth().verifyIdToken(token);

    if (!decoded.uid) {
      return next(new Error("Token de autenticação inválido."));
    }

    socket.data.uid = decoded.uid;
    socket.data.email = decoded.email || null;

    next();
  } catch (error) {
    console.warn("[Auth] Conexão recusada:", error.message);
    next(new Error("Login inválido ou expirado. Entre novamente."));
  }
});

// ======================================================
// EVENTOS SOCKET.IO
// ======================================================

io.on("connection", socket => {
  const uid = socket.data.uid;
  socket.on("wallet:request", async () => {
  try {
    const uid = socket.data.uid;

    if (!uid) {
      socket.emit("wallet:response", {
        success: false,
        message: "Faça login para acessar sua carteira."
      });
      return;
    }

    const balance = await getOrCreateWallet(uid);

    socket.emit("wallet:response", {
      success: true,
      balance: Number(balance)
    });

  } catch (error) {
    console.error("[Carteira] Erro ao consultar saldo:", error);

    socket.emit("wallet:response", {
      success: false,
      message: "Não foi possível carregar sua carteira."
    });
  }
});

  if (!userSockets.has(uid)) {
    userSockets.set(uid, new Set());
  }

  userSockets.get(uid).add(socket.id);

  console.log(`[Socket] Usuário conectado: ${uid}`);

  socket.emit("serverReady", {
    message: "Conectado ao servidor de damas."
  });

  // Os eventos são registrados antes da tentativa de recuperação.
  socket.on("createRoom", () => createRoom(socket));
  // SISTEMA DE APOSTAS
socket.on("bet:create", async payload => {
  try {
    const room = getSocketRoom(socket);

    if (!room) {
      throw new Error("Você não está em uma sala.");
    }

    const opponentColor =
      room.playerUids.black === socket.data.uid ? WHITE : BLACK;

    const opponentSocketId = room.players[opponentColor];

    if (!opponentSocketId) {
      throw new Error("O adversário está desconectado.");
    }

    const bet = await createBetRequest(
      room,
      socket.data.uid,
      payload?.amount
    );

    const betInfo = {
      id: bet.id,
      amount: bet.amount,
      status: bet.status,
      message: "Seu adversário enviou um pedido de aposta."
    };

    io.to(opponentSocketId).emit("bet:created", betInfo);

    socket.emit("bet:sent", {
      id: bet.id,
      amount: bet.amount,
      status: bet.status,
      message: "Pedido de aposta enviado. Aguardando resposta."
    });

  } catch (error) {
    socket.emit("bet:error", {
      message: error.message
    });
  }
});

socket.on("bet:respond", async payload => {
  try {
    const room = getSocketRoom(socket);

    if (!room) {
      throw new Error("Você não está em uma sala.");
    }

    const result = await respondToBet(
      room,
      socket.data.uid,
      payload?.accepted
    );

    io.to(room.code).emit("bet:response", result);

  } catch (error) {
    socket.emit("bet:error", {
      message: error.message
    });
  }
});
  socket.on("joinRoom", payload => joinRoom(socket, payload));
socket.on("moveAttempt", async payload => {
  try {
    await handleMoveAttempt(socket, payload);
  } catch (error) {
    console.error("[Jogada] Erro ao processar movimento:", error);
    socket.emit("moveRejected", {
      message: "Erro ao processar a jogada. Tente novamente."
    });
  }
});

  socket.on("requestRoomState", () => {
    const room = getSocketRoom(socket);

    if (!room) {
      // Permite ao cliente saber que não tem sala vinculada.
      socket.emit("roomStateUnavailable", {
        message: "Você não está em uma sala."
      });
      return;
    }

    const color = getPlayerColor(room, socket.id);

    socket.emit(
      room.started ? "gameReady" : "roomInfo",
      {
        ...roomSnapshot(room),
        color
      }
    );
  });

  socket.on("leaveRoom", () => {
    leaveCurrentRoom(socket);
  });

  // Recupera a partida após registrar os listeners do servidor.
  resumeRoomForSocket(socket);

  socket.on("disconnect", reason => {
    const room = getSocketRoom(socket);

    if (room) {
      const code = room.code;
      const color = getPlayerColor(room, socket.id);

      socketRooms.delete(socket.id);

      // Só altera a vaga se ela ainda pertencer a este socket.
      if (color && room.players[color] === socket.id) {
        room.players[color] = null;

        io.to(code).emit("playerDisconnected", {
          message: "O jogador desconectou. Aguardando reconexão.",
          color,
          reason
        });

        scheduleReconnectExpiry(room, color, socket.id);

        console.log(
          `[Sala] ${code}: ${color} desconectou; aguardando reconexão.`
        );
      }
    }

    const socketsForUser = userSockets.get(uid);

    if (socketsForUser) {
      socketsForUser.delete(socket.id);

      if (socketsForUser.size === 0) {
        userSockets.delete(uid);
      }
    }

    console.log(`[Socket] Desconectado: ${uid} (${reason})`);
  });
});

// ======================================================
// ENCERRAMENTO
// ======================================================

function shutdown(signal) {
  console.log(`\n[Servidor] Recebido ${signal}. Encerrando...`);

  for (const timer of reconnectTimers.values()) {
    clearTimeout(timer);
  }

  reconnectTimers.clear();

  const forceExit = setTimeout(() => process.exit(1), 10000);
  forceExit.unref();

  io.close(() => {
    httpServer.close(() => {
      clearTimeout(forceExit);
      console.log("[Servidor] Encerrado.");
      process.exit(0);
    });
  });
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

process.on("unhandledRejection", error => {
  console.error("[Erro não tratado]", error);
});

process.on("uncaughtException", error => {
  console.error("[Erro crítico]", error);
  process.exit(1);
});

// ======================================================
// INICIAR
// ======================================================

httpServer.listen(PORT, "0.0.0.0", () => {
  console.log("========================================");
  console.log("       DAMAS ONLINE — SERVIDOR");
  console.log("========================================");
  console.log(`Porta: ${PORT}`);
  console.log(`Firebase: ${firebaseReady ? "pronto" : "não configurado"}`);
  console.log(`Saúde: http://localhost:${PORT}/health`);
  console.log("Reconexão: 120 segundos");
  console.log("========================================");
});


"use strict";
if (!process.env.FIREBASE_AUTH_EMULATOR_HOST) require("dotenv").config();
const express = require("express");
const http = require("http");
const path = require("path");
const crypto = require("crypto");
const { Pool } = require("pg");
const { createSettlement } = require("./settlement");
const { validateNickname } = require("./nicknames");

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
const emulatorHost = process.env.FIREBASE_AUTH_EMULATOR_HOST;
const projectId = process.env.GCLOUD_PROJECT;
const localSdk = process.env.DAMAS_LOCAL_FIREBASE_SDK;
const HOST = emulatorHost ? "127.0.0.1" : (process.env.HOST || "0.0.0.0");

if (emulatorHost) {
  const isLocalDb = !process.env.DATABASE_URL ||
    ["127.0.0.1", "localhost", "[::1]"].includes(new URL(process.env.DATABASE_URL).hostname);
  if (!/^(127\.0\.0\.1|localhost):[0-9]+$/.test(emulatorHost) ||
      !/^demo-[a-z0-9-]+$/.test(projectId || "") || !isLocalDb) {
    throw new Error("O emulador exige projeto demo-, Firebase local e banco local.");
  }
}
const configuredGrace = Number(process.env.DAMAS_TEST_RECONNECT_MS);
const RECONNECT_GRACE_MS = emulatorHost && Number.isInteger(configuredGrace) && configuredGrace > 0
  ? configuredGrace : 120000;
// ======================================================
// CONEXÃO COM O POSTGRESQL — SUPABASE
// ======================================================

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === "true"
    ? { rejectUnauthorized: true, ca: process.env.DATABASE_CA || undefined }
    : false,
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
  statement_timeout: 5000
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
const { BLACK, WHITE, inside, cloneBoard, createMatch, getLegalMoves, applyMove } = require("./rules");

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

    if (emulatorHost) {
      initializeApp({ projectId });
      firebaseReady = true;
      console.log("[Firebase] Emulador local inicializado.");
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
    bettingReady,
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
for (const file of ["index.html", "style.css", "rules.js", "script.js", "auth.js"]) {
  app.get(file === "index.html" ? ["/", "/index.html"] : `/${file}`,
    (_req, res) => res.sendFile(path.join(__dirname, file)));
}
app.use("/assets", express.static(path.join(__dirname, "assets")));
app.get("/auth-config", (_req, res) => {
  res.set("Cache-Control", "no-store");
  res.json(emulatorHost ? {
    emulator: `http://${emulatorHost}`,
    projectId,
    sdk: localSdk ? "/local-firebase-sdk.js" : null
  } : {});
});
if (emulatorHost && localSdk) {
  app.get("/local-firebase-sdk.js", (_req, res) => res.sendFile(path.resolve(localSdk)));
}

// ======================================================
// UTILITÁRIOS
// ======================================================

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
      status: room.bet.status,
      responderColor: room.playerUids.black === room.bet.opponentUid ? BLACK : WHITE
    } : null,
    reconnectGraceMs: RECONNECT_GRACE_MS,
    nicknames: { ...room.nicknames },
    players: {
      black: Boolean(room.players.black),
      white: Boolean(room.players.white)
    }
  };
}

function createRoomState(code, socketId, uid) {
  return {
    code,
    ...createMatch(),
    nicknames: { black: null, white: null },

    players: {
      black: socketId,
      white: null
    },

    playerUids: {
      black: uid,
      white: null
    },

    gameOver: false,
winner: null,
started: false,

// SISTEMA DE APOSTAS
bet: null,

    operations: Promise.resolve(),
    closing: false,
    reconnectDeadlines: { black: null, white: null },
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

function scheduleReconnectExpiry(room, color) {
  const key = `${room.code}:${color}`;
  clearReconnectTimer(room.code, color);
  room.reconnectDeadlines[color] ??= Date.now() + RECONNECT_GRACE_MS;
  const timer = setTimeout(() => {
    reconnectTimers.delete(key);
    if (room.players[color] === null) {
      closeRoom(room, "O prazo para reconexão terminou. A partida foi encerrada.");
    }
  }, room.reconnectDeadlines[color] - Date.now());
  timer.unref();
  reconnectTimers.set(key, timer);
}

function enqueueRoom(room, operation) {
  const result = room.operations.then(operation);
  room.operations = result.catch(() => {});
  return result;
}

function closeRoom(room, message) {
  if (room.closing) return;
  room.closing = true;
  io.to(room.code).emit("playerLeft", { code: room.code, message });
  deleteRoom(room.code);

  // Finish a bet request/acceptance already in flight before deciding its outcome.
  void enqueueRoom(room, async () => {
    if (room.bet && ["pending", "reserved"].includes(room.bet.status)) {
      await resolveBet(room, room.winner || null);
    }
  }).catch(error => console.error("[Sala] Encerramento:", error.message));
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

  if (!Number.isFinite(value) || value < 0.01 || value > 5) {
    return {
      valid: false,
      message: "A aposta deve ser entre 0,01 e 5 créditos."
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

  if (!room.started || room.gameOver || room.closing) {
    throw new Error("A partida não está disponível para apostas.");
  }

  if (!room.playerUids.black || !room.playerUids.white) {
    throw new Error("Os dois jogadores precisam estar na sala.");
  }

  if (room.bet && room.bet.status !== "cancelled") {
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

  const [balance] = await Promise.all([getOrCreateWallet(creatorUid), getOrCreateWallet(opponentUid)]);

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

async function respondToBet(room, opponentUid, accepted, betId) {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    if (room.closing || room.gameOver || !room.players.black || !room.players.white ||
        !room.bet || room.bet.status !== "pending") {
      throw new Error("Não existe uma aposta pendente.");
    }

    if (room.bet.id !== betId) throw new Error("Este pedido de aposta não está mais ativo.");

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

const { recordResolution, settle } = createSettlement(pool);
const settlementQueue = new Map();
let bettingReady = false;
let recoveryConnection = null;

async function publishSettlement(room, result) {
  if (!result) return;
  room.bet.status = result.status;
  if (!room.closing) {
    io.to(room.code).emit("bet:response", {
      id: room.bet.id,
      code: room.code,
      status: result.status,
      message: result.payout
        ? `Prêmio de ${result.payout} créditos pago ao vencedor.`
        : "Aposta cancelada. Reservas foram estornadas."
    });
  }

  notifyWallets(result.uids);
}

function notifyWallets(uids) {
  for (const uid of uids) {
    for (const socketId of userSockets.get(uid) || []) {
      io.to(socketId).emit("wallet:changed");
    }
  }
}

function setBettingReady(ready) {
  if (bettingReady === ready) return;
  bettingReady = ready;
  io.emit("bet:availability", { ready });
}

async function processSettlement(entry) {
  if (entry.running) return;
  entry.running = true;
  try {
    const { room, winnerUid } = entry;
    await recordResolution(room.bet.id, winnerUid);
    const result = await settle(room.bet.id);
    settlementQueue.delete(room.bet.id);
    await publishSettlement(room, result);
  } catch (error) {
    console.error("[Aposta] Liquidação pendente:", error.message);
    if (!entry.room.closing) {
      io.to(entry.room.code).emit("bet:error", {
        message: "Créditos pendentes. O servidor tentará concluir a liquidação novamente."
      });
    }
  } finally {
    entry.running = false;
  }
}

async function resolveBet(room, winner) {
  if (!room.bet || !["pending", "reserved"].includes(room.bet.status)) return;
  if (settlementQueue.has(room.bet.id)) return;
  const entry = { room, winnerUid: winner ? room.playerUids[winner] : null };
  settlementQueue.set(room.bet.id, entry);
  await processSettlement(entry);
}

async function recoverBets() {
  if (!process.env.DATABASE_URL) return;
  let connection;
  try {
    connection = await pool.connect();
    const { rows: [lock] } = await connection.query(
      "SELECT pg_try_advisory_lock(751503818) AS acquired"
    );
    if (!lock.acquired) throw new Error("Outra instância controla as apostas neste banco.");

    const { rows } = await connection.query(
      "SELECT id FROM public.bets WHERE status IN ('pending', 'reserved') ORDER BY id"
    );
    for (const { id } of rows) await settle(id);

    recoveryConnection = connection;
    connection.on("error", error => {
      setBettingReady(false);
      recoveryConnection = null;
      connection.release(true);
      console.error("[Aposta] Conexão de controle perdida:", error.message);
      // A próxima instância reconcilia os registros antes de aceitar novas reservas.
      shutdown("Conexão de controle");
    });
    setBettingReady(true);
  } catch (error) {
    if (connection) connection.release(true);
    console.error("[Aposta] Recuperação indisponível:", error.message);
  }
}

const settlementTimer = setInterval(() => {
  if (bettingReady) {
    for (const entry of settlementQueue.values()) void processSettlement(entry);
  } else if (!recoveryConnection && !recoveryAttempt) {
    startRecovery();
  }
}, 5000);
settlementTimer.unref();

let recoveryAttempt = null;
function startRecovery() {
  recoveryAttempt = recoverBets().finally(() => { recoveryAttempt = null; });
}

async function finishGame(room, winner, message) {
  room.gameOver = true;
  room.winner = winner;

  const result = { ...roomSnapshot(room), message };
  io.to(room.code).emit("boardUpdate", result);
  io.to(room.code).emit("gameOver", result);
  await resolveBet(room, winner);
}

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

  if (!room.started || room.gameOver || room.closing || !room.players.black || !room.players.white) {
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

  const outcome = applyMove(room, from, move);
  room.lastMoveAt = Date.now();

  if (outcome.winner || outcome.draw) {
    const winner = outcome.winner || null;
    const message = outcome.draw
      ? "Empate por repetição de posição."
      : winner === BLACK ? "As pretas venceram!" : "As brancas venceram!";
    await finishGame(room, winner, message);
    return;
  }

  broadcastBoard(room, outcome.continuing
    ? "Continue capturando com a mesma peça."
    : "Jogada sincronizada.");
}

// ======================================================
// SALAS E SAÍDA VOLUNTÁRIA
// ======================================================

function leaveCurrentRoom(socket) {
  const room = getSocketRoom(socket);
  if (room) {
    socket.leave(room.code);
    socketRooms.delete(socket.id);
    closeRoom(room, "O adversário saiu. A partida foi encerrada.");
  }
  socket.emit("roomLeft", { message: "Você saiu da sala." });
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

  room.nicknames.black = socket.data.nickname || null;
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

  if (room.playerUids.black === socket.data.uid) {
    emitRoomError(socket, "Use outra conta para jogar como adversário.");
    return;
  }

  if (!room.players.black || room.closing || room.gameOver || room.started || room.players.white ||
      room.playerUids.white) {
    emitRoomError(socket, "Esta sala já está cheia.");
    return;
  }

  room.players.white = socket.id;
  room.playerUids.white = socket.data.uid;
  room.nicknames.white = socket.data.nickname || null;
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
    if (room.closing) continue;

    let color = null;

    if (room.playerUids.black === uid) {
      color = BLACK;
    } else if (room.playerUids.white === uid) {
      color = WHITE;
    }

    if (!color) continue;
    const deadline = room.reconnectDeadlines[color];
    if (deadline && Date.now() >= deadline) {
      closeRoom(room, "O prazo para reconexão terminou. A partida foi encerrada.");
      continue;
    }

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
    room.reconnectDeadlines[color] = null;
    socketRooms.set(socket.id, room.code);
    socket.join(room.code);

    socket.emit("roomResumed", {
      ...roomSnapshot(room),
      color,
      message: "Partida recuperada com sucesso."
    });

    socket.to(room.code).emit("playerReconnected", {
      ...roomSnapshot(room),
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
        new Error("Entre na sua conta para jogar online.")
      );
    }

    const decoded = await getAuth().verifyIdToken(token);

    if (!decoded.uid) {
      return next(new Error("Token de autenticação inválido."));
    }

    socket.data.uid = decoded.uid;

    next();
  } catch (error) {
    console.warn("[Auth] Conexão recusada:", error.message);
    next(new Error("Login inválido ou expirado. Entre novamente."));
  }
});

// ======================================================
// EVENTOS SOCKET.IO
// ======================================================

function publishProfile(uid, nickname) {
  for (const socketId of userSockets.get(uid) || []) {
    const socket = io.sockets.sockets.get(socketId);
    if (!socket) continue;
    socket.data.nickname = nickname;
    socket.emit("profile:state", { nickname });
  }

  for (const room of rooms.values()) {
    const color = room.playerUids.black === uid ? BLACK
      : room.playerUids.white === uid ? WHITE : null;
    if (color) {
      room.nicknames[color] = nickname;
      io.to(room.code).emit("profiles:update", { code: room.code, nicknames: { ...room.nicknames } });
    }
  }
}

const profileOperations = new Map();
function enqueueProfile(uid, operation) {
  const next = (profileOperations.get(uid) || Promise.resolve()).catch(() => {}).then(operation);
  profileOperations.set(uid, next);
  return next.finally(() => {
    if (profileOperations.get(uid) === next) profileOperations.delete(uid);
  });
}

io.on("connection", socket => {
  const uid = socket.data.uid;
  socket.on("profile:update", async payload => {
    let nickname;
    try {
      nickname = validateNickname(payload?.nickname);
    } catch (error) {
      socket.emit("profile:error", { message: error.message });
      return;
    }

    try {
      await enqueueProfile(uid, async () => {
        await pool.query(
          `INSERT INTO public.player_profiles (firebase_uid, nickname)
           VALUES ($1, $2)
           ON CONFLICT (firebase_uid) DO UPDATE SET nickname = EXCLUDED.nickname, updated_at = NOW()`,
          [uid, nickname]
        );
        publishProfile(uid, nickname);
      });
      socket.emit("profile:saved", { nickname });
    } catch (error) {
      console.error("[Perfil] Erro ao salvar:", error.message);
      socket.emit("profile:error", { message: "Não foi possível salvar o apelido. Tente novamente." });
    }
  });
  socket.on("wallet:request", async acknowledge => {
    const reply = typeof acknowledge === "function" ? acknowledge
      : payload => socket.emit("wallet:response", payload);
    try {
      const balance = await getOrCreateWallet(uid);
      reply({ success: true, balance: Number(balance) });
    } catch (error) {
      console.error("[Carteira] Erro ao consultar saldo:", error.code || error.name);
      reply({ success: false, retryable: true });
    }
  });

  if (!userSockets.has(uid)) {
    userSockets.set(uid, new Set());
  }

  userSockets.get(uid).add(socket.id);
  void enqueueProfile(uid, async () => {
    const { rows: [profile] } = await pool.query(
      "SELECT nickname FROM public.player_profiles WHERE firebase_uid = $1", [uid]
    );
    publishProfile(uid, profile?.nickname || null);
  }).catch(error => {
    console.error("[Perfil] Erro ao carregar:", error.message);
    socket.emit("profile:error", { message: "Não foi possível carregar seu apelido." });
  });

  console.log(`[Socket] Usuário conectado: ${uid}`);

  socket.emit("bet:availability", { ready: bettingReady });
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

    if (!bettingReady) throw new Error("Apostas temporariamente indisponíveis.");
    const bet = await enqueueRoom(room, () =>
      createBetRequest(room, socket.data.uid, payload?.amount)
    );

    const betInfo = {
      code: room.code,
      id: bet.id,
      amount: bet.amount,
      status: bet.status,
      message: "Seu adversário enviou um pedido de aposta."
    };

    if (room.closing) return;
    if (room.players[opponentColor]) io.to(room.players[opponentColor]).emit("bet:created", betInfo);

    socket.emit("bet:sent", {
      code: room.code,
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

    if (!bettingReady) throw new Error("Apostas temporariamente indisponíveis.");
    const result = await enqueueRoom(room, () =>
      respondToBet(room, socket.data.uid, payload?.accepted, payload?.betId)
    );

    io.to(room.code).emit("bet:response", { ...result, code: room.code, id: payload.betId });
    if (result.accepted) notifyWallets(Object.values(room.playerUids));

  } catch (error) {
    socket.emit("bet:error", {
      message: error.message
    });
  }
});
  socket.on("joinRoom", payload => joinRoom(socket, payload));
socket.on("moveAttempt", async payload => {
  try {
    const room = getSocketRoom(socket);
    if (room) await enqueueRoom(room, () => handleMoveAttempt(socket, payload));
    else emitMoveRejected(socket, "Você não está em uma sala.");
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
  if (!resumeRoomForSocket(socket)) {
    socket.emit("roomStateUnavailable", { message: "Você não está em uma sala." });
  }

  socket.on("disconnect", reason => {
    const room = getSocketRoom(socket);

    if (room) {
      const code = room.code;
      const color = getPlayerColor(room, socket.id);

      socketRooms.delete(socket.id);

      // Só altera a vaga se ela ainda pertencer a este socket.
      if (color && room.players[color] === socket.id) {
        room.players[color] = null;

        scheduleReconnectExpiry(room, color);
        io.to(code).emit("playerDisconnected", {
          reconnectDeadline: room.reconnectDeadlines[color],
          message: "O jogador desconectou. Aguardando reconexão.",
          color,
          reason
        });


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

  clearInterval(settlementTimer);
  bettingReady = false;
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

startRecovery();

httpServer.listen(PORT, HOST, () => {
  console.log("========================================");
  console.log("       DAMAS ONLINE — SERVIDOR");
  console.log("========================================");
  console.log(`Porta: ${PORT}`);
  console.log(`Firebase: ${firebaseReady ? "pronto" : "não configurado"}`);
  console.log(`Saúde: http://localhost:${PORT}/health`);
  console.log(`Reconexão: ${RECONNECT_GRACE_MS / 1000} segundos`);
  console.log("========================================");
});

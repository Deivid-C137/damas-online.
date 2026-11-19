"use strict";

const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const { once } = require("node:events");
const http = require("node:http");
const { setTimeout: delay } = require("node:timers/promises");
const { chromium } = require("playwright");
const { Pool } = require("pg");
const { createMatch, getLegalMoves, applyMove } = require("../rules");

const emulator = process.env.FIREBASE_AUTH_EMULATOR_HOST;
const database = process.env.DATABASE_URL;
const port = Number(process.env.DAMAS_E2E_PORT || 3301);
const origin = `http://127.0.0.1:${port}`;

if (!/^127\.0\.0\.1:\d+$/.test(emulator || "") ||
    !/^demo-/.test(process.env.GCLOUD_PROJECT || "") ||
    !database || new URL(database).hostname !== "127.0.0.1" ||
    !process.env.DAMAS_LOCAL_FIREBASE_SDK ||
    !Number.isInteger(port) || port < 1024 || port > 65535) {
  throw new Error("O E2E exige projeto demo-, emulador, banco e SDK locais e uma porta livre.");
}

let server;
let browser;
const pool = new Pool({ connectionString: database, ssl: false });

async function eventually(check, timeout = 12000) {
  const deadline = performance.now() + timeout;
  let error;
  do {
    try {
      return await check();
    } catch (caught) {
      error = caught;
      await delay(120);
    }
  } while (performance.now() < deadline);
  throw error;
}

function readHealth() {
  return new Promise((resolve, reject) => {
    const request = http.get(`${origin}/health`, { agent: false, timeout: 1000 }, response => {
      const chunks = [];
      response.on("data", chunk => chunks.push(chunk));
      response.on("error", reject);
      response.on("end", () => {
        try {
          assert.equal(response.statusCode, 200);
          resolve(JSON.parse(Buffer.concat(chunks)));
        } catch (error) {
          reject(error);
        }
      });
    });
    request.on("timeout", () => request.destroy(new Error("Sem resposta da rota de saúde.")));
    request.on("error", reject);
  });
}

async function startServer() {
  server = spawn(process.execPath, ["server.js"], {
    stdio: ["ignore", "inherit", "inherit"],
    env: { ...process.env, PORT: String(port), DAMAS_TEST_RECONNECT_MS: "7000" },
    windowsHide: true
  });
  await eventually(async () => {
    assert.equal(server.exitCode, null);
    const health = await readHealth();
    assert.equal(health.firebaseReady, true);
    assert.equal(health.bettingReady, true);
  }, 30000);
}

async function stopServer() {
  if (!server || server.exitCode !== null || server.signalCode !== null) return;
  const closed = once(server, "exit");
  server.kill("SIGKILL");
  await closed;
}

async function waitText(locator, text) {
  await eventually(async () => assert.match(await locator.textContent({ timeout: 500 }), text));
}

async function account(index, waitForBalance = true) {
  const context = await browser.newContext();
  await context.route("**/*", route => {
    const url = new URL(route.request().url());
    if ([origin, `http://${emulator}`].includes(url.origin)) return route.continue();
    return route.abort();
  });
  const page = await context.newPage();
  const incoming = [];
  page.on("websocket", socket => socket.on("framereceived", ({ payload }) => incoming.push(String(payload))));
  const email = `damas-${Date.now()}-${index}@example.invalid`;
  await page.goto(origin);
  await page.locator("#auth-tab-register").click();
  await page.locator("#auth-email").fill(email);
  await page.locator("#auth-password").fill("Senha-local-730");
  await page.locator("#auth-submit").click();
  if (waitForBalance) await waitText(page.locator("#wallet-balance"), /500/);
  return { page, context, email, incoming };
}

async function loginAgain({ page, email }) {
  await page.locator("#google-logout").click();
  await page.locator("#auth-tab-login").click();
  await page.locator("#auth-email").fill(email);
  await page.locator("#auth-password").fill("Senha-local-730");
  await page.locator("#auth-submit").click();
  await waitText(page.locator("#status"), /Conectado ao servidor/);
}

async function setNickname(page, name, expected) {
  await page.locator("#profile-nickname").fill(name);
  await page.locator("#profile-save").click();
  await waitText(page.locator("#profile-message"), expected);
}

async function createRoom(black, white) {
  await black.locator("#create-room").click();
  const code = await eventually(async () => {
    const value = await black.locator("#room-code").inputValue();
    assert.match(value, /^[A-Z0-9]{6}$/);
    return value;
  });
  await white.locator("#room-code").fill(code);
  await white.locator("#join-room").click();
  await waitText(black.locator("#room-info"), /Partida em andamento/);
  await waitText(white.locator("#room-info"), /Partida em andamento/);
  return code;
}

async function propose(black, white) {
  await black.locator("#bet-create").click();
  await white.locator("#bet-accept").waitFor({ state: "visible" });
}

async function accept(white) {
  await white.locator("#bet-accept").click();
  await waitText(white.locator("#bet-status"), /reservados/);
}

async function assertBet(code, status) {
  return eventually(async () => {
    const { rows: [bet] } = await pool.query(
      "SELECT * FROM public.bets WHERE room_code = $1 ORDER BY id DESC LIMIT 1", [code]
    );
    assert.equal(bet?.status, status);
    return bet;
  });
}

async function assertRefund(code) {
  const bet = await assertBet(code, "cancelled");
  const { rows } = await pool.query(
    "SELECT amount FROM public.bet_transactions WHERE bet_id = $1 AND type = 'stake_refunded'",
    [bet.id]
  );
  assert.deepEqual(rows.map(row => Number(row.amount)), [5, 5]);
}

function completeGame() {
  for (let seed = 1; seed <= 120; seed++) {
    const moves = [];
    const match = createMatch();
    let rng = seed;
    for (let i = 0; i < 80; i++) {
      const possibilities = match.board.flatMap((row, r) => row.flatMap((piece, c) =>
        piece?.color === match.turn
          ? getLegalMoves(match, r, c, match.turn).map(move => ({ r, c, move }))
          : []
      ));
      rng = (Math.imul(rng, 1664525) + 1013904223) >>> 0;
      const { r, c, move } = possibilities[rng % possibilities.length];
      moves.push({ turn: match.turn, r, c, move });
      const result = applyMove(match, { r, c }, move);
      if (result.winner) return { moves, winner: result.winner };
      if (result.draw) break;
    }
  }
  throw new Error("Nenhuma sequência de vitória encontrada.");
}

function cell(page, r, c) {
  return page.locator(`#board [data-row="${r}"][data-col="${c}"]`);
}

async function playGame(black, white, beforeLastMove) {
  const { moves, winner } = completeGame();
  for (const [index, { turn, r, c, move }] of moves.entries()) {
    const page = turn === "black" ? black : white;
    await cell(page, r, c).click();
    await eventually(async () => assert.match(await cell(page, move.r, move.c).getAttribute("class"), /target/));
    if (index === 0) {
      assert.equal(await cell(page, r, c).evaluate(element => element === document.activeElement), true);
      assert.match(await cell(page, r, c).getAttribute("aria-label"), /branca.*Selecionada/);
    }
    if (index === moves.length - 1) await beforeLastMove();
    await cell(page, move.r, move.c).click();
    await eventually(async () => assert.match(
      await cell(page, move.r, move.c).getAttribute("aria-label"), new RegExp(turn === "black" ? "preta" : "branca")
    ));
  }
  return winner;
}

async function main() {
  await startServer();
  browser = await chromium.launch({ executablePath: process.env.DAMAS_BROWSER_PATH || undefined });
  const guest = await browser.newPage();
  await guest.goto(origin);
  await guest.locator("#auth-play-local").click();
  await guest.locator("#reset").click();
  await waitText(guest.locator("#turn-title"), /VEZ DAS BRANCAS/);
  await cell(guest, 5, 0).click();
  await cell(guest, 4, 1).click();
  await waitText(guest.locator("#turn-title"), /VEZ DAS PRETAS/);
  await guest.close();

  const walletBlocker = await pool.connect();
  let black;
  try {
    await walletBlocker.query("BEGIN");
    await walletBlocker.query("LOCK TABLE public.wallet_accounts IN ACCESS EXCLUSIVE MODE");
    black = await account(1, false);
    await waitText(black.page.locator("#wallet-message"), /Carregando saldo/);
    await waitText(black.page.locator("#wallet-message"), /Saldo temporariamente indisponível.*Tentando/);
    assert.equal(await black.page.locator("#wallet-balance").innerText(), "—");
  } finally {
    await walletBlocker.query("ROLLBACK");
    walletBlocker.release();
  }
  await waitText(black.page.locator("#wallet-balance"), /^500,00$/);

  const session = await fetch(`http://${emulator}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=demo-damas-key`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: black.email, password: "Senha-local-730", returnSecureToken: true })
  });
  assert.equal(session.status, 200);
  const { localId: uid } = await session.json();
  assert.ok(uid);
  await pool.query("UPDATE public.wallet_accounts SET balance = 0 WHERE firebase_uid = $1", [uid]);
  await black.page.locator("#refresh-wallet").click();
  await waitText(black.page.locator("#wallet-balance"), /^0,00$/);
  await pool.query("UPDATE public.wallet_accounts SET balance = 500 WHERE firebase_uid = $1", [uid]);
  const white = await account(2);
  await loginAgain(black);
  console.log("OK: saldo indisponível, recuperação automática e exibição de saldo zero.");
  for (const { page, email } of [black, white]) {
    assert.equal(await page.locator("#login-email").innerText(), email);
    assert.equal(await page.locator("#login-status").innerText(), "Conectado como Jogador");
    assert.equal(await page.locator("#auth-email").inputValue(), "");
  }
  assert.equal((await fetch(`${origin}/rota-inexistente`)).status, 404);

  await setNickname(black.page, "F d P", /xingamentos/);
  await setNickname(black.page, "P0rn-Hub", /conteúdo adulto/);
  await setNickname(black.page, black.email, /Endereços de e-mail não são aceitos/);
  await setNickname(black.page, "  Águia   Azul  ", /Apelido salvo/);
  await setNickname(white.page, "Luz d’Ávila", /Apelido salvo/);

  const code = await createRoom(black.page, white.page);
  await waitText(black.page.locator("#white-player"), /Luz d’Ávila/);
  await waitText(white.page.locator("#black-player"), /Águia Azul/);
  await setNickname(white.page, "Dama da Serra", /Apelido salvo/);
  await waitText(black.page.locator("#white-player"), /Dama da Serra/);
  for (const [own, opponent] of [[black, white], [white, black]]) {
    assert.equal((await own.page.locator("main").innerText()).includes(opponent.email), false);
    assert.equal(own.incoming.some(frame => frame.includes(opponent.email)), false);
  }
  console.log("OK: moderação, edição pública e e-mail restrito ao perfil privado.");

  await propose(black.page, white.page);
  await white.page.locator("#bet-decline").click();
  await waitText(black.page.locator("#bet-status"), /refusada|recusada/);
  await propose(black.page, white.page);
  await white.page.reload();
  await eventually(async () => assert.equal(await white.page.locator("#profile-nickname").inputValue(), "Dama da Serra"));
  await waitText(white.page.locator("#black-player"), /Águia Azul/);
  await white.page.locator("#bet-accept").waitFor({ state: "visible" });
  await accept(white.page);
  await waitText(black.page.locator("#wallet-balance"), /495/);
  await waitText(white.page.locator("#wallet-balance"), /495/);
  assert.equal((await assertBet(code, "reserved")).resolution, null);

  await white.context.setOffline(true);
  await waitText(black.page.locator("#turn-title"), /AGUARDANDO RECONEXÃO/);
  await white.page.locator("#disconnect-overlay").waitFor({ state: "visible" });
  await white.context.setOffline(false);
  await white.page.locator("#reconnect-button").click();
  await waitText(white.page.locator("#room-info"), /Partida em andamento/);
  await waitText(white.page.locator("#bet-status"), /reservados/i);
  await waitText(black.page.locator("#white-player"), /Dama da Serra/);

  const blocker = await pool.connect();
  let winner;
  try {
    winner = await playGame(black.page, white.page, async () => {
      await blocker.query("BEGIN");
      await blocker.query("LOCK TABLE public.bet_transactions IN ACCESS EXCLUSIVE MODE");
    });
    await waitText(black.page.locator("#turn-title"), /VENCERAM/);
    await waitText(black.page.locator("#bet-status"), /Créditos pendentes/);
    assert.equal((await assertBet(code, "reserved")).resolution, "payout");
  } finally {
    await blocker.query("ROLLBACK");
    blocker.release();
  }
  const completed = await assertBet(code, "finished");
  const winnerPage = winner === "black" ? black.page : white.page;
  await waitText(winnerPage.locator("#wallet-balance"), /504[,.]50/);
  const changes = await pool.query(
    "SELECT type, amount FROM public.bet_transactions WHERE bet_id = $1 ORDER BY type, id",
    [completed.id]
  );
  assert.deepEqual(changes.rows.map(row => [row.type, Number(row.amount)]), [
    ["commission", 0.5], ["stake_reserved", 5], ["stake_reserved", 5], ["winner_payout", 9.5]
  ]);
  console.log("OK: cadastro, login, carteira, foco, aposta restaurada, reconexão, partida completa, falha temporária e prêmio pago no retry.");

  await black.page.locator("#leave-room").click();
  await white.page.locator("#leave-room").waitFor({ state: "hidden" });
  const abandoned = await createRoom(black.page, white.page);
  await propose(black.page, white.page);
  await accept(white.page);
  await black.page.locator("#leave-room").click();
  await assertRefund(abandoned);
  console.log("OK: saída voluntária estornou as duas reservas.");

  const expired = await createRoom(black.page, white.page);
  await propose(black.page, white.page);
  await accept(white.page);
  await white.context.setOffline(true);
  await assertRefund(expired);
  await white.context.setOffline(false);
  await white.page.locator("#leave-room").waitFor({ state: "hidden" });
  await waitText(white.page.locator("#status"), /Você não está em uma sala|A partida foi encerrada/);
  console.log("OK: expiração da reconexão estornou as duas reservas.");

  const interrupted = await createRoom(black.page, white.page);
  await propose(black.page, white.page);
  await accept(white.page);
  await assertBet(interrupted, "reserved");
  await stopServer();
  await startServer();
  await assertRefund(interrupted);
  await stopServer();
  await startServer();
  await assertRefund(interrupted);
  console.log("OK: reinício abrupto estornou reservas órfãs e segunda recuperação não duplicou o estorno.");
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
}).finally(async () => {
  if (browser) await browser.close();
  await stopServer();
  await pool.end();
});

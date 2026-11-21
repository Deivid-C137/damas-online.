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
    !Number.isInteger(port) || port < 1024 || port > 65533) {
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

function readHealth(serverPort) {
  return new Promise((resolve, reject) => {
    const request = http.get(`http://127.0.0.1:${serverPort}/health`, { agent: false, timeout: 1000 }, response => {
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

async function startServer(serverPort = port) {
  server = spawn(process.execPath, ["server.js"], {
    stdio: ["ignore", "inherit", "inherit"],
    env: { ...process.env, PORT: String(serverPort), DAMAS_TEST_RECONNECT_MS: "7000" },
    windowsHide: true
  });
  await eventually(async () => {
    assert.equal(server.exitCode, null);
    const health = await readHealth(serverPort);
    assert.equal(health.firebaseReady, true);
    assert.equal(health.bettingReady, true);
  }, 90000);
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
    // Keep one observable transport so dropping both endpoints cannot wait for a polling heartbeat.
    if (url.origin === origin && url.pathname === "/socket.io/" &&
        url.searchParams.get("transport") === "polling") return route.abort();
    if ([origin, `http://${emulator}`].includes(url.origin)) return route.continue();
    return route.abort();
  });
  const incoming = [];
  let transport;
  let offline = false;
  await context.routeWebSocket(wsUrl => wsUrl.host === new URL(origin).host && wsUrl.pathname === "/socket.io/", route => {
    if (offline) return route.close();
    const upstream = route.connectToServer();
    transport = { route, upstream };
    upstream.onMessage(message => {
      incoming.push(String(message));
      route.send(message);
    });
  });
  const page = await context.newPage();
  async function setOffline(disconnected) {
    offline = disconnected;
    if (offline) {
      await eventually(() => assert.ok(transport));
      const { route, upstream } = transport;
      transport = null;
      await Promise.allSettled([upstream.close(), route.close()]);
    }
    await context.setOffline(offline);
  }
  const email = `damas-${Date.now()}-${index}@example.invalid`;
  await page.goto(origin);
  await page.locator("#auth-tab-register").click();
  await page.locator("#auth-email").fill(email);
  await page.locator("#auth-password").fill("Senha-local-730");
  await page.locator("#auth-submit").click();
  if (waitForBalance) await waitText(page.locator("#wallet-balance"), /500/);
  return { page, setOffline, email, incoming };
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

async function assertAbandonmentPayout(code, winnerUid) {
  const bet = await assertBet(code, "finished");
  assert.equal(bet.resolution, "payout");
  assert.equal(bet.winner_uid, winnerUid);
  const { rows } = await pool.query(
    "SELECT type, amount FROM public.bet_transactions WHERE bet_id = $1 ORDER BY type, id", [bet.id]
  );
  assert.deepEqual(rows.map(row => [row.type, Number(row.amount)]), [
    ["commission", 0.5], ["stake_reserved", 5], ["stake_reserved", 5], ["winner_payout", 9.5]
  ]);
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

  await black.page.locator("#create-room").click();
  const lobbyExit = black.page.locator("#leave-room");
  await lobbyExit.waitFor({ state: "visible" });
  assert.equal(await lobbyExit.innerText(), "Sair da sala");
  await lobbyExit.click();
  await lobbyExit.waitFor({ state: "hidden" });

  const unbet = await createRoom(black.page, white.page);
  await black.page.locator("#arena-bet").waitFor({ state: "hidden" });
  await white.page.locator("#leave-room").click();
  const resignDialog = white.page.getByRole("dialog", { name: "Desistir da partida?" });
  await resignDialog.waitFor({ state: "visible" });
  await waitText(white.page.locator("#resign-stake"), /Nenhum crédito será descontado/);
  await resignDialog.getByRole("button", { name: "Continuar jogando" }).click();
  await resignDialog.waitFor({ state: "hidden" });
  await waitText(black.page.locator("#room-info"), /Partida em andamento/);
  await white.page.locator("#leave-room").click();
  await black.setOffline(true);
  await waitText(white.page.locator("#turn-title"), /AGUARDANDO RECONEXÃO/);
  await resignDialog.waitFor({ state: "visible" });
  await resignDialog.getByRole("button", { name: "Continuar jogando" }).click();
  const waiting = white.page.getByRole("dialog", { name: "Adversário desconectado" });
  await waiting.getByRole("button", { name: "Desistir da partida" }).click();
  await resignDialog.waitFor({ state: "visible" });
  await resignDialog.getByRole("button", { name: "Confirmar desistência" }).click();
  await waitText(white.page.locator("#room-info"), /Sala encerrada/);
  assert.equal((await readHealth(port)).activeRooms, 0);
  await black.setOffline(false);
  await waitText(black.page.locator("#room-info"), /Sala encerrada/);
  await black.page.locator("#arena-result").waitFor({ state: "visible" });
  await waitText(black.page.locator("#arena-result-reason"), /As brancas desistiram/);
  await black.page.locator("#arena-result-credit").waitFor({ state: "hidden" });
  await black.page.locator("#play-again").click();
  await white.page.locator("#arena-result").waitFor({ state: "visible" });
  await white.page.locator("#return-lobby").click();
  const newCode = await eventually(async () => {
    const value = await black.page.locator("#room-code").inputValue();
    assert.match(value, /^[A-Z0-9]{6}$/);
    assert.notEqual(value, unbet);
    return value;
  });
  await waitText(black.page.locator("#room-info"), new RegExp(newCode));
  await black.page.locator("#leave-room").click();
  await black.page.locator("#leave-room").waitFor({ state: "hidden" });

  const code = await createRoom(black.page, white.page);
  assert.equal(await black.page.locator("#upper-player #white-card").count(), 1);
  assert.equal(await black.page.locator("#lower-player #black-card").count(), 1);
  assert.equal(await white.page.locator("#upper-player #black-card").count(), 1);
  assert.equal(await white.page.locator("#lower-player #white-card").count(), 1);
  assert.equal(await black.page.locator("#board .cell").first().getAttribute("data-row"), "7");
  assert.equal(await white.page.locator("#board .cell").first().getAttribute("data-row"), "0");
  await waitText(black.page.locator("#upper-player .player-tag"), /Vez do adversário/);
  await waitText(white.page.locator("#lower-player .player-tag"), /Sua vez/);
  for (const [badge, turn, color] of [
    [black.page.locator("#upper-player .player-tag"), "opponent", "rgb(255, 88, 106)"],
    [white.page.locator("#lower-player .player-tag"), "self", "rgb(83, 255, 137)"]
  ]) {
    await badge.waitFor({ state: "visible" });
    assert.equal(await badge.getAttribute("data-turn"), turn);
    assert.equal(await badge.evaluate(el => getComputedStyle(el, "::before").backgroundColor), color);
    assert.equal(await badge.evaluate(el => getComputedStyle(el.closest(".player")).borderTopColor), color);
  }
  await waitText(black.page.locator("#white-player"), /Luz d’Ávila/);
  await waitText(white.page.locator("#black-player"), /Águia Azul/);
  await setNickname(white.page, "Dama da Serra", /Apelido salvo/);
  await waitText(black.page.locator("#white-player"), /Dama da Serra/);
  for (const [own, opponent] of [[black, white], [white, black]]) {
    assert.equal((await own.page.locator("main").innerText()).includes(opponent.email), false);
    assert.equal(own.incoming.some(frame => frame.includes(opponent.email)), false);
  }
  console.log("OK: moderação, edição pública e e-mail restrito ao perfil privado.");

  const boardLabels = page => page.locator("#board .cell").evaluateAll(cells => cells.map(cell => cell.getAttribute("aria-label")));
  const initialBoards = await Promise.all([boardLabels(black.page), boardLabels(white.page)]);
  const from = cell(white.page, 5, 0);
  const to = cell(white.page, 4, 1);
  await from.click();
  await to.click();
  await eventually(async () => assert.match(await cell(black.page, 4, 1).getAttribute("aria-label"), /Peça branca/));
  const friendlyBoard = await boardLabels(black.page);
  assert.notDeepEqual(friendlyBoard, initialBoards[0]);

  await propose(black.page, white.page);
  assert.deepEqual(await boardLabels(black.page), friendlyBoard);
  await white.page.setViewportSize({ width: 390, height: 760 });
  const challenge = white.page.getByRole("dialog", { name: "Desafio de aposta" });
  await challenge.waitFor({ state: "visible" });
  assert.equal(await white.page.locator("#bet-challenge").evaluate(el => el.matches(":modal")), true);
  assert.equal(await black.page.locator("#bet-challenge").isVisible(), false);
  const bounds = await challenge.boundingBox();
  assert.ok(bounds.x >= 0 && bounds.y >= 0 && bounds.x + bounds.width <= 390 && bounds.y + bounds.height <= 760);
  assert.ok(Math.abs(bounds.x + bounds.width / 2 - 195) < 2);
  assert.ok(Math.abs(bounds.y + bounds.height / 2 - 380) < 2);
  await waitText(challenge.locator("#bet-challenge-player"), /Águia Azul/);
  await waitText(challenge.locator("#bet-challenge-amount"), /^5,00$/);
  await challenge.getByRole("button", { name: "Ver depois" }).click();
  await challenge.waitFor({ state: "hidden" });
  await white.page.locator("#bet-challenge-open").click();
  await challenge.getByRole("button", { name: "Recusar" }).click();
  await challenge.waitFor({ state: "hidden" });
  await white.page.setViewportSize({ width: 1280, height: 720 });
  await waitText(black.page.locator("#bet-status"), /refusada|recusada/);
  assert.deepEqual(await boardLabels(black.page), friendlyBoard);
  await propose(black.page, white.page);
  await white.page.reload();
  await eventually(async () => assert.equal(await white.page.locator("#profile-nickname").inputValue(), "Dama da Serra"));
  await waitText(white.page.locator("#black-player"), /Águia Azul/);
  await white.page.locator("#bet-accept").waitFor({ state: "visible" });
  const desktopBounds = await challenge.boundingBox();
  const viewport = white.page.viewportSize();
  assert.ok(Math.abs(desktopBounds.x + desktopBounds.width / 2 - viewport.width / 2) < 2);
  assert.ok(Math.abs(desktopBounds.y + desktopBounds.height / 2 - viewport.height / 2) < 2);
  await accept(white.page);
  await eventually(async () => {
    assert.deepEqual(await Promise.all([boardLabels(black.page), boardLabels(white.page)]), initialBoards);
    assert.equal(await white.page.locator("#lower-player .player-tag").innerText(), "Sua vez");
  });
  await waitText(black.page.locator("#wallet-balance"), /495/);
  await waitText(white.page.locator("#wallet-balance"), /495/);
  for (const { page } of [black, white]) {
    await page.locator("#arena-bet").waitFor({ state: "visible" });
    await waitText(page.locator("#arena-stake"), /^5,00 créditos$/);
    await waitText(page.locator("#arena-prize"), /^9,50 créditos$/);
  }
  if (process.env.DAMAS_ARENA_SCREENSHOT) {
    await black.page.screenshot({ path: process.env.DAMAS_ARENA_SCREENSHOT, fullPage: true });
    await white.page.setViewportSize({ width: 390, height: 760 });
    assert.ok(await white.page.locator("#arena-bet").isVisible());
    assert.equal(await white.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await white.page.screenshot({ path: process.env.DAMAS_ARENA_SCREENSHOT.replace(/\.png$/, "-mobile.png"), fullPage: true });
    await white.page.setViewportSize({ width: 1280, height: 720 });
  }
  assert.equal((await assertBet(code, "reserved")).resolution, null);

  await white.setOffline(true);
  await waitText(black.page.locator("#turn-title"), /AGUARDANDO RECONEXÃO/);
  const boardBefore = await white.page.locator("#board .cell").evaluateAll(cells => cells.map(cell => cell.getAttribute("aria-label")));
  const overlay = black.page.getByRole("dialog", { name: "Adversário desconectado" });
  const offlineOverlay = white.page.locator("#disconnect-overlay");
  await overlay.waitFor({ state: "visible" });
  const offlineNotice = white.page.locator("#offline-notice");
  await offlineNotice.waitFor({ state: "visible" });
  await white.page.getByRole("button", { name: "Tentar reconectar" }).click();
  await waitText(white.page.locator("#offline-status"), /Sem conexão/);
  await offlineOverlay.waitFor({ state: "hidden" });
  assert.equal(await black.page.locator("#reconnect-button").count(), 0);
  assert.equal(await black.page.locator("#disconnect-title").evaluate(el => el === document.activeElement), true);
  const firstTick = await black.page.locator("#disconnect-countdown").innerText();
  assert.match(firstTick.trim(), /^00:0[1-7]$/);
  await eventually(async () => assert.notEqual(await black.page.locator("#disconnect-countdown").innerText(), firstTick));
  if (process.env.DAMAS_ALERT_SCREENSHOT) {
    await black.page.screenshot({ path: process.env.DAMAS_ALERT_SCREENSHOT });
    await black.page.setViewportSize({ width: 390, height: 760 });
    await black.page.emulateMedia({ reducedMotion: "reduce" });
    assert.equal(await overlay.evaluate(el => getComputedStyle(el).animationName), "none");
    await black.page.screenshot({ path: process.env.DAMAS_ALERT_SCREENSHOT.replace(/\.png$/, "-mobile.png") });
    await black.page.setViewportSize({ width: 1280, height: 720 });
    if (process.env.DAMAS_OFFLINE_SCREENSHOT) await white.page.screenshot({ path: process.env.DAMAS_OFFLINE_SCREENSHOT });
  }
  await black.page.reload();
  await overlay.waitFor({ state: "visible" });
  await offlineOverlay.waitFor({ state: "hidden" });
  await white.setOffline(false);
  await waitText(white.page.locator("#room-info"), /Partida em andamento/);
  await offlineNotice.waitFor({ state: "hidden" });
  await overlay.waitFor({ state: "hidden" });
  assert.equal(await white.page.locator("#room-code").inputValue(), code);
  await waitText(white.page.locator("#turn-title"), /É SUA VEZ/);
  assert.deepEqual(await white.page.locator("#board .cell").evaluateAll(cells => cells.map(cell => cell.getAttribute("aria-label"))), boardBefore);
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
    await waitText(black.page.locator("#arena-result-credit"), /Liquidação pendente/);
    assert.equal((await assertBet(code, "reserved")).resolution, "payout");
  } finally {
    await blocker.query("ROLLBACK");
    blocker.release();
  }
  const completed = await assertBet(code, "finished");
  await waitText(black.page.locator("#arena-result-credit"), /^Prêmio pago ao vencedor: 9,50 créditos$/);
  await waitText(white.page.locator("#arena-result-credit"), /^Prêmio pago ao vencedor: 9,50 créditos$/);
  await waitText(black.page.locator("#arena-result-reason"), /peças|jogadas legais/);
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

  await black.page.locator("#return-lobby").click();
  await white.page.locator("#arena-result").waitFor({ state: "visible" });
  await white.page.locator("#return-lobby").click();
  await white.page.locator("#arena-result").waitFor({ state: "hidden" });
  const resigned = await createRoom(black.page, white.page);
  await propose(black.page, white.page);
  await accept(white.page);
  const reserved = await assertBet(resigned, "reserved");
  assert.equal(await white.page.locator("#leave-room").innerText(), "Desistir");
  const resignBlocker = await pool.connect();
  try {
    await resignBlocker.query("BEGIN");
    await resignBlocker.query("LOCK TABLE public.bet_transactions IN ACCESS EXCLUSIVE MODE");
    await white.page.locator("#leave-room").click();
    await resignDialog.waitFor({ state: "visible" });
    await waitText(white.page.locator("#resign-stake"), /perde os 5,00 créditos.*9,50 créditos/);
    await resignDialog.getByRole("button", { name: "Confirmar desistência" }).click();
    await waitText(black.page.locator("#turn-title"), /PRETAS VENCERAM POR ABANDONO/);
    await waitText(white.page.locator("#status"), /As brancas desistiram/);
    for (const player of [black, white]) {
      await waitText(player.page.locator("#room-info"), /Sala encerrada/);
      await player.page.locator("#arena-result").waitFor({ state: "visible" });
    }
    const health = await readHealth(port);
    assert.equal(health.activeRooms, 0);
    await white.page.locator("#return-lobby").click();
    await white.page.locator("#arena-result").waitFor({ state: "hidden" });
    await black.page.locator("#arena-result").waitFor({ state: "visible" });
    await waitText(black.page.locator("#arena-result-credit"), /Liquidação pendente/);
  } finally {
    await resignBlocker.query("ROLLBACK");
    resignBlocker.release();
  }
  await assertAbandonmentPayout(resigned, reserved.creator_uid);
  await waitText(black.page.locator("#arena-result-credit"), /Prêmio pago ao vencedor: 9,50 créditos/);
  await black.page.locator("#return-lobby").click();
  await black.page.locator("#arena-result").waitFor({ state: "hidden" });
  console.log("OK: desistência imediata pagou o adversário uma única vez.");

  const expired = await createRoom(black.page, white.page);
  await propose(black.page, white.page);
  await accept(white.page);
  const expiryBet = await assertBet(expired, "reserved");
  await white.setOffline(true);
  await waitText(black.page.locator("#turn-title"), /AGUARDANDO RECONEXÃO/);
  await overlay.waitFor({ state: "visible" });
  await offlineOverlay.waitFor({ state: "hidden" });
  await waitText(black.page.locator("#turn-title"), /PRETAS VENCERAM POR ABANDONO/);
  await overlay.waitFor({ state: "hidden" });
  await assertAbandonmentPayout(expired, expiryBet.creator_uid);
  await black.page.locator("#return-lobby").click();
  await white.setOffline(false);
  await waitText(white.page.locator("#turn-title"), /PRETAS VENCERAM POR ABANDONO/);
  await offlineNotice.waitFor({ state: "hidden" });
  await assertAbandonmentPayout(expired, expiryBet.creator_uid);
  await waitText(white.page.locator("#arena-result-credit"), /Prêmio pago ao vencedor: 9,50 créditos/);
  await white.page.locator("#return-lobby").click();
  await white.page.locator("#arena-result").waitFor({ state: "hidden" });
  console.log("OK: prazo vencido pagou o jogador conectado e a volta tardia mostrou o resultado.");

  const bothOffline = await createRoom(black.page, white.page);
  await propose(black.page, white.page);
  await accept(white.page);
  await assertBet(bothOffline, "reserved");
  await Promise.all([black.setOffline(true), white.setOffline(true)]);
  await assertRefund(bothOffline);
  await Promise.all([black.setOffline(false), white.setOffline(false)]);
  await Promise.all([black, white].map(({ page }) => page.locator("#leave-room").waitFor({ state: "hidden" })));
  console.log("OK: dois jogadores desconectados causaram estorno, sem vencedor.");

  const interrupted = await createRoom(black.page, white.page);
  await propose(black.page, white.page);
  await accept(white.page);
  await assertBet(interrupted, "reserved");
  await stopServer();
  await startServer(port + 1);
  await assertRefund(interrupted);
  await stopServer();
  await startServer(port + 2);
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


"use strict";

(() => {
  // =====================================================
  // DAMAS ONLINE  CLIENTE MULTIPLAYER
  // Compatível com os IDs do index.html enviado.
  // O servidor é a autoridade da partida online.
  // =====================================================

  const $ = id => document.getElementById(id);

  const boardElement = $("board");
  const statusElement = $("status");
  const resetButton = $("reset");
  const createRoomButton = $("create-room");
  const joinRoomButton = $("join-room");
  const roomCodeInput = $("room-code");
  const roomInfoElement = $("room-info");
    // CARTEIRA VIRTUAL
  const walletBalanceElement = $("wallet-balance");
  const walletMessageElement = $("wallet-message");
  const refreshWalletButton = $("refresh-wallet");
// SISTEMA DE APOSTAS
const betAmountInput = $("bet-amount");
const betCreateButton = $("bet-create");
const betChallenge = $("bet-challenge");
const betChallengeOpen = $("bet-challenge-open");
const betChallengeStatus = $("bet-challenge-status");
const betChallengePlayer = $("bet-challenge-player");
const betChallengeAmount = $("bet-challenge-amount");
const betAcceptButton = $("bet-accept");
const betDeclineButton = $("bet-decline");
const betStatusElement = $("bet-status");
  const liveStatusElement = $("live-status");
  const liveStatusText = $("live-status-text");
  const turnBannerElement = $("turn-banner");
  const turnTitleElement = $("turn-title");
  const turnDescriptionElement = $("turn-description");

  const blackCardElement = $("black-card");
  const whiteCardElement = $("white-card");
  const blackPlayerElement = $("black-player");
  const whitePlayerElement = $("white-player");

  const { BLACK, WHITE, SIZE, createMatch, getLegalMoves, applyMove } = DamasRules;

  let match = createMatch();
  let { board, turn, mustContinue, capturedThisTurn } = match;
  let selectedPiece = null;
  let legalMoves = [];
  let gameOver = false;
  let movePending = false;

  let socket = null;
  let getFirebaseToken = null;
  let refreshFirebaseToken = false;
  let onlineBet = null;
  let deferredBetId = null;
  let respondingBetId = null;
  let onlineResult = null;
  let roomExitAction = null;
  let nicknames = { black: null, white: null };
  let opponentConnected = false;
  let savedNickname = null;
  let submittedNickname = null;
  let walletGeneration = 0;
  let walletRetry = null;
  let walletBalance = null;
  let bettingAvailable = false;
  let opponentTimer = null;
  let opponentAlertPending = false;
  let reconnectTimer = null;
  let attemptTimer = null;
  let connectionAttempt = 0;
  let sessionReplaced = false;

  let onlineRoomCode = null;
  let onlineMatchVersion = 0;
  let onlinePlayerColor = null;
  let onlineGameActive = false;
  let roomControlsRegistered = false;

  // ------------------ TABULEIRO ------------------

  function resetBoard() {
    match = createMatch();
    ({ board, turn, mustContinue, capturedThisTurn } = match);
    selectedPiece = null;
    legalMoves = [];
    gameOver = false;
    movePending = false;
  }

  function normalizeBoard(source) {
    if (!Array.isArray(source) || source.length !== SIZE) {
      return null;
    }

    const result = [];

    for (const row of source) {
      if (!Array.isArray(row) || row.length !== SIZE) {
        return null;
      }

      const normalizedRow = [];

      for (const piece of row) {
        if (piece == null) {
          normalizedRow.push(null);
        } else if (
          typeof piece === "object" &&
          (piece.color === BLACK || piece.color === WHITE)
        ) {
          normalizedRow.push({
            color: piece.color,
            king: Boolean(piece.king)
          });
        } else {
          return null;
        }
      }

      result.push(normalizedRow);
    }

    return result;
  }

  function legalMovesFor(r, c) {
    if (gameOver || movePending) return [];

    return getLegalMoves({ board, mustContinue, capturedThisTurn }, r, c, turn)
      .map(move => ({
        from: { row: r, col: c },
        to: { row: move.r, col: move.c },
        ...move
      }));
  }

  function applyLocalMove(move) {
    const outcome = applyMove(match, { r: move.from.row, c: move.from.col }, move);
    ({ board, turn, mustContinue, capturedThisTurn } = match);
    selectedPiece = mustContinue ? { row: mustContinue.r, col: mustContinue.c } : null;
    legalMoves = mustContinue ? legalMovesFor(mustContinue.r, mustContinue.c) : [];
    gameOver = Boolean(outcome.winner || outcome.draw);

    if (gameOver) {
      const result = outcome.draw
        ? "Empate por repetição de posição."
        : outcome.winner === WHITE ? "As brancas venceram!" : "As pretas venceram!";
      setStatus(result);
      updateTurnBanner(result, "finished");
    } else {
      if (outcome.continuing) setStatus("Continue capturando com a mesma peça.");
      updateTurnBanner();
    }

    renderBoard();
    updatePlayerCards();
  }

  // ------------------ CLIQUES NO TABULEIRO ------------------

  function handleCellClick(r, c) {
    // Regra fundamental:
    // se há uma sala online, nunca executar jogada local.
    if (onlineRoomCode) {
      if (!onlineGameActive) {
        setStatus("Aguardando o segundo jogador iniciar a partida.");
        return;
      }

      if (!socket?.connected) {
        setStatus("Conexão perdida. Aguarde a reconexão.");
        return;
      }

      if (gameOver || movePending) return;
      if (!opponentConnected) {
        setStatus("Aguarde a reconexão do adversário.");
        return;
      }

      if (turn !== onlinePlayerColor) {
        setStatus("Aguarde a jogada do adversário.");
        return;
      }

      const chosen = legalMoves.find(
        m => m.to.row === r && m.to.col === c
      );

      if (chosen) {
        sendOnlineMove(chosen);
        return;
      }

      const piece = board[r]?.[c];

      if (piece && piece.color === onlinePlayerColor) {
        selectedPiece = { row: r, col: c };
        legalMoves = legalMovesFor(r, c);
        renderBoard();

        if (!legalMoves.length) {
          setStatus("Essa peça não tem jogadas disponíveis.");
        }

        return;
      }

      if (!mustContinue) {
        selectedPiece = null;
        legalMoves = [];
        renderBoard();
      }

      return;
    }

    // Modo local: permitido apenas sem uma sala online.
    if (gameOver || movePending) return;

    const chosen = legalMoves.find(
      m => m.to.row === r && m.to.col === c
    );

    if (chosen) {
      applyLocalMove(chosen);
      return;
    }

    const piece = board[r]?.[c];

    if (piece && piece.color === turn) {
      selectedPiece = { row: r, col: c };
      legalMoves = legalMovesFor(r, c);
      renderBoard();

      if (!legalMoves.length) {
        setStatus("Essa peça não tem jogadas disponíveis.");
      }

      return;
    }

    if (!mustContinue) {
      selectedPiece = null;
      legalMoves = [];
      renderBoard();
    }
  }

  // ------------------ DESENHO DO TABULEIRO ------------------

  function renderBoard() {
    const focused = boardElement.contains(document.activeElement)
      ? document.activeElement.dataset
      : null;
    boardElement.innerHTML = "";
    const flipped = onlinePlayerColor === BLACK;

    for (let row = 0; row < SIZE; row++) {
      const r = flipped ? SIZE - 1 - row : row;
      for (let column = 0; column < SIZE; column++) {
        const c = flipped ? SIZE - 1 - column : column;
        const cell = document.createElement("button");

        cell.type = "button";
        cell.className =
          `cell ${(r + c) % 2 === 0 ? "light" : "dark"}`;

        cell.dataset.row = String(r);
        cell.dataset.col = String(c);
        const selected = selectedPiece?.row === r && selectedPiece?.col === c;
        const target = legalMoves.some(m => m.to.row === r && m.to.col === c);
        const piece = board[r][c];
        const description = piece
          ? `${piece.king ? "Dama" : "Peça"} ${piece.color === WHITE ? "branca" : "preta"}`
          : "Vazia";
        const captured = capturedThisTurn.some(pos => pos.r === r && pos.c === c);
        cell.setAttribute("aria-label", [
          `Linha ${r + 1}, coluna ${c + 1}`, description,
          captured && "Capturada", selected && "Selecionada", target && "Destino disponível"
        ].filter(Boolean).join(", "));
        cell.setAttribute("aria-pressed", String(selected));
        cell.classList.toggle("captured", captured);

        cell.classList.toggle("selected", selected);
        cell.classList.toggle("target", target);

        if (piece) {
          const element = document.createElement("div");
          element.className =
            `piece ${piece.color}${piece.king ? " king" : ""}`;
          cell.appendChild(element);
        }

        cell.addEventListener("click", () => handleCellClick(r, c));
        boardElement.appendChild(cell);
        if (focused?.row === String(r) && focused.col === String(c)) {
          cell.focus({ preventScroll: true });
        }
      }
    }
  }

  // ------------------ STATUS E INDICADORES ------------------

  function setStatus(message) {
    statusElement.textContent = message;
  }

  function setRoomInfo(message) {
    roomInfoElement.textContent = message;
  }
  // ------------------ CARTEIRA VIRTUAL ------------------

  const balanceFormat = new Intl.NumberFormat("pt-BR", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  });

  function cancelWalletRequest() {
    walletGeneration++;
    clearTimeout(walletRetry);
    walletRetry = null;
  }

  function renderWallet(message) {
    walletBalanceElement.textContent = walletBalance === null ? "—" : balanceFormat.format(walletBalance);
    walletMessageElement.textContent = message;
  }

  function requestWallet(attempt = 0) {
    cancelWalletRequest();
    if (!socket?.connected) {
      renderWallet(walletBalance === null
        ? "Aguardando conexão para consultar seu saldo."
        : "Último saldo conhecido. Aguardando conexão.");
      return;
    }

    const generation = walletGeneration;
    renderWallet(walletBalance === null ? "Carregando saldo..." : "Atualizando saldo...");
    socket.timeout(9000).emit("wallet:request", (error, payload) => {
      if (generation !== walletGeneration) return;
      if (!error && payload?.success && typeof payload.balance === "number" &&
          Number.isFinite(payload.balance) && payload.balance >= 0) {
        walletBalance = payload.balance;
        renderWallet("Saldo atualizado.");
        return;
      }

      const retry = socket?.connected && attempt < 3 && (error || payload?.retryable);
      const message = walletBalance === null
        ? "Saldo temporariamente indisponível."
        : "Último saldo conhecido. Atualização indisponível.";
      renderWallet(message + (retry ? " Tentando novamente..." : " Use Atualizar saldo para tentar de novo."));
      if (retry) walletRetry = setTimeout(() => requestWallet(attempt + 1), 2000 * (attempt + 1));
    });
  }

  function updateLiveStatus(active) {
    if (!liveStatusElement || !liveStatusText) return;

    liveStatusElement.classList.toggle("in-match", active);
    liveStatusElement.classList.toggle("offline", !active);
    liveStatusText.textContent = active ? "EM PARTIDA" : "AGUARDANDO";
  }

  function updateTurnBanner(message = null, state = null) {
    if (!turnBannerElement) return;
    turnBannerElement.hidden = Boolean(onlineRoomCode && (gameOver ||
      (onlineGameActive && opponentConnected && !mustContinue)));
    const announcement = $("arena-turn-announcement");
    const turnText = turnBannerElement.hidden && !gameOver
      ? (turn === onlinePlayerColor ? "Sua vez" : "Vez do adversário") : "";
    if (announcement.textContent !== turnText) announcement.textContent = turnText;

    turnBannerElement.classList.remove(
      "waiting", "my-turn", "your-turn",
      "opponent-turn", "finished"
    );

    if (state) {
      turnBannerElement.classList.add(state);
    } else if (gameOver) {
      turnBannerElement.classList.add("finished");
    } else if (!onlineRoomCode || !onlineGameActive) {
      turnBannerElement.classList.add("waiting");
    } else if (turn === onlinePlayerColor) {
      turnBannerElement.classList.add("your-turn");
    } else {
      turnBannerElement.classList.add("opponent-turn");
    }

    if (turnTitleElement) {
      turnTitleElement.textContent = message
        ? message.toUpperCase()
        : !onlineRoomCode
          ? `MODO LOCAL · VEZ DAS ${turn === WHITE ? "BRANCAS" : "PRETAS"}`
          : !onlineGameActive
            ? "⏳ AGUARDANDO OPONENTE"
            : turn === onlinePlayerColor
              ? "⚡ É SUA VEZ!"
              : "⏳ VEZ DO OPONENTE";
    }

    if (turnDescriptionElement) {
      turnDescriptionElement.textContent = message ||
        (!onlineRoomCode
          ? "Partida local. Crie ou entre em uma sala para jogar online."
          : !onlineGameActive
            ? "A partida começa quando o segundo jogador entrar."
            : mustContinue
              ? "Continue capturando com a mesma peça."
              : turn === onlinePlayerColor
                ? "Selecione uma peça e faça sua jogada."
                : "Aguarde o movimento do adversário.");
    }

    updateLiveStatus(Boolean(onlineRoomCode && onlineGameActive));
  }

  function updatePlayerCards() {
    const blackIsSelf = onlinePlayerColor === BLACK;
    const upper = blackIsSelf ? whiteCardElement : blackCardElement;
    const lower = blackIsSelf ? blackCardElement : whiteCardElement;
    if (upper.parentElement.id !== "upper-player") {
      $("upper-player").append(upper);
      $("lower-player").append(lower);
    }

    for (const [color, card, label] of [
      [BLACK, blackCardElement, blackPlayerElement],
      [WHITE, whiteCardElement, whitePlayerElement]
    ]) {
      const isSelf = color === onlinePlayerColor;
      const active = !gameOver && turn === color &&
        (!onlineRoomCode || (onlineGameActive && opponentConnected));
      const badge = card.querySelector(".player-tag");
      const fallback = color === WHITE ? "Jogador das brancas" : "Jogador das pretas";
      label.textContent = onlineRoomCode
        ? `${nicknames[color] || (isSelf || opponentConnected ? fallback : "Aguardando jogador")}${isSelf ? " (você)" : ""}`
        : "Partida local";
      card.classList.toggle("active-turn", active);
      badge.hidden = !onlineRoomCode || !active;
      badge.dataset.turn = isSelf ? "self" : "opponent";
      badge.textContent = isSelf ? "Sua vez" : "Vez do adversário";
    }
  }

  function renderArenaSummary() {
    const credits = value => `${balanceFormat.format(Number(value))} créditos`;
    const reserved = onlineBet?.status === "reserved";
    $("arena-bet").hidden = !onlineRoomCode || !reserved || Boolean(onlineResult);
    if (reserved) {
      $("arena-stake").textContent = credits(onlineBet.amount);
      $("arena-prize").textContent = credits(onlineBet.prize);
    }

    $("arena-result").hidden = !onlineResult;
    if (!onlineResult) return;
    const { winner, reason } = onlineResult;
    const color = winner === WHITE ? "Brancas" : "Pretas";
    const nickname = nicknames[winner];
    $("arena-result-title").textContent = winner
      ? nickname ? `${nickname} venceu · ${color}` : `${color} venceram`
      : "Empate";
    $("arena-result-reason").textContent = reason;
    const credit = $("arena-result-credit");
    const payout = onlineBet?.payout;
    const refund = onlineBet?.refund;
    credit.hidden = payout == null && refund == null && !reserved;
    credit.textContent = payout != null ? `Prêmio pago ao vencedor: ${credits(payout)}`
      : refund != null ? `Estorno por jogador: ${credits(refund)}`
      : reserved ? "Créditos reservados. Liquidação pendente." : "";
    $("play-again").disabled = !socket?.connected || Boolean(roomExitAction);
    $("return-lobby").disabled = !socket?.connected || Boolean(roomExitAction);
  }

  function messageOf(payload, fallback) {
    if (typeof payload === "string" && payload) return payload;
    if (payload && typeof payload.message === "string") {
      return payload.message;
    }
    return fallback;
  }

  function getRoomCode(payload) {
    const value = typeof payload === "string"
      ? payload
      : payload?.code ?? payload?.roomCode;

    return typeof value === "string"
      ? value.trim().toUpperCase()
      : "";
  }

  // ------------------ SOCKET.IO ------------------

  function updateResignMessage() {
    const credits = value => `${balanceFormat.format(Number(value))} créditos`;
    $("resign-stake").textContent = onlineBet?.status === "reserved"
      ? `Você perde os ${credits(onlineBet.amount)} já reservados. Seu adversário recebe o prêmio líquido de ${credits(onlineBet.prize)}.`
      : onlineBet?.status === "pending"
        ? "A aposta ainda não foi aceita. Se for aceita antes da confirmação, você perde a reserva e seu adversário recebe o prêmio líquido."
        : "Não há aposta aceita. Nenhum crédito será descontado.";
  }

  function cancelResignDialog() {
    const dialog = $("resign-dialog");
    if (dialog.open) dialog.close("cancel");
  }

  function renderBet() {
    if ($("resign-dialog").open) updateResignMessage();
    renderArenaSummary();
    const pending = onlineBet?.status === "pending";
    const canRespond = pending && onlineBet.responderColor === onlinePlayerColor;
    const ready = Boolean(bettingAvailable && socket?.connected && onlineGameActive && opponentConnected && !gameOver);
    betCreateButton.disabled = !ready || Boolean(onlineBet && onlineBet.status !== "cancelled");
    const available = canRespond && ready;
    const responding = available && respondingBetId === onlineBet.id;
    betChallengeOpen.hidden = !available;
    betAcceptButton.disabled = !available || responding;
    betDeclineButton.disabled = !available || responding;
    if (!pending) deferredBetId = respondingBetId = null;
    if (!available) {
      if (betChallenge.open) betChallenge.close();
      betChallengeStatus.hidden = true;
    } else {
      const amount = balanceFormat.format(Number(onlineBet.amount));
      const challenger = nicknames[onlinePlayerColor === BLACK ? WHITE : BLACK] || "Seu adversário";
      betChallengePlayer.textContent = `${challenger} desafiou você para uma aposta.`;
      betChallengeAmount.textContent = amount;
      if (!betChallenge.open && deferredBetId !== onlineBet.id && !$("resign-dialog").open && !$("disconnect-overlay").open) {
        betChallenge.showModal();
      }
    }
    if (!bettingAvailable && onlineGameActive) {
      betStatusElement.textContent = "Apostas temporariamente indisponíveis.";
      return;
    }
    betStatusElement.textContent = ({
      pending: canRespond ? "Você recebeu um pedido de aposta." : "Aguardando resposta do adversário.",
      reserved: gameOver ? "Créditos reservados. Liquidação pendente." : "Aposta aceita. Créditos reservados.",
      cancelled: "Aposta cancelada.",
      finished: "Aposta liquidada."
    })[onlineBet?.status] || "Aguardando uma aposta.";
  }

  function hideOpponentAlert() {
    opponentAlertPending = false;
    clearInterval(opponentTimer);
    opponentTimer = null;
    const overlay = $("disconnect-overlay");
    if (overlay.open) overlay.close();
  }

  function showOpponentAlert(deadline, serverTime) {
    if (!socket?.connected || gameOver || opponentConnected || !onlineRoomCode) {
      hideOpponentAlert();
      return;
    }

    clearInterval(opponentTimer);
    const overlay = $("disconnect-overlay");
    const countdown = $("disconnect-countdown");
    const status = $("disconnect-status");
    status.textContent = "Aguardando o adversário voltar.";
    opponentAlertPending = true;
    if (!overlay.open && !$("resign-dialog").open) overlay.showModal();

    if (!Number.isFinite(deadline) || !Number.isFinite(serverTime)) {
      countdown.textContent = "—";
      return;
    }

    const localDeadline = performance.now() + Math.max(0, deadline - serverTime);
    function update() {
      const seconds = Math.max(0, Math.ceil((localDeadline - performance.now()) / 1000));
      const minutes = String(Math.floor(seconds / 60)).padStart(2, "0");
      const remainder = String(seconds % 60).padStart(2, "0");
      countdown.textContent = `${minutes}:${remainder}`;
      if (!seconds) {
        clearInterval(opponentTimer);
        opponentTimer = null;
        status.textContent = "Prazo encerrado. Aguardando o resultado do servidor.";
      }
    }
    opponentTimer = setInterval(update, 250);
    update();
  }

  function clearOnlineRoom(message) {
    cancelResignDialog();
    onlineRoomCode = null;
    onlinePlayerColor = null;
    onlineGameActive = false;
    opponentConnected = false;
    onlineBet = null;
    onlineResult = null;
    roomExitAction = null;
    nicknames = { black: null, white: null };
    roomCodeInput.value = "";
    $("offline-notice").hidden = true;
    $("leave-room").hidden = true;
    hideOpponentAlert();
    resetBoard();
    renderBoard();
    updatePlayerCards();
    updateTurnBanner();
    renderBet();
    if (message) {
      setStatus(message);
      setRoomInfo(message);
    }
  }

  function restoreOnlineRoom(payload) {
    const code = getRoomCode(payload);
    const normalized = normalizeBoard(payload?.board);
    if (!code || !normalized) {
      setStatus("Não foi possível sincronizar o tabuleiro.");
      return;
    }

    onlineRoomCode = payload.roomReleased ? null : code;
    roomCodeInput.value = onlineRoomCode || "";
    if (payload.color === BLACK || payload.color === WHITE) onlinePlayerColor = payload.color;
    if (!onlinePlayerColor) return;

    board = normalized;
    onlineMatchVersion = payload.matchVersion ?? 0;
    turn = payload.turn === BLACK ? BLACK : WHITE;
    mustContinue = payload.mustContinue || null;
    capturedThisTurn = Array.isArray(payload.capturedThisTurn) ? payload.capturedThisTurn : [];
    gameOver = Boolean(payload.gameOver);
    if (gameOver) cancelResignDialog();
    onlineResult = gameOver ? { code, winner: payload.winner, reason: payload.resultReason || payload.message || "" } : null;
    movePending = false;
    onlineGameActive = Boolean(payload.started) && !gameOver;
    opponentConnected = Boolean(payload.players?.[onlinePlayerColor === WHITE ? BLACK : WHITE]);
    onlineBet = payload.bet || null;
    nicknames = payload.nicknames || { black: null, white: null };
    selectedPiece = mustContinue && turn === onlinePlayerColor
      ? { row: mustContinue.r, col: mustContinue.c }
      : null;
    legalMoves = selectedPiece ? legalMovesFor(selectedPiece.row, selectedPiece.col) : [];

    $("offline-notice").hidden = true;
    $("leave-room").hidden = gameOver;
    $("leave-room").textContent = onlineGameActive ? "Desistir" : "Sair da sala";
    renderBoard();
    updatePlayerCards();
    renderBet();

    setRoomInfo(payload.roomReleased ? "Sala encerrada. Você já pode iniciar outra partida." : onlineGameActive
      ? `Sala ${code} · ${opponentConnected ? "Partida em andamento" : "Aguardando reconexão do adversário"}.`
      : `Sala ${code}.`);
    const message = payload.message || (gameOver
      ? payload.winner === WHITE ? "As brancas venceram!"
        : payload.winner === BLACK ? "As pretas venceram!" : "Partida empatada."
      : null);
    if (message) setStatus(message);
    if (gameOver) updateTurnBanner(message, "finished");
    else if (!opponentConnected && onlineGameActive) updateTurnBanner("AGUARDANDO RECONEXÃO", "waiting");
    else updateTurnBanner();

    const opponent = onlinePlayerColor === WHITE ? BLACK : WHITE;
    if (onlineGameActive && !opponentConnected) showOpponentAlert(payload.reconnectDeadlines?.[opponent], payload.serverTime);
    else hideOpponentAlert();
  }

  function updateProfileSave() {
    $("profile-save").disabled = !socket?.connected || savedNickname === null ||
      submittedNickname !== null || $("profile-nickname").value.trim() === savedNickname;
  }

  function disconnectSocket() {
    cancelConnectionTimers();
    refreshFirebaseToken = false;
    $("offline-notice").hidden = true;
    sessionReplaced = false;
    if (socket) {
      socket.removeAllListeners();
      socket.disconnect();
      socket = null;
    }

    if (onlineRoomCode || onlineResult) clearOnlineRoom();
    savedNickname = submittedNickname = null;
    $("profile-name").textContent = "Jogador";
    $("profile-nickname").value = "";
    $("profile-message").textContent = "";
    $("profile-save").disabled = true;
    cancelWalletRequest();
    walletBalance = null;
    bettingAvailable = false;
    renderWallet("Entre para consultar seu saldo.");
    renderBet();
  }

  function cancelConnectionTimers() {
    clearTimeout(reconnectTimer);
    clearTimeout(attemptTimer);
    reconnectTimer = attemptTimer = null;
    connectionAttempt++;
    $("retry-connection").disabled = false;
  }

  function scheduleConnectionAttempt() {
    if (!socket || !getFirebaseToken || sessionReplaced || socket.connected || attemptTimer || reconnectTimer) return;
    reconnectTimer = setTimeout(attemptConnection, 2000);
  }

  function attemptConnection() {
    if (!socket || !getFirebaseToken || sessionReplaced || socket.connected || attemptTimer) return;
    clearTimeout(reconnectTimer);
    reconnectTimer = null;

    const notice = $("offline-notice");
    const feedback = $("offline-status");
    if (navigator.onLine === false) {
      if (!notice.hidden) feedback.textContent = "Sem conexão. Tentaremos novamente quando ela voltar.";
      scheduleConnectionAttempt();
      return;
    }

    const current = socket;
    cancelConnectionTimers();
    if (!notice.hidden) feedback.textContent = "Tentando reconectar…";
    $("retry-connection").disabled = true;
    attemptTimer = setTimeout(() => {
      if (socket !== current) return;
      cancelConnectionTimers();
      if (current.connected) return;
      current.disconnect();
      if (!notice.hidden) feedback.textContent = "A conexão demorou. Tentaremos novamente.";
      scheduleConnectionAttempt();
    }, 10000);
    current.connect();
  }

  function connectSocket() {
    if (socket || typeof io !== "function") return;

    socket = io({
      autoConnect: false,
      reconnection: false,
      tryAllTransports: true,
      timeout: 8000,
      auth: async callback => {
        const current = socket;
        const attempt = connectionAttempt;
        const token = await Promise.resolve().then(() => getFirebaseToken?.(refreshFirebaseToken)).catch(() => null);
        if (socket === current && connectionAttempt === attempt) callback(token ? { token } : {});
      }
    });

    registerSocketEvents();
    attemptConnection();
  }

function registerSocketEvents() {

  // =============================================
  // CONEXÃO COM O SERVIDOR
  // =============================================

  socket.on("connect", () => {
    cancelConnectionTimers();
    refreshFirebaseToken = false;
    $("retry-connection").textContent = "Tentar reconectar";
    console.log("[SOCKET] Conectado:", socket.id);

    // Solicita o saldo da carteira
    requestWallet();

    // O servidor informa se a conta ainda possui uma sala.
    if (onlineRoomCode) {
      onlineGameActive = false;
      movePending = false;
      if (!$("offline-notice").hidden) $("offline-status").textContent = "Conectado. Recuperando a partida…";

      setStatus("Conexão restabelecida. Recuperando a partida...");
      setRoomInfo(`Tentando recuperar a sala ${onlineRoomCode}...`);
      updateTurnBanner("RECUPERANDO PARTIDA", "waiting");
    } else {
      $("offline-notice").hidden = true;
      setStatus("Conectado ao servidor.");
      setRoomInfo("Conexão pronta. Crie uma sala ou entre com um código.");
    }
  });


  // =============================================
  // RESPOSTA DA CARTEIRA VIRTUAL
  // =============================================

  socket.on("wallet:changed", () => requestWallet());
  socket.on("bet:availability", ({ ready }) => {
    bettingAvailable = ready === true;
    renderBet();
  });

  socket.on("profile:state", ({ nickname }) => {
    const input = $("profile-nickname");
    const next = nickname || "";
    if (!$("profile-dialog").open || input.value === (savedNickname ?? "")) input.value = next;
    savedNickname = next;
    $("profile-name").textContent = next || "Jogador";
    updateProfileSave();
  });
  socket.on("profile:saved", ({ nickname }) => {
    const input = $("profile-nickname");
    if (input.value === submittedNickname) input.value = nickname || "";
    submittedNickname = null;
    $("profile-message").textContent = nickname ? "Apelido atualizado." : "O nome padrão está ativo.";
    updateProfileSave();
  });
  socket.on("profile:error", ({ message }) => {
    submittedNickname = null;
    $("profile-message").textContent = message;
    updateProfileSave();
  });
  socket.on("profiles:update", payload => {
    if (payload.code !== onlineRoomCode) return;
    nicknames = payload.nicknames;
    updatePlayerCards();
  });

  socket.on("roomResumed", restoreOnlineRoom);
  socket.on("playerReconnected", payload => {
    if (payload.code === onlineRoomCode) restoreOnlineRoom(payload);
  });
  socket.on("roomStateUnavailable", payload => {
    if (onlineRoomCode) clearOnlineRoom(messageOf(payload, "A partida foi encerrada."));
  });
  socket.on("roomLeft", payload => {
    const action = roomExitAction;
    clearOnlineRoom(payload.message);
    if (action === "new-room" && socket?.connected) createRoomButton.click();
    else if (action === "lobby") createRoomButton.focus();
  });
  socket.on("playerLeft", payload => clearOnlineRoom(payload.message));
  socket.on("playerDisconnected", payload => {
    if (payload.code !== onlineRoomCode) return;
    movePending = false;
    opponentConnected = false;
    updatePlayerCards();
    if (gameOver) return;
    setRoomInfo(payload.message);
    if (onlineGameActive) showOpponentAlert(payload.reconnectDeadline, payload.serverTime);
    updateTurnBanner("AGUARDANDO RECONEXÃO", "waiting");
    renderBet();
  });

  socket.on("connect_error", error => {
    cancelConnectionTimers();
    const code = error?.data?.code;
    if (code === "AUTH_MISSING" || code === "AUTH_REJECTED") refreshFirebaseToken = true;
    const message = code === "AUTH_UNAVAILABLE" ? "Autenticação do servidor indisponível. Tentando reconectar…"
      : refreshFirebaseToken ? "Sua conta está conectada. Tentando validar a sessão com o servidor…"
      : "Sua conta está conectada. Tentando reconectar ao servidor…";
    showConnectionNotice(message);
    scheduleConnectionAttempt();
    setStatus("Falha ao conectar ao servidor.");
    setRoomInfo(message);
  });

  socket.on("disconnect", reason => {
    cancelResignDialog();
    cancelConnectionTimers();
    sessionReplaced = reason === "io server disconnect";
    roomExitAction = null;
    respondingBetId = null;
    submittedNickname = null;
    scheduleConnectionAttempt();
    hideOpponentAlert();
    bettingAvailable = false;
    requestWallet();
    onlineGameActive = false;
    movePending = false;
    $("profile-save").disabled = true;
    updatePlayerCards();
    renderBet();
    const message = sessionReplaced
      ? "Sua conta retomou a partida em outra aba ou dispositivo."
      : "Conexão com o servidor perdida. Tentando reconectar…";
    showConnectionNotice(message);
    setStatus(message);
    setRoomInfo(message);
    if (!onlineRoomCode) return;
    updateTurnBanner("RECONEXÃO NECESSÁRIA", "waiting");
  });

    socket.on("roomCreated", payload => {
      const code = getRoomCode(payload);

      if (!code) {
        setRoomInfo("O servidor não retornou o código da sala.");
        return;
      }

      onlineRoomCode = code;
      onlinePlayerColor = payload.color || BLACK;
      onlineGameActive = false;

      selectedPiece = null;
      legalMoves = [];
      movePending = false;

      roomCodeInput.value = code;
      setRoomInfo(`Sala ${code} criada. Envie o código ao adversário.`);
      setStatus("Aguardando o segundo jogador.");

      updatePlayerCards();
      updateTurnBanner();
    });

    socket.on("roomJoined", payload => {
      const code = getRoomCode(payload);

      if (!code) {
        setRoomInfo("O servidor não retornou o código da sala.");
        return;
      }

      onlineRoomCode = code;
      onlinePlayerColor = payload.color || WHITE;
      onlineGameActive = false;

      selectedPiece = null;
      legalMoves = [];
      movePending = false;

      setRoomInfo(`Entrou na sala ${code}. Sincronizando tabuleiro...`);
      setStatus("Aguardando confirmação do servidor.");

      updatePlayerCards();
      updateTurnBanner();
    });

    socket.on("gameReady", restoreOnlineRoom);
    socket.on("roomInfo", restoreOnlineRoom);

    socket.on("roomError", payload => {
      setRoomInfo(messageOf(payload, "Erro ao acessar a sala."));
    });

    socket.on("moveRejected", payload => {
      movePending = false;
      setStatus(messageOf(payload, "O servidor recusou a jogada."));
      renderBoard();
    });

    socket.on("boardUpdate", restoreOnlineRoom);

    socket.on("bet:created", data => {
      if (data.code !== onlineRoomCode) return;
      onlineBet = { ...data, responderColor: onlinePlayerColor };
      renderBet();
    });

    socket.on("bet:sent", data => {
      if (data.code !== onlineRoomCode) return;
      onlineBet = data;
      renderBet();
    });

    socket.on("bet:response", data => {
      if (!onlineBet || onlineBet.id !== data.id || data.code !== (onlineRoomCode || onlineResult?.code)) return;
      onlineBet = { ...onlineBet, ...data };
      renderBet();
      betStatusElement.textContent = data.message;
    });

    socket.on("bet:error", data => {
      respondingBetId = null;
      renderBet();
      const message = data.message || "Não foi possível processar a aposta.";
      betStatusElement.textContent = message;
      if (betChallenge.open) {
        betChallengeStatus.textContent = message;
        betChallengeStatus.hidden = false;
      }
    });
  }

  // ------------------ SALAS ------------------

  // ------------------ SALAS ------------------

  function showConnectionNotice(message) {
    $("offline-status").textContent = message;
    $("retry-connection").textContent = sessionReplaced ? "Retomar aqui" : "Tentar reconectar";
    $("offline-notice").hidden = false;
  }

  function canUseOnlineRooms() {
    if (socket?.connected) return true;
    if (!getFirebaseToken) {
      setRoomInfo("Entre na sua conta para jogar online.");
      return false;
    }
    const message = sessionReplaced ? "A partida está em outra aba ou dispositivo. Selecione Retomar aqui para jogar nesta tela."
      : "Sua conta está conectada. Aguarde a conexão com o servidor.";
    setRoomInfo(message);
    showConnectionNotice(message);
    if (socket) attemptConnection();
    else connectSocket();
    return false;
  }

function registerRoomControls() {
  if (roomControlsRegistered) return;
  roomControlsRegistered = true;
  function exitResult(action) {
    if (!socket?.connected || !onlineResult || roomExitAction) return;
    roomExitAction = action;
    renderArenaSummary();
    socket.emit("leaveRoom");
  }
  $("play-again").addEventListener("click", () => exitResult("new-room"));
  $("return-lobby").addEventListener("click", () => exitResult("lobby"));
  const resignDialog = $("resign-dialog");
  function openResignDialog() {
    if (!socket?.connected || !onlineGameActive || gameOver || resignDialog.open) return;
    updateResignMessage();
    resignDialog.returnValue = "cancel";
    resignDialog.showModal();
  }

  $("resign-during-reconnect").addEventListener("click", openResignDialog);
  $("leave-room").addEventListener("click", () => {
    if (!socket?.connected) return;
    if (onlineGameActive) openResignDialog();
    else socket.emit("leaveRoom");
  });
  resignDialog.addEventListener("close", () => {
    if (resignDialog.returnValue === "resign" && socket?.connected && onlineGameActive && !gameOver) {
      socket.emit("resignGame");
    } else if (opponentAlertPending && socket?.connected && onlineGameActive && !gameOver) {
      const overlay = $("disconnect-overlay");
      if (!overlay.open) overlay.showModal();
    }
  });
  $("disconnect-overlay").addEventListener("cancel", event => event.preventDefault());
  $("disconnect-overlay").addEventListener("close", renderBet);
  resignDialog.addEventListener("close", renderBet);
  $("retry-connection").addEventListener("click", () => {
    sessionReplaced = false;
    $("retry-connection").textContent = "Tentar reconectar";
    if (socket) attemptConnection();
    else connectSocket();
  });
  window.addEventListener("online", attemptConnection);
  createRoomButton.addEventListener("click", () => {
    if (!canUseOnlineRooms()) return;

    if (onlineRoomCode) {
      setRoomInfo("Você já está em uma sala. Saia dela antes de criar outra.");
      return;
    }

    setRoomInfo("Criando sala...");
    socket.emit("createRoom");
  });

  joinRoomButton.addEventListener("click", () => {
    if (!canUseOnlineRooms()) return;

    if (onlineRoomCode) {
      setRoomInfo("Você já está em uma sala. Saia dela antes de entrar em outra.");
      return;
    }

    const code = roomCodeInput.value.trim().toUpperCase();

    if (!/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/.test(code)) {
      setRoomInfo("Digite um código válido de seis caracteres.");
      return;
    }

    setRoomInfo(`Entrando na sala ${code}...`);
    socket.emit("joinRoom", code);
  });

  roomCodeInput.addEventListener("input", () => {
    roomCodeInput.value = roomCodeInput.value
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, "")
      .slice(0, 6);
  });
}

// ------------------ CONTROLES DAS APOSTAS ------------------

function registerBetControls() {
  if (!betCreateButton || !betAcceptButton || !betDeclineButton) {
    console.error("[Apostas] Botões não encontrados no HTML.");
    return;
  }

  betCreateButton.addEventListener("click", () => {
    const amount = Number(betAmountInput.value);

    if (!socket?.connected) {
      betStatusElement.textContent = "Você não está conectado ao servidor.";
      return;
    }

    if (!onlineRoomCode || !onlineGameActive) {
      betStatusElement.textContent = "Entre em uma partida online antes de apostar.";
      return;
    }

    if (!Number.isFinite(amount) || amount < 0.01 || amount > 5) {
      betStatusElement.textContent =
        "A aposta deve ser entre 0,01 e 5 créditos.";
      return;
    }

    betStatusElement.textContent = "Enviando pedido de aposta...";
    betCreateButton.disabled = true;

    socket.emit("bet:create", { amount });
  });

  function deferBetChallenge() {
    deferredBetId = onlineBet?.id;
    betChallenge.close();
  }

  betChallenge.addEventListener("cancel", event => {
    event.preventDefault();
    deferBetChallenge();
  });
  $("bet-challenge-later").addEventListener("click", deferBetChallenge);
  betChallengeOpen.addEventListener("click", () => {
    deferredBetId = null;
    renderBet();
  });

  function respondToBet(accepted) {
    if (!socket?.connected || betAcceptButton.disabled) return;
    respondingBetId = onlineBet.id;
    betChallengeStatus.textContent = "Enviando resposta…";
    betChallengeStatus.hidden = false;
    renderBet();
    socket.emit("bet:respond", { accepted, betId: onlineBet.id });
  }

  betAcceptButton.addEventListener("click", () => respondToBet(true));
  betDeclineButton.addEventListener("click", () => respondToBet(false));
}

  // ------------------ JOGADAS ONLINE ------------------
  // IMPORTANTE:
  // O cliente usa row/col; o servidor espera r/c.

  function sendOnlineMove(move) {
    if (!onlineRoomCode || !onlineGameActive) {
      setStatus("A partida online ainda não está pronta.");
      return;
    }

    if (!socket?.connected) {
      setStatus("Sem conexão com o servidor.");
      return;
    }

    if (movePending) return;

    if (turn !== onlinePlayerColor) {
      setStatus("Não é a sua vez.");
      return;
    }

    movePending = true;

    socket.emit("moveAttempt", {
      matchVersion: onlineMatchVersion,
      from: {
        r: move.from.row,
        c: move.from.col
      },
      to: {
        r: move.to.row,
        c: move.to.col
      }
    });

    setStatus("Jogada enviada. Aguardando o servidor...");
  }

  // ------------------ PARTIDA LOCAL ------------------

  function startLocalGame() {
    if (onlineRoomCode) {
      setStatus("Você ainda está em uma sala online.");
      setRoomInfo("Não é possível reiniciar localmente durante uma sala online.");
      return;
    }

    resetBoard();
    renderBoard();
    updatePlayerCards();
    updateTurnBanner();

    setStatus("Partida local iniciada.");
    setRoomInfo("Partida local. Crie uma sala para jogar online.");
  }

  resetButton.addEventListener("click", startLocalGame);
  const profileDialog = $("profile-dialog");
  const profileInput = $("profile-nickname");
  $("profile-open").addEventListener("click", () => {
    if (profileDialog.open) return;
    profileInput.value = submittedNickname ?? savedNickname ?? "";
    $("profile-message").textContent = "";
    $("login-message").textContent = "";
    updateProfileSave();
    profileDialog.showModal();
  });
  $("profile-close").addEventListener("click", () => profileDialog.close());
  profileInput.addEventListener("input", () => {
    $("profile-message").textContent = "";
    updateProfileSave();
  });
  $("profile-form").addEventListener("submit", event => {
    event.preventDefault();
    if ($("profile-save").disabled) return;
    submittedNickname = profileInput.value;
    updateProfileSave();
    socket.emit("profile:update", { nickname: submittedNickname });
  });

  if (refreshWalletButton) {
    refreshWalletButton.addEventListener("click", () => requestWallet());
}

  // ------------------ LOGIN FIREBASE ------------------

  window.addEventListener("firebase-user-token", event => {
    getFirebaseToken = event.detail?.getToken || null;
    if (!getFirebaseToken) {
      disconnectSocket();
      setStatus("Entre na sua conta para jogar online.");
      return;
    }
    connectSocket();
  });

  // ------------------ INICIALIZAÇÃO ------------------

  const required = [
    boardElement,
    statusElement,
    resetButton,
    createRoomButton,
    joinRoomButton,
    roomCodeInput,
    roomInfoElement
  ];

  if (required.some(element => !element)) {
    console.error(
      "[Damas Online] Um ou mais elementos necessários não existem no index.html."
    );
    return;
  }

  registerRoomControls();
registerBetControls();
  renderBet();

resetBoard();
renderBoard();
updatePlayerCards();
updateTurnBanner();
updateLiveStatus(false);

setStatus("Aguardando conexão com o servidor.");
setRoomInfo("Conecte-se para criar ou entrar em uma sala.");

})();
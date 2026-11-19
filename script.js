
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
const betResponseArea = $("bet-response-area");
const betRequestMessage = $("bet-request-message");
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
  let onlineBet = null;
  let nicknames = { black: null, white: null };
  let disconnectTimer = null;
  let opponentConnected = false;
  let submittedNickname = null;
  let walletGeneration = 0;
  let walletRetry = null;
  let walletBalance = null;
  let bettingAvailable = false;
  let reconnectGraceMs = 120000;
  let disconnectDeadline = null;

  let onlineRoomCode = null;
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

    for (let r = 0; r < SIZE; r++) {
      for (let c = 0; c < SIZE; c++) {
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
    function playerLabel(color, fallback) {
      const name = nicknames[color] || fallback;
      return onlinePlayerColor === color ? `${name} (você)` : name;
    }

    if (blackPlayerElement) {
      blackPlayerElement.textContent = onlineRoomCode
        ? playerLabel(BLACK, "Jogador das pretas")
        : "Partida local";
    }

    if (whitePlayerElement) {
      whitePlayerElement.textContent = onlineRoomCode
        ? playerLabel(WHITE, "Jogador das brancas")
        : "Partida local";
    }

    if (blackCardElement) {
      blackCardElement.classList.toggle(
        "active-turn",
        Boolean(!gameOver && (!onlineRoomCode || onlineGameActive) && turn === BLACK)
      );
    }

    if (whiteCardElement) {
      whiteCardElement.classList.toggle(
        "active-turn",
        Boolean(!gameOver && (!onlineRoomCode || onlineGameActive) && turn === WHITE)
      );
    }
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

  function renderBet() {
    const pending = onlineBet?.status === "pending";
    const canRespond = pending && onlineBet.responderColor === onlinePlayerColor;
    const ready = Boolean(bettingAvailable && socket?.connected && onlineGameActive && opponentConnected && !gameOver);
    betCreateButton.disabled = !ready || Boolean(onlineBet && onlineBet.status !== "cancelled");
    betResponseArea.hidden = !canRespond || !ready;
    betAcceptButton.disabled = !canRespond || !ready;
    betDeclineButton.disabled = !canRespond || !ready;
    if (canRespond) {
      const amount = Number(onlineBet.amount).toLocaleString("pt-BR", { minimumFractionDigits: 2 });
      betRequestMessage.textContent = `Seu adversário propôs uma aposta de ${amount} créditos. Deseja aceitar?`;
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

  function hideDisconnectOverlay() {
    clearInterval(disconnectTimer);
    disconnectTimer = null;
    disconnectDeadline = null;
    $("disconnect-overlay").hidden = true;
  }

  function showDisconnectOverlay() {
    clearInterval(disconnectTimer);
    const overlay = $("disconnect-overlay");
    overlay.hidden = false;
    // Local estimate until the server confirms the state of the room.
    disconnectDeadline ??= Date.now() + reconnectGraceMs;
    const countdown = $("disconnect-countdown");
    function tick() {
      const remaining = Math.max(0, Math.ceil((disconnectDeadline - Date.now()) / 1000));
      countdown.textContent = `${String(Math.floor(remaining / 60)).padStart(2, "0")}:${String(remaining % 60).padStart(2, "0")}`;
      if (!remaining) clearInterval(disconnectTimer);
    }
    tick();
    disconnectTimer = setInterval(tick, 1000);
  }

  function clearOnlineRoom(message) {
    onlineRoomCode = null;
    onlinePlayerColor = null;
    onlineGameActive = false;
    opponentConnected = false;
    onlineBet = null;
    nicknames = { black: null, white: null };
    roomCodeInput.value = "";
    $("leave-room").hidden = true;
    hideDisconnectOverlay();
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

    onlineRoomCode = code;
    roomCodeInput.value = code;
    if (payload.color === BLACK || payload.color === WHITE) onlinePlayerColor = payload.color;
    if (!onlinePlayerColor) return;

    board = normalized;
    turn = payload.turn === BLACK ? BLACK : WHITE;
    mustContinue = payload.mustContinue || null;
    capturedThisTurn = Array.isArray(payload.capturedThisTurn) ? payload.capturedThisTurn : [];
    gameOver = Boolean(payload.gameOver);
    movePending = false;
    onlineGameActive = Boolean(payload.started) && !gameOver;
    opponentConnected = Boolean(payload.players?.[onlinePlayerColor === WHITE ? BLACK : WHITE]);
    onlineBet = payload.bet || null;
    if (Number.isFinite(payload.reconnectGraceMs)) reconnectGraceMs = payload.reconnectGraceMs;
    nicknames = payload.nicknames || { black: null, white: null };
    selectedPiece = mustContinue && turn === onlinePlayerColor
      ? { row: mustContinue.r, col: mustContinue.c }
      : null;
    legalMoves = selectedPiece ? legalMovesFor(selectedPiece.row, selectedPiece.col) : [];

    $("leave-room").hidden = false;
    $("leave-room").textContent = onlineGameActive ? "Desistir" : "Sair da sala";
    hideDisconnectOverlay();
    renderBoard();
    updatePlayerCards();
    renderBet();

    setRoomInfo(onlineGameActive
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
  }

  function disconnectSocket() {
    if (socket) {
      socket.removeAllListeners();
      socket.disconnect();
      socket = null;
    }

    if (onlineRoomCode) clearOnlineRoom();
    $("profile-nickname").value = "";
    $("profile-message").textContent = "";
    $("profile-save").disabled = true;
    cancelWalletRequest();
    walletBalance = null;
    bettingAvailable = false;
    renderWallet("Entre para consultar seu saldo.");
    renderBet();
  }

  function connectSocket() {
    if (socket || typeof io !== "function") return;

    socket = io({
      autoConnect: false,
      auth: async callback => {
        try {
          callback({ token: await getFirebaseToken?.() });
        } catch {
          callback({});
        }
      },
      reconnection: true,
      reconnectionDelay: 1000
    });

    registerSocketEvents();
    socket.connect();
  }

function registerSocketEvents() {

  // =============================================
  // CONEXÃO COM O SERVIDOR
  // =============================================

  socket.on("connect", () => {
    console.log("[SOCKET] Conectado:", socket.id);

    // Solicita o saldo da carteira
    requestWallet();

    // O servidor informa se a conta ainda possui uma sala.
    if (onlineRoomCode) {
      onlineGameActive = false;
      movePending = false;

      setStatus("Conexão restabelecida. Recuperando a partida...");
      setRoomInfo(`Tentando recuperar a sala ${onlineRoomCode}...`);
      updateTurnBanner("RECUPERANDO PARTIDA", "waiting");
    } else {
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
    if (document.activeElement !== input) input.value = nickname || "";
    $("profile-save").disabled = false;
  });
  socket.on("profile:saved", ({ nickname }) => {
    const input = $("profile-nickname");
    if (input.value === submittedNickname) input.value = nickname || "";
    submittedNickname = null;
    $("profile-message").textContent = nickname ? "Apelido salvo." : "O nome padrão está ativo.";
    $("profile-save").disabled = false;
  });
  socket.on("profile:error", ({ message }) => {
    $("profile-message").textContent = message;
    $("profile-save").disabled = false;
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
  socket.on("roomLeft", payload => clearOnlineRoom(payload.message));
  socket.on("playerLeft", payload => clearOnlineRoom(payload.message));
  socket.on("playerDisconnected", payload => {
    movePending = false;
    opponentConnected = false;
    if (gameOver) return;
    setRoomInfo(payload.message);
    updateTurnBanner("AGUARDANDO RECONEXÃO", "waiting");
    renderBet();
  });

  socket.on("connect_error", error => {
    setStatus("Falha ao conectar ao servidor.");
    setRoomInfo(error?.message || "Verifique o login e o servidor.");
  });

  socket.on("disconnect", () => {
    bettingAvailable = false;
    requestWallet();
    onlineGameActive = false;
    movePending = false;
    $("profile-save").disabled = true;
    renderBet();
    if (!onlineRoomCode) return;
    setStatus("Conexão perdida. Aguardando reconexão.");
    updateTurnBanner("RECONEXÃO NECESSÁRIA", "waiting");
    showDisconnectOverlay();
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
      if (!onlineBet || onlineBet.id !== data.id || data.code !== onlineRoomCode) return;
      onlineBet.status = data.status;
      renderBet();
      betStatusElement.textContent = data.message;
    });

    socket.on("bet:error", data => {
      renderBet();
      betStatusElement.textContent = data.message || "Não foi possível processar a aposta.";
    });
  }

  // ------------------ SALAS ------------------

  // ------------------ SALAS ------------------

function registerRoomControls() {
  if (roomControlsRegistered) return;
  roomControlsRegistered = true;
  $("leave-room").addEventListener("click", () => {
    if (socket?.connected) socket.emit(onlineGameActive ? "resignGame" : "leaveRoom");
  });
  $("reconnect-button").addEventListener("click", () => {
    if (socket?.connected) socket.emit("requestRoomState");
    else socket?.connect();
  });

  createRoomButton.addEventListener("click", () => {
    if (!socket?.connected) {
      setRoomInfo("Entre na sua conta e aguarde a conexão.");
      return;
    }

    if (onlineRoomCode) {
      setRoomInfo("Você já está em uma sala. Saia dela antes de criar outra.");
      return;
    }

    setRoomInfo("Criando sala...");
    socket.emit("createRoom");
  });

  joinRoomButton.addEventListener("click", () => {
    if (!socket?.connected) {
      setRoomInfo("Entre na sua conta e aguarde a conexão.");
      return;
    }

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

  betAcceptButton.addEventListener("click", () => {
    if (!socket?.connected) return;

    betStatusElement.textContent = "Enviando resposta...";
    betAcceptButton.disabled = true;
    betDeclineButton.disabled = true;

    socket.emit("bet:respond", { accepted: true, betId: onlineBet?.id });
  });

  betDeclineButton.addEventListener("click", () => {
    if (!socket?.connected) return;

    betStatusElement.textContent = "Recusando aposta...";
    betAcceptButton.disabled = true;
    betDeclineButton.disabled = true;

    socket.emit("bet:respond", { accepted: false, betId: onlineBet?.id });
  });
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
  $("profile-form").addEventListener("submit", event => {
    event.preventDefault();
    if (!socket?.connected) {
      $("profile-message").textContent = "Aguarde a conexão para salvar.";
      return;
    }
    $("profile-save").disabled = true;
    submittedNickname = $("profile-nickname").value;
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
setRoomInfo("Entre com o Google para criar ou entrar em uma sala.");

})();
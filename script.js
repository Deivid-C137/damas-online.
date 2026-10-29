
"use strict";

(() => {
  // =====================================================
  // DAMAS ONLINE — CLIENTE MULTIPLAYER
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

  const liveStatusElement = $("live-status");
  const liveStatusText = $("live-status-text");
  const turnBannerElement = $("turn-banner");
  const turnTitleElement = $("turn-title");
  const turnDescriptionElement = $("turn-description");

  const blackCardElement = $("black-card");
  const whiteCardElement = $("white-card");
  const blackPlayerElement = $("black-player");
  const whitePlayerElement = $("white-player");

  const BLACK = "black";
  const WHITE = "white";
  const SIZE = 8;

  let board = [];
  let turn = BLACK;
  let selectedPiece = null;
  let legalMoves = [];
  let mustContinue = null;
  let gameOver = false;
  let movePending = false;

  let socket = null;
  let firebaseToken = null;

  let onlineRoomCode = null;
  let onlinePlayerColor = null;
  let onlineGameActive = false;
  let roomControlsRegistered = false;

  // ------------------ TABULEIRO ------------------

  function initialBoard() {
    const result = Array.from(
      { length: SIZE },
      () => Array(SIZE).fill(null)
    );

    for (let r = 0; r < 3; r++) {
      for (let c = 0; c < SIZE; c++) {
        if ((r + c) % 2 === 1) {
          result[r][c] = { color: BLACK, king: false };
        }
      }
    }

    for (let r = 5; r < SIZE; r++) {
      for (let c = 0; c < SIZE; c++) {
        if ((r + c) % 2 === 1) {
          result[r][c] = { color: WHITE, king: false };
        }
      }
    }

    return result;
  }

  function resetBoard() {
    board = initialBoard();
    turn = BLACK;
    selectedPiece = null;
    legalMoves = [];
    mustContinue = null;
    gameOver = false;
    movePending = false;
  }

  function inside(r, c) {
    return r >= 0 && r < SIZE && c >= 0 && c < SIZE;
  }

  function otherColor(color) {
    return color === BLACK ? WHITE : BLACK;
  }

  function cloneBoard(source) {
    return source.map(row =>
      row.map(piece =>
        piece
          ? { color: piece.color, king: Boolean(piece.king) }
          : null
      )
    );
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

  // ------------------ MOVIMENTOS LOCAIS ------------------
  // Usados somente no modo offline.
  // O servidor valida todas as jogadas online.

  function simpleMoves(r, c) {
    const piece = board[r]?.[c];
    if (!piece) return [];

    const moves = [];
    const directions = piece.king
      ? [[-1, -1], [-1, 1], [1, -1], [1, 1]]
      : [[piece.color === BLACK ? 1 : -1, -1],
         [piece.color === BLACK ? 1 : -1, 1]];

    for (const [dr, dc] of directions) {
      let nr = r + dr;
      let nc = c + dc;

      while (inside(nr, nc) && !board[nr][nc]) {
        moves.push({
          from: { row: r, col: c },
          to: { row: nr, col: nc },
          capture: null
        });

        if (!piece.king) break;

        nr += dr;
        nc += dc;
      }
    }

    return moves;
  }

  function capturesFor(r, c, source = board) {
    const piece = source[r]?.[c];
    if (!piece) return [];

    const captures = [];
    const directions = [
      [-1, -1], [-1, 1], [1, -1], [1, 1]
    ];

    for (const [dr, dc] of directions) {
      let nr = r + dr;
      let nc = c + dc;

      if (!piece.king) {
        const lr = r + dr * 2;
        const lc = c + dc * 2;

        if (
          inside(nr, nc) &&
          inside(lr, lc) &&
          source[nr][nc] &&
          source[nr][nc].color !== piece.color &&
          !source[lr][lc]
        ) {
          captures.push({
            from: { row: r, col: c },
            to: { row: lr, col: lc },
            capture: { row: nr, col: nc }
          });
        }

        continue;
      }

      let enemy = null;

      while (inside(nr, nc)) {
        const occupant = source[nr][nc];

        if (!occupant) {
          if (enemy) {
            captures.push({
              from: { row: r, col: c },
              to: { row: nr, col: nc },
              capture: { ...enemy }
            });
          }
        } else {
          if (occupant.color === piece.color || enemy) break;
          enemy = { row: nr, col: nc };
        }

        nr += dr;
        nc += dc;
      }
    }

    return captures;
  }

  function allCaptures(color = turn) {
    const result = [];

    for (let r = 0; r < SIZE; r++) {
      for (let c = 0; c < SIZE; c++) {
        if (board[r][c]?.color === color) {
          result.push(...capturesFor(r, c));
        }
      }
    }

    return result;
  }

  function legalMovesFor(r, c) {
    const piece = board[r]?.[c];

    if (
      !piece ||
      piece.color !== turn ||
      gameOver ||
      movePending
    ) {
      return [];
    }

    if (
      mustContinue &&
      (mustContinue.r !== r || mustContinue.c !== c)
    ) {
      return [];
    }

    if (mustContinue) return capturesFor(r, c);

    const captures = allCaptures();

    if (captures.length) {
      return captures.filter(
        move =>
          move.from.row === r &&
          move.from.col === c
      );
    }

    return simpleMoves(r, c);
  }

  function promote(piece, row) {
    if (
      piece &&
      !piece.king &&
      ((piece.color === BLACK && row === 7) ||
       (piece.color === WHITE && row === 0))
    ) {
      piece.king = true;
    }
  }

  function applyLocalMove(move) {
    const next = cloneBoard(board);
    const piece = next[move.from.row][move.from.col];

    if (!piece) return false;

    next[move.from.row][move.from.col] = null;
    next[move.to.row][move.to.col] = piece;

    if (move.capture) {
      next[move.capture.row][move.capture.col] = null;
    }

    promote(piece, move.to.row);
    board = next;

    if (move.capture) {
      const nextCaptures = capturesFor(
        move.to.row,
        move.to.col
      );

      if (nextCaptures.length) {
        mustContinue = {
          r: move.to.row,
          c: move.to.col
        };

        selectedPiece = {
          row: move.to.row,
          col: move.to.col
        };

        legalMoves = nextCaptures;
        setStatus("Continue capturando com a mesma peça.");
        renderBoard();
        updateTurnBanner();
        return;
      }
    }

    mustContinue = null;
    selectedPiece = null;
    legalMoves = [];
    turn = otherColor(turn);

    if (localGameEnded()) return;

    renderBoard();
    updateTurnBanner();
    updatePlayerCards();
  }

  function localGameEnded() {
    let blackCount = 0;
    let whiteCount = 0;
    let hasMove = false;

    for (let r = 0; r < SIZE; r++) {
      for (let c = 0; c < SIZE; c++) {
        const piece = board[r][c];
        if (!piece) continue;

        if (piece.color === BLACK) blackCount++;
        else whiteCount++;

        if (piece.color === turn) {
          if (simpleMoves(r, c).length || capturesFor(r, c).length) {
            hasMove = true;
          }
        }
      }
    }

    if (!blackCount || !whiteCount || !hasMove) {
      gameOver = true;

      const winner = !blackCount
        ? WHITE
        : !whiteCount
          ? BLACK
          : otherColor(turn);

      setStatus(
        `${winner === BLACK ? "Pretas" : "Brancas"} venceram!`
      );

      updateTurnBanner(
        `${winner === BLACK ? "Pretas" : "Brancas"} venceram!`,
        "finished"
      );

      renderBoard();
      return true;
    }

    return false;
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
    boardElement.innerHTML = "";

    for (let r = 0; r < SIZE; r++) {
      for (let c = 0; c < SIZE; c++) {
        const cell = document.createElement("button");

        cell.type = "button";
        cell.className =
          `cell ${(r + c) % 2 === 0 ? "light" : "dark"}`;

        cell.dataset.row = String(r);
        cell.dataset.col = String(c);
        cell.setAttribute("aria-label", `Linha ${r + 1}, coluna ${c + 1}`);

        if (
          selectedPiece &&
          selectedPiece.row === r &&
          selectedPiece.col === c
        ) {
          cell.classList.add("selected");
        }

        if (legalMoves.some(m => m.to.row === r && m.to.col === c)) {
          cell.classList.add("target");
        }

        const piece = board[r][c];

        if (piece) {
          const element = document.createElement("div");
          element.className =
            `piece ${piece.color}${piece.king ? " king" : ""}`;
          cell.appendChild(element);
        }

        cell.addEventListener("click", () => handleCellClick(r, c));
        boardElement.appendChild(cell);
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
          ? "MODO LOCAL"
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
    if (blackPlayerElement) {
      blackPlayerElement.textContent = onlineRoomCode
        ? onlinePlayerColor === BLACK ? "Você" : "Jogador das pretas"
        : "Partida local";
    }

    if (whitePlayerElement) {
      whitePlayerElement.textContent = onlineRoomCode
        ? onlinePlayerColor === WHITE ? "Você" : "Jogador das brancas"
        : "Partida local";
    }

    if (blackCardElement) {
      blackCardElement.classList.toggle(
        "active-turn",
        Boolean(onlineGameActive && turn === BLACK)
      );
    }

    if (whiteCardElement) {
      whiteCardElement.classList.toggle(
        "active-turn",
        Boolean(onlineGameActive && turn === WHITE)
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

function restoreOnlineRoom(payload) {
  if (!payload || typeof payload !== "object") {
    setStatus("Dados inválidos para recuperar a partida.");
    return;
  }

  const snapshot = payload.snapshot || payload.state || payload;
  const code = getRoomCode(payload) || getRoomCode(snapshot);
  const normalized = normalizeBoard(snapshot.board);

  if (!normalized) {
    setStatus("Não foi possível recuperar o tabuleiro.");
    return;
  }

  if (code) {
    onlineRoomCode = code;
    roomCodeInput.value = code;
  }

  if (payload.color === BLACK || payload.color === WHITE) {
    onlinePlayerColor = payload.color;
  } else if (snapshot.color === BLACK || snapshot.color === WHITE) {
    onlinePlayerColor = snapshot.color;
  }

  if (!onlineRoomCode || !onlinePlayerColor) {
    setStatus("Faltam dados para recuperar a sala.");
    return;
  }

  board = normalized;
  turn = snapshot.turn === WHITE ? WHITE : BLACK;

  const continuation = snapshot.mustContinue || null;

  mustContinue =
    continuation &&
    Number.isInteger(continuation.r) &&
    Number.isInteger(continuation.c)
      ? { r: continuation.r, c: continuation.c }
      : null;

  gameOver = Boolean(snapshot.gameOver);
  selectedPiece = null;
  legalMoves = [];
  movePending = false;
  onlineGameActive = Boolean(snapshot.started);

  renderBoard();
  updatePlayerCards();

  setRoomInfo(`Sala ${onlineRoomCode} recuperada.`);
  setStatus(
    onlineGameActive
      ? "Partida recuperada."
      : "Sala recuperada. Aguardando o adversário."
  );

  updateTurnBanner();
}

  function disconnectSocket() {
    if (socket) {
      socket.removeAllListeners();
      socket.disconnect();
      socket = null;
    }

    onlineRoomCode = null;
    onlinePlayerColor = null;
    onlineGameActive = false;
    movePending = false;

    updatePlayerCards();
    updateTurnBanner();
  }

  function connectSocket(token) {
    if (!token) {
      disconnectSocket();
      setStatus("Entre com o Google para jogar online.");
      setRoomInfo("Faça login antes de criar ou entrar em uma sala.");
      return;
    }

    firebaseToken = token;

    if (socket?.connected && socket.auth?.token === token) return;

    if (socket) {
      socket.removeAllListeners();
      socket.disconnect();
      socket = null;
    }

    if (typeof io !== "function") {
      setStatus("Socket.IO não foi carregado.");
      return;
    }

    socket = io({
      auth: { token },
      reconnection: true,
      reconnectionAttempts: 10,
      reconnectionDelay: 1000
    });

    registerSocketEvents();
  }

 
function registerSocketEvents() {
  socket.on("connect", () => {
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

  socket.on("roomResumed", payload => {
    restoreOnlineRoom(payload);
  });
socket.on("playerReconnected", payload => {
  if (!onlineRoomCode) return;

  movePending = false;

  setStatus("O adversário reconectou. Sincronizando a partida...");
  setRoomInfo(`Sala ${onlineRoomCode}: reconexão do adversário detectada.`);

  // Solicita ao servidor uma atualização do estado da partida.
  socket.emit("requestRoomState", {
    code: onlineRoomCode
  });
});
  socket.on("roomStateUnavailable", payload => {
    onlineGameActive = false;
    movePending = false;

    setStatus(
      messageOf(payload, "Não foi possível recuperar a partida.")
    );

    setRoomInfo("Verifique o estado da sala antes de sair.");
    updateTurnBanner("RECONEXÃO NECESSÁRIA", "waiting");
  });

  socket.on("connect_error", error => {
    setStatus("Falha ao conectar ao servidor.");
    setRoomInfo(error?.message || "Verifique o login e o servidor.");
  });

  socket.on("disconnect", reason => {
    onlineGameActive = false;
    movePending = false;

    setStatus("Conexão perdida. A partida online está bloqueada.");
    setRoomInfo(`Conexão interrompida: ${reason}`);
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

    // O servidor atual envia este evento quando o segundo jogador entra.
   
socket.on("gameReady", payload => {
  if (!onlineRoomCode) return;

  const normalized = normalizeBoard(payload?.board);

  if (!normalized) {
    setStatus("O servidor enviou um tabuleiro inválido.");
    return;
  }

  board = normalized;
  turn = payload.turn === WHITE ? WHITE : BLACK;

  const continuation = payload.mustContinue;

  mustContinue =
    continuation &&
    Number.isInteger(continuation.r) &&
    Number.isInteger(continuation.c)
      ? { r: continuation.r, c: continuation.c }
      : null;

  gameOver = Boolean(payload.gameOver);
  movePending = false;
  selectedPiece = null;
  legalMoves = [];
  onlineGameActive = Boolean(payload.started) && !gameOver;

  setRoomInfo(`Partida sincronizada na sala ${onlineRoomCode}.`);
  setStatus(payload.message || "Partida sincronizada!");

  renderBoard();
  updatePlayerCards();
  updateTurnBanner();
});


    socket.on("roomError", payload => {
      setRoomInfo(messageOf(payload, "Erro ao acessar a sala."));
    });

    socket.on("moveRejected", payload => {
      movePending = false;
      setStatus(messageOf(payload, "O servidor recusou a jogada."));
      renderBoard();
    });

    socket.on("boardUpdate", payload => {
      if (!onlineRoomCode) return;

      const normalized = normalizeBoard(payload?.board);

      if (!normalized) {
        setStatus("Atualização de tabuleiro inválida.");
        return;
      }

      board = normalized;
      turn = payload.turn === WHITE ? WHITE : BLACK;

      const continuation = payload.mustContinue;

      mustContinue = continuation &&
        Number.isInteger(continuation.r) &&
        Number.isInteger(continuation.c)
          ? { r: continuation.r, c: continuation.c }
          : null;

      gameOver = Boolean(payload.gameOver);
      movePending = false;
      selectedPiece = null;
      legalMoves = [];

      // Receber boardUpdate significa que a partida já começou.
      onlineGameActive = true;

      renderBoard();
      updatePlayerCards();

      if (gameOver) {
        const winner = payload.winner;
        const finalMessage = payload.message ||
          (winner
            ? `${winner === BLACK ? "Pretas" : "Brancas"} venceram!`
            : "Partida encerrada.");

        setStatus(finalMessage);
        updateTurnBanner(finalMessage, "finished");
      } else {
        setStatus(payload.message || "Tabuleiro sincronizado.");
        updateTurnBanner();
      }
    });

    // Nome do evento enviado pelo server.js atual.
    socket.on("playerLeft", payload => {
      onlineGameActive = false;
      movePending = false;
      selectedPiece = null;
      legalMoves = [];

      setRoomInfo(messageOf(payload, "O adversário saiu da sala."));
      setStatus("Partida interrompida. Crie uma nova sala para jogar.");
      updateTurnBanner("AGUARDANDO OPONENTE", "waiting");
      renderBoard();
    });

   socket.on("playerDisconnected", payload => {
  movePending = false;

  setRoomInfo(
    messageOf(payload, "O adversário desconectou. Aguardando reconexão.")
  );

  setStatus("O adversário desconectou. Aguardando reconexão.");
  updateTurnBanner("AGUARDANDO OPONENTE", "waiting");
});

socket.on("playerReconnected", payload => {
  if (!onlineRoomCode) return;

  movePending = false;

  setStatus("Adversário reconectado. Sincronizando partida...");

  socket.emit("requestRoomState");
});
  }

  // ------------------ SALAS ------------------

  function registerRoomControls() {
    if (roomControlsRegistered) return;
    roomControlsRegistered = true;

    createRoomButton.addEventListener("click", () => {
      if (!socket?.connected) {
        setRoomInfo("Entre com o Google e aguarde a conexão.");
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
        setRoomInfo("Entre com o Google e aguarde a conexão.");
        return;
      }

      if (onlineRoomCode) {
        setRoomInfo("Você já está em uma sala. Saia dela antes de entrar em outra.");
        return;
      }

      const code = roomCodeInput.value.trim().toUpperCase();

      // O gerador do servidor exclui I, O, 0 e 1.
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

  // ------------------ LOGIN FIREBASE ------------------

  window.addEventListener("firebase-user-token", event => {
    const token = event.detail?.token || null;
    firebaseToken = token;

    if (!token) {
      disconnectSocket();
      setStatus("Entre com o Google para jogar online.");
      return;
    }

    connectSocket(token);
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
  resetBoard();
  renderBoard();
  updatePlayerCards();
  updateTurnBanner();
  updateLiveStatus(false);

  setStatus("Aguardando conexão com o servidor.");
  setRoomInfo("Entre com o Google para criar ou entrar em uma sala.");

})();

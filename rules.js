(function (factory) {
  const rules = factory();
  if (typeof module === "object" && module.exports) module.exports = rules;
  else globalThis.DamasRules = rules;
})(function () {
  "use strict";

  const SIZE = 8;
  const BLACK = "black";
  const WHITE = "white";

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

  function captureLength(room, r, c, move) {
    const board = cloneBoard(room.board);
    board[move.r][move.c] = board[r][c];
    board[r][c] = null;
    const nextRoom = {
      board,
      capturedThisTurn: [...room.capturedThisTurn, move.capture]
    };
    return 1 + maximumLength(getCaptures(nextRoom, move.r, move.c).map(next =>
      captureLength(nextRoom, move.r, move.c, next)
    ));
  }

  function maximumLength(lengths) {
    return Math.max(0, ...lengths);
  }

  function getLegalMoves(room, r, c, color) {
    if (!inside(r, c) || room.board[r][c]?.color !== color) return [];

    const continuation = room.mustContinue;
    if (continuation && (continuation.r !== r || continuation.c !== c)) return [];

    const captures = continuation
      ? getCaptures(room, r, c).map(move => ({
        from: { r, c }, to: { r: move.r, c: move.c }, capture: move.capture
      }))
      : getAllCaptures(room, color);

    if (!captures.length) return continuation ? [] : getSimpleMoves(room, r, c);

    const candidates = captures.map(({ from, to, capture }) => ({
      from,
      move: { ...to, capture },
      length: captureLength(room, from.r, from.c, { ...to, capture })
    }));
    const maximum = maximumLength(candidates.map(candidate => candidate.length));
    return candidates
      .filter(candidate => candidate.from.r === r && candidate.from.c === c &&
        candidate.length === maximum)
      .map(candidate => candidate.move);
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

  function createMatch() {
    const match = {
      board: createInitialBoard(),
      turn: WHITE,
      mustContinue: null,
      capturedThisTurn: [],
      repetitions: new Map()
    };
    recordPosition(match);
    return match;
  }

  function recordPosition(match) {
    const position = JSON.stringify([match.turn, match.board]);
    const count = (match.repetitions.get(position) || 0) + 1;
    match.repetitions.set(position, count);
    return count;
  }

  // Apply a move returned by getLegalMoves.
  function applyMove(match, from, move) {
    const piece = match.board[from.r][from.c];
    match.board[from.r][from.c] = null;
    match.board[move.r][move.c] = piece;

    if (move.capture) {
      match.capturedThisTurn.push(move.capture);
      if (getCaptures(match, move.r, move.c).length) {
        match.mustContinue = { r: move.r, c: move.c };
        return { continuing: true };
      }
    }

    const irreversible = match.capturedThisTurn.length > 0 || !piece.king;
    removeCapturedPieces(match);
    promotePiece(piece, move.r);
    match.mustContinue = null;
    match.turn = otherColor(match.turn);
    if (irreversible) match.repetitions.clear();

    if (!countPieces(match, match.turn) || !hasAnyLegalMove(match, match.turn)) {
      return { winner: otherColor(match.turn) };
    }
    if (recordPosition(match) >= 3) return { draw: true };
    return {};
  }

  return { SIZE, BLACK, WHITE, inside, cloneBoard, createMatch, getLegalMoves, applyMove };
});

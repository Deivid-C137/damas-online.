"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { WHITE, BLACK, createMatch, getLegalMoves, applyMove } = require("../rules");

function position(pieces) {
  const match = createMatch();
  match.board = Array.from({ length: 8 }, () => Array(8).fill(null));
  match.repetitions.clear();
  for (const [r, c, color, king = false] of pieces) match.board[r][c] = { color, king };
  return match;
}

function play(match, r, c, toR, toC) {
  const move = getLegalMoves(match, r, c, match.turn).find(m => m.r === toR && m.c === toC);
  assert.ok(move, `Jogada esperada: ${r},${c} → ${toR},${toC}`);
  return applyMove(match, { r, c }, move);
}

test("tabuleiro inicial com 12 peças por lado e brancas no primeiro turno", () => {
  const match = createMatch();
  assert.equal(match.turn, WHITE);
  for (const color of [WHITE, BLACK]) {
    assert.equal(match.board.flat().filter(piece => piece?.color === color).length, 12);
  }
});

test("só permite o trajeto máximo da mesma peça, inclusive após o primeiro salto", () => {
  const match = position([
    [7, 0, WHITE], [4, 7, WHITE], [6, 1, BLACK], [4, 1, BLACK],
    [4, 3, BLACK], [2, 5, BLACK], [5, 6, BLACK]
  ]);
  assert.deepEqual(getLegalMoves(match, 4, 7, WHITE), []);
  assert.deepEqual(play(match, 7, 0, 5, 2), { continuing: true });
  assert.deepEqual(getLegalMoves(match, 5, 2, WHITE), [{ r: 3, c: 4, capture: { r: 4, c: 3 } }]);
  assert.ok(match.board[6][1]);
  assert.deepEqual(play(match, 5, 2, 3, 4), { continuing: true });
  assert.deepEqual(play(match, 3, 4, 1, 6), {});
  assert.equal(match.board[6][1], null);
  assert.equal(match.turn, BLACK);
});

test("permite trajetos empatados, e peça simples também captura para trás", () => {
  const match = position([[3, 2, WHITE], [2, 1, BLACK], [4, 3, BLACK]]);
  assert.deepEqual(getLegalMoves(match, 3, 2, WHITE).map(({ r, c }) => [r, c]), [[1, 0], [5, 4]]);
});

test("dama voadora não atravessa a peça já capturada durante a sequência", () => {
  const match = position([[4, 3, WHITE, true], [3, 2, BLACK], [5, 4, BLACK]]);
  assert.deepEqual(play(match, 4, 3, 2, 1), {});
  assert.equal(match.turn, BLACK);
  assert.ok(match.board[5][4]);
});

test("promoção só ocorre se a peça termina a sequência na última linha", () => {
  const match = position([[2, 1, WHITE], [1, 2, BLACK], [1, 4, BLACK]]);
  assert.deepEqual(play(match, 2, 1, 0, 3), { continuing: true });
  assert.equal(match.board[0][3].king, false);
  assert.deepEqual(play(match, 0, 3, 2, 5), { winner: WHITE });
  assert.equal(match.board[2][5].king, false);

  const single = position([[2, 1, WHITE], [1, 2, BLACK]]);
  assert.deepEqual(play(single, 2, 1, 0, 3), { winner: WHITE });
  assert.equal(single.board[0][3].king, true);
});

test("empate automático ao repetir a posição e o turno pela terceira vez", () => {
  const match = position([[7, 0, WHITE, true], [0, 1, BLACK, true]]);
  for (let round = 0; round < 3; round++) {
    const outcome = play(match, 7, 0, 6, 1);
    if (round === 2) {
      assert.deepEqual(outcome, { draw: true });
      break;
    }
    assert.deepEqual(outcome, {});
    play(match, 0, 1, 1, 2);
    play(match, 6, 1, 7, 0);
    play(match, 1, 2, 0, 1);
  }
});

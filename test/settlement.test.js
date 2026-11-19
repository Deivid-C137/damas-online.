"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { quoteBet } = require("../settlement");

test("prêmio líquido da aposta usa a mesma comissão, arredondada em centavos", () => {
  assert.deepEqual(quoteBet("5.00"), { commissionCents: 50, prize: "9.50" });
  assert.deepEqual(quoteBet("0.04"), { commissionCents: 0, prize: "0.08" });
  assert.deepEqual(quoteBet("0.05"), { commissionCents: 1, prize: "0.09" });
});

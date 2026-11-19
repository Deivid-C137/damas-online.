"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { validateNickname } = require("../nicknames");

test("normaliza espaços, caracteres e acentos e aceita nomes legítimos", () => {
  assert.equal(validateNickname("  Ａna   Joa\u0303o  "), "Ana João");
  assert.equal(validateNickname("Ana-Maria_27"), "Ana-Maria_27");
  assert.equal(validateNickname("Putares"), "Putares");
  assert.equal(validateNickname("Piratapurana"), "Piratapurana");
  assert.equal(validateNickname("Essex Chess"), "Essex Chess");
  assert.equal(validateNickname("Sexagenário"), "Sexagenário");
  assert.equal(validateNickname("Luz d’Ávila"), "Luz d’Ávila");
  assert.equal(validateNickname("   "), null);
});

test("rejeita endereços de e-mail, símbolos, caracteres de controle e tamanhos inválidos", () => {
  for (const invalid of ["alguem@example.invalid", "ab", "x".repeat(25), "João\nSilva", "-Ana", "Ana😃", "Вia"]) {
    assert.throws(() => validateNickname(invalid), /apelido|letras/);
  }
  assert.throws(() => validateNickname({}), /apelido/);
});

test("rejeita xingamentos, acentos, repetições, separadores e leetspeak", () => {
  for (const invalid of ["Carálho", "F.D.P.", "f d p", "Dama f0d4", "4rromb4d0", "Puuutaaa", "Otário_77"]) {
    assert.throws(() => validateNickname(invalid.replace(/\.$/, "")), /xingamentos/);
  }
});

test("rejeita termos sexuais explícitos e referências identificáveis a conteúdo adulto", () => {
  for (const invalid of ["P0rn0", "X_Vídeos", "0nly-F4ns", "Pórn-Hub", "x x x", "s3x0 explícito", "Conteúdo Adulto", "Br4zz3rs", "Masturbação"]) {
    assert.throws(() => validateNickname(invalid), /conteúdo adulto/);
  }
});

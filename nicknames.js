"use strict";

const blockedTerms = [
  "arrombado", "arrombada", "arrombados", "babaca", "babacas", "buceta", "bucetas",
  "caralho", "caralhos", "corno", "cornos", "cuzao", "cuzona", "cu", "desgracado",
  "desgracada", "fdp", "filhodaputa", "filhadaputa", "foda", "fodas", "fodase",
  "foder", "fodido", "fodida", "merda", "merdas", "otario", "otaria", "otarios",
  "piranha", "piranhas", "porra", "porras", "puta", "putas", "puto", "putos",
  "retardado", "retardada", "tomarnocu", "vagabundo", "vagabunda", "vaisefoder",
  "viado", "viada", "viados", "vsf",
  "sexo", "sex", "sexoexplicito", "conteudoadulto",
  "porn", "porno", "pornos", "pornografia", "pornografico", "pornografica",
  "xxx", "hentai", "nudes", "nude", "masturbacao", "masturbando", "boquete", "boquetes",
  "analexplicito", "analporn", "gangbang", "blowjob", "cumshot", "deepthroat",
  "onlyfans", "pornhub", "xvideos", "xnxx", "xhamster", "redtube", "brazzers",
  "privacyadulto", "adultcontent", "nsfw"
];

function collapseRepeats(value) {
  return value.replace(/([a-z0-9])\1+/g, "$1");
}

const blocked = new Set(blockedTerms.map(collapseRepeats));
const substitutions = { 0: "o", 1: "i", 2: "z", 3: "e", 4: "a", 5: "s", 7: "t", 8: "b" };

function hasBlockedTerm(nickname) {
  const tokens = nickname.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase()
    .split(/[^a-z0-9]+/).filter(Boolean);
  for (let start = 0; start < tokens.length; start++) {
    let joined = "";
    for (let end = start; end < tokens.length; end++) {
      joined += tokens[end];
      for (const variant of [joined, joined.replace(/\d+$/, "")]) {
        const letters = variant.replace(/[01234578]/g, digit => substitutions[digit]);
        if (blocked.has(collapseRepeats(letters))) return true;
      }
    }
  }
  return false;
}

function validateNickname(input) {
  if (typeof input !== "string" || input.length > 128) {
    throw new Error("Informe um apelido válido.");
  }

  const nickname = input.normalize("NFKC").trim().replace(/\p{Zs}+/gu, " ");
  if (!nickname) return null;
  if (nickname.includes("@")) throw new Error("Endereços de e-mail não são aceitos como apelido.");
  const length = Array.from(nickname).length;
  if (length < 3 || length > 24) {
    throw new Error("O apelido deve ter entre 3 e 24 caracteres.");
  }
  if (!/^[\p{Script=Latin}0-9][\p{Script=Latin}\p{M}0-9 ._'’-]*[\p{Script=Latin}\p{M}0-9]$/u.test(nickname)) {
    throw new Error("Use letras latinas, números e separadores entre eles. Endereços de e-mail não são aceitos.");
  }
  if (hasBlockedTerm(nickname)) {
    throw new Error("Escolha um apelido sem xingamentos ou referências a conteúdo adulto.");
  }
  return nickname;
}

module.exports = { validateNickname };

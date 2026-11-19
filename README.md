# Damas Online

Damas 8 × 8 em modo local para duas pessoas e em salas online por código. O jogo usa Express, Socket.IO, Firebase Auth e PostgreSQL. As apostas usam créditos virtuais, sem depósito ou saque.

## Instalação

Use Node.js 22 ou superior e PostgreSQL. Instale as dependências com `npm ci`. Configure `DATABASE_URL` e, se o banco exigir TLS, `DATABASE_SSL=true`. Use `DATABASE_CA` quando o servidor exigir uma CA adicional. Configure `FIREBASE_SERVICE_ACCOUNT` com o JSON do Firebase Admin apenas fora do ambiente de teste. O arquivo privado `firebase-service-account.json` é uma alternativa local à variável. Configure `HOST` e `PORT` conforme a implantação.

Execute `npm run migrate` e `npm start`. As rotas `/health` e `/health/db` mostram a disponibilidade do serviço e do banco. O indicador `bettingReady` confirma que a reconciliação das apostas terminou e que a instância pode aceitar apostas.

A migração inicial é reaplicável. Em banco existente, revise o esquema antes da implantação, principalmente constraints ou enums que precisem aceitar o tipo de lançamento `stake_refunded`. A migração acrescenta `bets.resolution`, o índice de apostas ativas por sala e a tabela de apelidos. Use um papel do backend autorizado a operar as tabelas protegidas por RLS. As salas ficam em memória. Execute uma instância do jogo por banco para manter salas e apostas no mesmo processo.

## Regras e dados do jogador

- As brancas começam. O mesmo motor valida os modos local e online. É obrigatório seguir um trajeto que capture o maior número de peças, inclusive durante a sequência. Trajetos empatados são permitidos. Peças simples capturam para frente e para trás, damas percorrem a diagonal, peças capturadas bloqueiam a diagonal até o final da sequência e a promoção ocorre no fim da jogada.
- A partida tem vitória por falta de peças ou de jogadas e empate automático na terceira ocorrência da mesma posição com o mesmo lado a jogar.
- A sala fica pausada enquanto um jogador está desconectado e expira após 120 segundos. Em empate, saída ou expiração, reservas são estornadas. Após reinício, o servidor paga um resultado de vitória que chegou a ser registrado no banco e estorna reservas quando o resultado se perdeu com a sala. A liquidação é transacional e tem novas tentativas após falhas temporárias.
- O e-mail aparece no painel privado da conta autenticada. O servidor das partidas recebe o token para verificação e usa o UID para identificar a conta. O estado da sala carrega apenas os apelidos públicos para exibição, com um rótulo por cor quando o jogador deixa o apelido em branco.
- Apelidos aceitam de 3 a 24 caracteres com letras latinas, números e separadores internos. O servidor normaliza espaços e variantes Unicode e usa uma lista de termos proibidos, incluindo formas comuns de xingamentos e referências a conteúdo adulto. A checagem usa palavras ou grupos separados, evitando bloquear um nome por qualquer trecho isolado.

## Ambiente local isolado

1. Suba um PostgreSQL local descartável com usuário e banco próprios. Copie [test/local.env.example](test/local.env.example) para `.env.local` e preencha a URL local. O emulador força o aplicativo a escutar em loopback e exige um projeto `demo-`.
2. Em outro terminal, inicie o Firebase Auth Emulator. Use cadastro e login com contas sintéticas pela interface. [Documentação do Firebase Auth Emulator](https://firebase.google.com/docs/emulator-suite/connect_auth)

   ```sh
   npx firebase-tools emulators:start --only auth --project demo-damas-local --config firebase.local.json
   ```

3. Aplique a migração e suba o jogo em outro terminal.

   ```sh
   node --env-file=.env.local db/migrate.js
   node --env-file=.env.local server.js
   ```

4. Abra [http://127.0.0.1:3300](http://127.0.0.1:3300) em dois perfis de navegador. A mesma conta recupera a própria vaga, por isso use contas diferentes para jogar uma contra a outra. Encerre o Node e o Firebase Emulator com Ctrl+C nos terminais em que foram iniciados. Pare o PostgreSQL com o comando correspondente ao método de inicialização, por exemplo `pg_ctl -D <diretório-de-dados> -m fast -w stop`.

O modo local usa o Firebase SDK do navegador via CDN por padrão. Para manter também o SDK no loopback, faça um bundle ESM fora do projeto com `firebase` e `esbuild`, e configure `DAMAS_LOCAL_FIREBASE_SDK` com o caminho absoluto do bundle. O servidor só oferece esse arquivo em modo emulador.

```js
// entrada.mjs
export { initializeApp } from "firebase/app";
export * from "firebase/auth";
```

```sh
npx esbuild entrada.mjs --bundle --format=esm --outfile=local-firebase-sdk.js
```

## Testes

`npm test` executa as regressões de regras e apelidos. Para o teste de ponta a ponta, disponibilize Playwright no ambiente de teste, instale o Chromium do Playwright ou configure `DAMAS_BROWSER_PATH` com o caminho de um navegador Chromium instalado. Use o SDK local descrito acima e aplique a migração. **Use um banco exclusivamente de teste e pare o servidor manual do jogo antes da execução.** O roteiro levanta e reinicia sua própria instância na porta 3301, testa perda temporária de acesso à tabela de lançamentos e cria dados sintéticos.

```sh
node --env-file=.env.local test/e2e.js
```

O roteiro abre sessões de navegador independentes e cobre modo local, cadastro e login, privacidade e moderação de apelidos, carteira, recuperação de convite de aposta, reconexão, partida completa, nova tentativa de pagamento e estornos por saída, expiração e reinício.

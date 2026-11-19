"use strict";

function createSettlement(pool) {
  async function recordResolution(id, winnerUid) {
    await pool.query(
      `UPDATE public.bets
       SET resolution = $2, winner_uid = $3
       WHERE id = $1 AND status IN ('pending', 'reserved') AND resolution IS NULL`,
      [id, winnerUid ? "payout" : "refund", winnerUid]
    );
  }

  async function settle(id) {
    const client = await pool.connect();

    try {
      await client.query("BEGIN");
      const { rows: [bet] } = await client.query(
        "SELECT * FROM public.bets WHERE id = $1 FOR UPDATE", [id]
      );
      if (!bet || !["pending", "reserved"].includes(bet.status)) {
        await client.query("COMMIT");
        return bet ? { status: bet.status, uids: [] } : null;
      }

      const uids = [bet.creator_uid, bet.opponent_uid].sort();
      const winner = bet.resolution === "payout" ? bet.winner_uid : null;
      if (winner && !uids.includes(winner)) {
        throw new Error("O vencedor não pertence à aposta.");
      }

      let payout = null;
      if (bet.status === "reserved") {
        const wallets = await client.query(
          `SELECT firebase_uid FROM public.wallet_accounts
           WHERE firebase_uid = ANY($1::text[]) ORDER BY firebase_uid FOR UPDATE`, [uids]
        );
        if (wallets.rowCount !== 2) throw new Error("Carteiras da aposta não encontradas.");

        if (winner) {
          const stakeCents = Math.round(Number(bet.amount) * 100);
          const commission = Math.round(stakeCents / 10);
          payout = ((stakeCents * 2 - commission) / 100).toFixed(2);
          await credit(client, bet.id, winner, "winner_payout", "bet_payout", payout);
          const loser = uids.find(uid => uid !== winner);
          await recordBetTransaction(client, bet.id, loser, "commission",
            (commission / 100).toFixed(2), `bet:${bet.id}:commission`);
        } else {
          for (const uid of uids) {
            await credit(client, bet.id, uid, "stake_refunded", "stake_refunded", bet.amount);
          }
        }
      }

      const status = payout ? "finished" : "cancelled";
      await client.query(
        `UPDATE public.bets
         SET status = $2, winner_uid = $3, settled_at = NOW()
         WHERE id = $1`, [id, status, payout ? winner : null]
      );
      await client.query("COMMIT");
      return { status, payout, uids };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async function credit(client, id, uid, type, walletType, amount) {
    await client.query(
      `UPDATE public.wallet_accounts
       SET balance = balance + $1, updated_at = NOW() WHERE firebase_uid = $2`, [amount, uid]
    );
    await recordBetTransaction(client, id, uid, type, amount, `bet:${id}:${type}:${uid}`);
    await client.query(
      `INSERT INTO public.wallet_transactions (firebase_uid, type, amount, description)
       VALUES ($1, $2, $3, $4)`, [uid, walletType, amount, `Aposta ${id}`]
    );
  }

  async function recordBetTransaction(client, id, uid, type, amount, key) {
    await client.query(
      `INSERT INTO public.bet_transactions (bet_id, firebase_uid, type, amount, idempotency_key)
       VALUES ($1, $2, $3, $4, $5)`, [id, uid, type, amount, key]
    );
  }

  return { recordResolution, settle };
}

module.exports = { createSettlement };

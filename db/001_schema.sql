BEGIN;

CREATE TABLE IF NOT EXISTS public.wallet_accounts (
  firebase_uid text PRIMARY KEY,
  balance numeric(18,2) NOT NULL CHECK (balance >= 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.wallet_transactions (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  firebase_uid text NOT NULL REFERENCES public.wallet_accounts(firebase_uid),
  type text NOT NULL,
  amount numeric(18,2) NOT NULL,
  description text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.bets (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  room_code text NOT NULL,
  creator_uid text NOT NULL REFERENCES public.wallet_accounts(firebase_uid),
  opponent_uid text NOT NULL REFERENCES public.wallet_accounts(firebase_uid),
  winner_uid text REFERENCES public.wallet_accounts(firebase_uid),
  amount numeric(18,2) NOT NULL CHECK (amount BETWEEN 0.01 AND 5),
  status text NOT NULL CHECK (status IN ('pending', 'reserved', 'cancelled', 'finished')),
  created_at timestamptz NOT NULL DEFAULT now(),
  accepted_at timestamptz,
  settled_at timestamptz,
  CHECK (creator_uid <> opponent_uid)
);

ALTER TABLE public.bets
  ADD COLUMN IF NOT EXISTS resolution text CHECK (resolution IN ('payout', 'refund'));

CREATE UNIQUE INDEX IF NOT EXISTS damas_bets_active_room
  ON public.bets (room_code) WHERE status IN ('pending', 'reserved');

CREATE TABLE IF NOT EXISTS public.bet_transactions (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  bet_id bigint NOT NULL REFERENCES public.bets(id),
  firebase_uid text NOT NULL REFERENCES public.wallet_accounts(firebase_uid),
  type text NOT NULL,
  amount numeric(18,2) NOT NULL,
  idempotency_key text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- The browser never queries these tables directly.
ALTER TABLE public.wallet_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.wallet_transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.bets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.bet_transactions ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS public.player_profiles (
  firebase_uid text PRIMARY KEY,
  nickname text CHECK (char_length(nickname) BETWEEN 3 AND 24),
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.player_profiles ENABLE ROW LEVEL SECURITY;

COMMIT;

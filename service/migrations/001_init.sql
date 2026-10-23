CREATE TABLE accounts (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name          text NOT NULL,
  api_key_hash  text NOT NULL UNIQUE,
  plan_id       uuid NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE plans (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id        uuid REFERENCES accounts(id),          
  scope             text NOT NULL CHECK (scope IN ('account', 'user')),
  name              text NOT NULL,
  monthly_allowance bigint CHECK (monthly_allowance >= 0), 
  max_per_request   bigint CHECK (max_per_request > 0),  
  is_predefined     boolean NOT NULL DEFAULT false,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CHECK (is_predefined = (account_id IS NULL))
);

CREATE UNIQUE INDEX plans_unique_name ON plans (
  COALESCE(account_id, '00000000-0000-0000-0000-000000000000'::uuid), scope, name
);

ALTER TABLE accounts
  ADD CONSTRAINT accounts_plan_fk FOREIGN KEY (plan_id) REFERENCES plans(id);

CREATE TABLE users (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id  uuid NOT NULL REFERENCES accounts(id),
  external_id text NOT NULL,                              
  plan_id     uuid NOT NULL REFERENCES plans(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, external_id)
);

CREATE TABLE account_usage (
  account_id uuid NOT NULL REFERENCES accounts(id),
  period     date NOT NULL,                              
  consumed   bigint NOT NULL DEFAULT 0 CHECK (consumed >= 0),
  PRIMARY KEY (account_id, period)
);

CREATE TABLE user_usage (
  user_id  uuid NOT NULL REFERENCES users(id),
  period   date NOT NULL,
  consumed bigint NOT NULL DEFAULT 0 CHECK (consumed >= 0),
  PRIMARY KEY (user_id, period)
);

CREATE TABLE requests (
  id              bigserial PRIMARY KEY,
  account_id      uuid NOT NULL REFERENCES accounts(id),
  user_id         uuid NOT NULL REFERENCES users(id),
  request_id      text NOT NULL,
  units           bigint NOT NULL CHECK (units > 0),
  period          date NOT NULL,
  status          text NOT NULL CHECK (status IN ('accepted', 'rejected')),
  rejected_level  text CHECK (rejected_level IN ('account', 'user')),
  rejected_rule   text,
  account_plan_id uuid REFERENCES plans(id),
  user_plan_id    uuid REFERENCES plans(id),
  snapshot        jsonb NOT NULL,                       
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, request_id)
);

CREATE INDEX requests_account_time_idx ON requests (account_id, created_at DESC, id DESC);
CREATE INDEX requests_user_time_idx    ON requests (user_id, created_at DESC, id DESC);
CREATE INDEX users_account_idx         ON users (account_id);

CREATE TABLE IF NOT EXISTS accounts (
    id UUID PRIMARY KEY,
    issuer TEXT NOT NULL,
    subject TEXT NOT NULL,
    display_name TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('TRADER', 'OPERATOR')),
    party_id TEXT UNIQUE,
    UNIQUE (issuer, subject)
);

CREATE TABLE IF NOT EXISTS fixture_parties (
    name TEXT PRIMARY KEY,
    party_id TEXT NOT NULL UNIQUE,
    ledger_user_id TEXT NOT NULL UNIQUE,
    ledger_client_id TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS pools (
    pool_id TEXT PRIMARY KEY,
    config_id TEXT NOT NULL UNIQUE,
    state_id TEXT NOT NULL UNIQUE,
    package_id TEXT NOT NULL,
    name TEXT NOT NULL,
    active BOOLEAN NOT NULL DEFAULT false,
    settings JSONB,
    created_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS onboardings (
    id UUID PRIMARY KEY,
    account_id UUID NOT NULL UNIQUE REFERENCES accounts(id),
    application JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    review_decision TEXT CHECK (review_decision IN ('APPROVED', 'REJECTED')),
    reviewed_by UUID REFERENCES accounts(id),
    reviewed_at TIMESTAMPTZ,
    approved_pools JSONB NOT NULL DEFAULT '[]',
    preparation_id UUID UNIQUE,
    prepared_party_id TEXT,
    party_confirmed_at TIMESTAMPTZ,
    party_mode TEXT NOT NULL DEFAULT 'participant-test' CHECK (party_mode IN ('participant-test', 'external')),
    party_hint TEXT,
    public_key TEXT,
    public_key_fingerprint TEXT,
    multi_hash TEXT,
    synchronizer_id TEXT,
    topology_transactions JSONB,
    party_status TEXT CHECK (party_status IN ('PREPARED', 'SUBMITTING', 'CONFIRMED', 'UNRESOLVED')),
    prepared_participant_id TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS external_prepared_party ON onboardings(prepared_party_id)
    WHERE party_mode = 'external';

CREATE TABLE IF NOT EXISTS onboarding_steps (
    onboarding_id UUID NOT NULL REFERENCES onboardings(id),
    step_key TEXT NOT NULL,
    command_id UUID NOT NULL UNIQUE,
    status TEXT NOT NULL CHECK (status IN ('PENDING', 'SUBMITTING', 'CONFIRMED', 'UNRESOLVED')),
    contract_id TEXT UNIQUE,
    begin_offset BIGINT,
    update_id TEXT,
    issuer TEXT,
    PRIMARY KEY (onboarding_id, step_key),
    CHECK ((status = 'CONFIRMED') = (contract_id IS NOT NULL))
);

CREATE TABLE IF NOT EXISTS venue_configuration (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    synchronizer_id TEXT NOT NULL,
    participant_id TEXT
);

CREATE TABLE IF NOT EXISTS pool_proposals (
    id UUID PRIMARY KEY,
    name TEXT NOT NULL,
    settings JSONB NOT NULL,
    factory_id TEXT NOT NULL,
    proposed_by UUID NOT NULL REFERENCES accounts(id),
    status TEXT NOT NULL CHECK (status IN ('SUBMITTING', 'PENDING', 'CREATED', 'REJECTED', 'WITHDRAWN', 'UNRESOLVED', 'FAILED')),
    command_id UUID NOT NULL UNIQUE,
    begin_offset BIGINT NOT NULL,
    proposal_cid TEXT UNIQUE,
    pool_id TEXT REFERENCES pools(pool_id),
    update_id TEXT,
    error TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS pool_pair_claims (
    pair_key TEXT PRIMARY KEY,
    proposal_id UUID UNIQUE REFERENCES pool_proposals(id),
    pool_id TEXT REFERENCES pools(pool_id),
    CHECK (proposal_id IS NOT NULL OR pool_id IS NOT NULL)
);

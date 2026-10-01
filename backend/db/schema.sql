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
    party_status TEXT CHECK (party_status IN ('PREPARED', 'SUBMITTING', 'CONFIRMED', 'UNRESOLVED', 'CONFLICT')),
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

CREATE TABLE IF NOT EXISTS pool_queues (
    pool_id TEXT PRIMARY KEY REFERENCES pools(pool_id),
    active_settlement_id UUID,
    last_processed_family TEXT CHECK (last_processed_family IN ('swap','deposit','withdraw')),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS pool_request_queues (
    pool_id TEXT NOT NULL REFERENCES pools(pool_id),
    family TEXT NOT NULL CHECK (family IN ('swap','deposit','withdraw')),
    automatic_enabled BOOLEAN NOT NULL DEFAULT false,
    batch_size INTEGER NOT NULL DEFAULT 5 CHECK (batch_size>0),
    policy_version BIGINT NOT NULL DEFAULT 0,
    next_sequence BIGINT NOT NULL DEFAULT 0,
    blocked_version TEXT,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (pool_id,family)
);

CREATE TABLE IF NOT EXISTS swap_quotes (
    id UUID PRIMARY KEY,
    account_id UUID NOT NULL REFERENCES accounts(id),
    payload JSONB NOT NULL
);

CREATE TABLE IF NOT EXISTS swap_requests (
    id UUID PRIMARY KEY,
    account_id UUID NOT NULL REFERENCES accounts(id),
    quote_id UUID NOT NULL UNIQUE REFERENCES swap_quotes(id),
    terms JSONB NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('PREPARED','SUBMITTING','UNRESOLVED','READY','BLOCKED','SETTLING','SETTLED','EXPIRED','WITHDRAWING','WITHDRAWAL_UNRESOLVED','WITHDRAWN','FAILED')),
    arrival_sequence BIGINT,
    settlement_id UUID,
    amount_out TEXT,
    allocation_cids JSONB NOT NULL DEFAULT '[]',
    update_id TEXT,
    error_code TEXT,
    error TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    submitted_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS swap_queue_sequence ON swap_requests ((terms->>'poolId'),arrival_sequence) WHERE arrival_sequence IS NOT NULL;
CREATE INDEX IF NOT EXISTS swap_owner_activity ON swap_requests(account_id,created_at DESC,id DESC);
CREATE INDEX IF NOT EXISTS swap_settlement_market ON swap_requests(settlement_id) WHERE settlement_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS swap_preparations (
    id UUID PRIMARY KEY,
    swap_id UUID NOT NULL REFERENCES swap_requests(id),
    command_id UUID NOT NULL UNIQUE,
    action TEXT NOT NULL CHECK (action IN ('SUBMIT','WITHDRAW')),
    signing JSONB NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('PREPARED','SUBMITTING','UNRESOLVED','CONFIRMED','FAILED')),
    signature TEXT,
    begin_offset BIGINT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS swap_initial_preparation ON swap_preparations(swap_id) WHERE action='SUBMIT';

CREATE TABLE IF NOT EXISTS settlement_batches (
    id UUID PRIMARY KEY,
    pool_id TEXT NOT NULL REFERENCES pools(pool_id),
    trigger TEXT NOT NULL CHECK (trigger IN ('MANUAL','AUTOMATIC')),
    status TEXT NOT NULL CHECK (status IN ('PREPARING','SUBMITTING','UNRESOLVED','CONFIRMED','REJECTED','CANCELLED')),
    requests JSONB NOT NULL,
    fills JSONB NOT NULL DEFAULT '[]',
    reserves_before JSONB,
    reserves_after JSONB,
    policy_version BIGINT NOT NULL,
    command_id UUID NOT NULL UNIQUE,
    retry_of UUID REFERENCES settlement_batches(id),
    selection JSONB,
    begin_offset BIGINT NOT NULL,
    state_version TEXT NOT NULL,
    update_id TEXT,
    error_code TEXT,
    error TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS one_active_pool_settlement ON settlement_batches(pool_id) WHERE status IN ('PREPARING','SUBMITTING','UNRESOLVED');
CREATE INDEX IF NOT EXISTS confirmed_pool_market ON settlement_batches(pool_id,updated_at,id) WHERE status='CONFIRMED';

CREATE TABLE IF NOT EXISTS operator_commands (
    id UUID PRIMARY KEY,
    kind TEXT NOT NULL,
    payload TEXT,
    error TEXT,
    CHECK ((payload IS NOT NULL AND error IS NULL) OR (payload IS NULL AND error IS NOT NULL))
);

CREATE TABLE IF NOT EXISTS test_token_configuration (
    id INTEGER PRIMARY KEY CHECK(id=1),
    issuer_party_id TEXT NOT NULL,
    rules_id TEXT NOT NULL,
    rules_created_event_blob TEXT NOT NULL,
    package_id TEXT NOT NULL,
    faucet_factory_id TEXT NOT NULL,
    synchronizer_id TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS test_token_instruments (
    symbol TEXT PRIMARY KEY,
    instrument_id TEXT UNIQUE NOT NULL,
    decimals INTEGER NOT NULL CHECK(decimals BETWEEN 0 AND 10),
    initial_claim_amount NUMERIC NOT NULL CHECK(initial_claim_amount>0)
);

CREATE TABLE IF NOT EXISTS test_token_pools (
    pair TEXT PRIMARY KEY,
    pool_id TEXT UNIQUE NOT NULL REFERENCES pools(pool_id),
    delegation_id TEXT
);

CREATE TABLE IF NOT EXISTS dev_faucet_claims (
    account_id UUID PRIMARY KEY REFERENCES accounts(id),
    party_id TEXT UNIQUE NOT NULL,
    grant_id UUID UNIQUE NOT NULL,
    grant_command_id UUID UNIQUE NOT NULL,
    grant_cid TEXT,
    grant_begin_offset BIGINT,
    grant_status TEXT NOT NULL DEFAULT 'PENDING' CHECK(grant_status IN ('PENDING','SUBMITTING','UNRESOLVED','CONFIRMED')),
    preparation_id UUID UNIQUE,
    prepared_transaction TEXT,
    prepared_hash TEXT,
    hashing_scheme_version INTEGER,
    expires_at TIMESTAMPTZ,
    claim_begin_offset BIGINT,
    status TEXT NOT NULL DEFAULT 'AVAILABLE' CHECK(status IN ('AVAILABLE','PREPARED','SUBMITTING','UNRESOLVED','COMPLETED')),
    update_id TEXT,
    error_code TEXT,
    error TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS token_registries (
    admin TEXT PRIMARY KEY,
    allocation_factory_id TEXT NOT NULL,
    settlement_factory_id TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS token_registry_contracts (
    admin TEXT NOT NULL REFERENCES token_registries(admin),
    contract_id TEXT NOT NULL,
    template_id TEXT NOT NULL,
    created_event_blob TEXT NOT NULL,
    synchronizer_id TEXT NOT NULL,
    PRIMARY KEY (admin,contract_id)
);

CREATE TABLE IF NOT EXISTS token_instruments (
    admin TEXT NOT NULL REFERENCES token_registries(admin),
    instrument_id TEXT NOT NULL,
    symbol TEXT NOT NULL,
    decimals INTEGER NOT NULL CHECK (decimals BETWEEN 0 AND 10),
    PRIMARY KEY (admin,instrument_id)
);

CREATE TABLE IF NOT EXISTS liquidity_quotes (
    id UUID PRIMARY KEY,
    account_id UUID NOT NULL REFERENCES accounts(id),
    kind TEXT NOT NULL CHECK (kind IN ('DEPOSIT','WITHDRAW')),
    payload JSONB NOT NULL
);

CREATE TABLE IF NOT EXISTS liquidity_requests (
    id UUID PRIMARY KEY,
    account_id UUID NOT NULL REFERENCES accounts(id),
    quote_id UUID NOT NULL UNIQUE REFERENCES liquidity_quotes(id),
    kind TEXT NOT NULL CHECK (kind IN ('DEPOSIT','WITHDRAW')),
    terms JSONB NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('PREPARED','SUBMITTING','UNRESOLVED','READY','BLOCKED','SETTLING','SETTLED','EXPIRED','RECOVERING','RECOVERY_UNRESOLVED','RECOVERED','FAILED')),
    arrival_sequence BIGINT,
    settlement_id UUID,
    result JSONB,
    allocation_cids JSONB NOT NULL DEFAULT '[]',
    update_id TEXT,
    error_code TEXT,
    error TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    submitted_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS liquidity_activity ON liquidity_requests(account_id,created_at DESC,id DESC);

CREATE TABLE IF NOT EXISTS liquidity_preparations (
    id UUID PRIMARY KEY,
    request_id UUID NOT NULL REFERENCES liquidity_requests(id),
    command_id UUID NOT NULL UNIQUE,
    action TEXT NOT NULL CHECK (action IN ('SUBMIT','RECOVER')),
    signing JSONB NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('PREPARED','SUBMITTING','UNRESOLVED','CONFIRMED','FAILED')),
    signature TEXT,
    begin_offset BIGINT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS liquidity_initial_preparation ON liquidity_preparations(request_id) WHERE action='SUBMIT';

CREATE UNIQUE INDEX IF NOT EXISTS liquidity_queue_sequence ON liquidity_requests ((terms->>'poolId'),kind,arrival_sequence) WHERE arrival_sequence IS NOT NULL;

CREATE TABLE IF NOT EXISTS settlement_deferred_requests (
    pool_id TEXT NOT NULL REFERENCES pools(pool_id),
    family TEXT NOT NULL CHECK (family IN ('swap','deposit','withdraw')),
    request_id UUID NOT NULL,
    deferred_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (pool_id,family,request_id)
);

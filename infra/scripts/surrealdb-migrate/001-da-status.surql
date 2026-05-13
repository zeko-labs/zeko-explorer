DEFINE TABLE batch SCHEMAFULL;
DEFINE FIELD network ON batch TYPE string;
DEFINE FIELD target_ledger_hash ON batch TYPE string;
DEFINE FIELD da_status ON batch TYPE option<string> ASSERT $value IN ['attested'];
DEFINE FIELD da_attested_at ON batch TYPE option<datetime>;
DEFINE FIELD da_source ON batch TYPE option<string> ASSERT $value IN ['settlement', 'proved', 'da-direct'];
DEFINE INDEX idx_batch_target_ledger_hash ON batch FIELDS target_ledger_hash UNIQUE;
DEFINE INDEX idx_batch_da_status ON batch FIELDS da_status;

DEFINE TABLE pending_da_attestation SCHEMAFULL;
DEFINE FIELD ledger_hash ON pending_da_attestation TYPE string;
DEFINE FIELD source ON pending_da_attestation TYPE string ASSERT $value IN ['settlement', 'proved', 'da-direct'];
DEFINE FIELD attested_at ON pending_da_attestation TYPE option<datetime>;
DEFINE FIELD received_at ON pending_da_attestation TYPE datetime;
DEFINE INDEX idx_pending_da_hash ON pending_da_attestation FIELDS ledger_hash UNIQUE;

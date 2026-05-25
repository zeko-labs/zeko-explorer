Feature: Schema inventory and indexes

  Background:
    Given the consolidated schema is applied

  Scenario: The consolidated schema defines every storage table
    Then the database should contain tables:
      | account                 |
      | account_activity        |
      | account_transaction     |
      | batch                   |
      | batch_transaction       |
      | bridge_operation        |
      | bridge_transaction_link |
      | da_attestation          |
      | inner_action            |
      | l1_action_link          |
      | l1_watcher_block        |
      | l1_watcher_cursor       |
      | l1_watcher_published    |
      | l2_action_link          |
      | outer_action            |
      | pending_da_attestation  |
      | sync_status             |
      | transaction             |
      | zkapp_action            |
      | zkapp_event             |

  Scenario: Transaction query paths have matching indexes
    Then table "transaction" should define indexes:
      | idx_tx_hash            |
      | idx_tx_connection_order            |
      | idx_tx_timestamp       |
      | idx_tx_ledger          |
      | idx_tx_count           |

  Scenario: Native aggregate count paths have matching indexes
    Then table "account" should define indexes:
      | idx_account_count |
    And table "bridge_operation" should define indexes:
      | idx_bo_count      |

  Scenario: Account transaction graph query paths have matching indexes
    Then table "account_transaction" should define indexes:
      | idx_account_tx_public_key_all_order |
      | idx_account_tx_public_key_role_order     |
      | idx_account_tx_unique              |

  Scenario: Bridge query paths have matching indexes
    Then table "bridge_operation" should define indexes:
      | idx_bo_aux_unique          |
      | idx_bo_recipient_order      |
      | idx_bo_sender_type_order    |
      | idx_bo_recipient_type_order |
      | idx_bo_type_status_order    |
      | idx_bo_l1_witness          |
      | idx_bo_l2_action           |
      | idx_bo_sender_order         |
      | idx_bo_data_quality        |
      | idx_bo_quality_primary_reason |

  Scenario: Native full-text search paths have matching indexes
    Then table "transaction" should define indexes:
      | idx_tx_search_text |
    And table "account" should define indexes:
      | idx_account_search_text |
    And table "bridge_operation" should define indexes:
      | idx_bo_search_text |

  Scenario: Transaction detail fanout query paths have matching indexes
    Then table "zkapp_event" should define indexes:
      | idx_event_hash_order |
    And table "zkapp_action" should define indexes:
      | idx_action_hash_order |
    And table "inner_action" should define indexes:
      | idx_ia_txn_hash_order |

  Scenario: Spike 006 watcher durability tables have idempotency indexes
    Then table "l1_watcher_cursor" should define indexes:
      | idx_l1_cursor_unique |
    And table "l1_watcher_published" should define indexes:
      | idx_l1_published_msg |

  Scenario: PRD DA attestation storage has matching fields and indexes
    Then table "batch" should define fields:
      | target_ledger_hash    |
      | da_status             |
      | da_source             |
      | da_attested_at        |
      | da_implementation     |
      | da_quorum_threshold   |
      | da_signers            |
    And table "batch" should define indexes:
      | idx_batch_target_ledger_hash |
      | idx_batch_da                 |
    And table "pending_da_attestation" should define fields:
      | ledger_hash      |
      | source           |
      | attested_at      |
      | received_at      |
      | implementation   |
      | quorum_threshold |
      | signers          |
    And table "pending_da_attestation" should define indexes:
      | idx_pending_da_hash        |
      | idx_pending_da_received_at |

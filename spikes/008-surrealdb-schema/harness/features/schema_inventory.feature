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
      | bridge_quality_issue    |
      | bridge_operation        |
      | bridge_transaction_link |
      | da_attestation          |
      | inner_action            |
      | l1_action_link          |
      | l1_watcher_block        |
      | l1_watcher_cursor       |
      | l1_watcher_published    |
      | l2_action_link          |
      | network_stats           |
      | outer_action            |
      | schema_migration        |
      | sync_status             |
      | transaction             |
      | zkapp_action            |
      | zkapp_event             |

  Scenario: Transaction query paths have matching indexes
    Then table "transaction" should define indexes:
      | idx_tx_hash            |
      | idx_tx_sequence        |
      | idx_tx_block_order     |
      | idx_tx_feed            |
      | idx_tx_sender_feed     |
      | idx_tx_receiver_feed   |
      | idx_tx_fee_payer_feed  |
      | idx_tx_target_ledger   |

  Scenario: Bridge query paths have matching indexes
    Then table "bridge_operation" should define indexes:
      | idx_bo_aux_unique          |
      | idx_bo_sender_feed         |
      | idx_bo_recipient_feed      |
      | idx_bo_sender_type_feed    |
      | idx_bo_recipient_type_feed |
      | idx_bo_type_status_feed    |
      | idx_bo_l1_witness          |
      | idx_bo_l2_action           |

  Scenario: Bridge evidence issue query paths have matching indexes
    Then table "bridge_quality_issue" should define indexes:
      | idx_bqi_unique      |
      | idx_bqi_open_feed   |
      | idx_bqi_reason_feed |
      | idx_bqi_bridge      |

  Scenario: Spike 006 watcher durability tables have idempotency indexes
    Then table "l1_watcher_cursor" should define indexes:
      | idx_l1_cursor_unique |
    And table "l1_watcher_published" should define indexes:
      | idx_l1_published_msg |

Feature: GraphQL contractSchema query and decoder placement

  The explorer exposes contract schemas through a single GraphQL query,
  `contractSchema(network, address)`, which resolves from Cloudflare KV with a
  5-minute edge cache. On-chain data (account, events, actions) continues to
  return raw field strings only. Decoding — running the shared interpreter in
  @zeko/contract-schema — happens in the UI by default, and in the API resolver
  for specific hot feeds where per-request decoding latency beats the
  round-trip of a second query. The indexer never reads schemas.

  Background:
    Given a Cloudflare KV namespace is configured on explorer-api
    And the registry has published the LuminaPool submission
    And the corresponding KV key is "zeko-m-devnet:B62qrSyBR5jLgekkwjDdpt6UX8FfYntYB1uXydFyViWMFLkrGSceFEV"

  # Query — contractSchema resolver

  Scenario: Known contract returns its submission edge-cached
    When a client executes contractSchema(network: "zeko-m-devnet", address: "B62qrSyBR5jLgekkwjDdpt6UX8FfYntYB1uXydFyViWMFLkrGSceFEV")
    Then the resolver returns a ContractSchema object
    And the "submission" field equals the LuminaPool contract.json bytes
    And the "grade" field is "community-submitted"
    And the "version" field is 1
    And the HTTP response carries "Cache-Control: public, max-age=300, stale-while-revalidate=86400"

  Scenario: Unknown contract returns null with a short cache
    When a client executes contractSchema for an address not in the registry
    Then the resolver returns null
    And the HTTP response carries "Cache-Control: public, max-age=60"

  Scenario: Newly published submission becomes readable after KV propagation
    Given a registry PR for a new contract merges to main
    And a maintainer triggers workflow_dispatch to publish it
    When a client executes contractSchema for the new contract
    Then the resolver returns a ContractSchema once KV propagation completes

  Scenario: Deleted submission returns null after KV delete
    Given a maintainer triggers workflow_dispatch with mode "delete"
    When a client executes contractSchema for the removed contract
    Then the resolver returns null

  Scenario: Multi-network contract resolves independently per network
    Given the submission's meta.networks is ["zeko-m-devnet", "zeko-mainnet"]
    When a client executes contractSchema(network: "zeko-m-devnet", address: ADDR)
    And a client executes contractSchema(network: "zeko-mainnet", address: ADDR)
    Then both resolvers return ContractSchema objects whose "submission" fields are byte-equal

  # GraphQL — on-chain data stays raw

  Scenario: Account query returns raw zkappState and raw event fields
    When the UI queries account(address: ADDR) selecting zkappState and events.nodes.fields
    Then zkappState is an array of 8 raw field element strings
    And each event exposes a "fields" array of raw field element strings
    And neither "labeledState" nor "labeledFields" appears on Account or ZkappEvent

  # UI-side decoding (default path for contract pages)

  Scenario: UI decodes state when a schema is available
    Given the UI resolved the LuminaPool schema from contractSchema
    And the GraphQL account query returned zkappState as ["1000000000", "4056640838", "9023684", "0", "0", "0", "0", "0"]
    When the UI calls decodeState(schema.submission, zkappState)
    Then the result has reserve0 = "1000000000"
    And the result has reserve1 = "4056640838"
    And the result has totalLiquidity = "9023684"
    And both raw and labeled views are rendered side-by-side

  Scenario: UI dispatches an AddLiquidity event through the discriminator
    Given the UI resolved the LuminaPool schema from contractSchema
    And an event's fields begin with discriminator "0"
    When the UI calls decodeEventOrAction on that event
    Then the result's "kind" is "AddLiquidity"
    And the result names the sender, a0In, a1In, and lpOut keys

  Scenario: UI dispatches a ReceiveMina event through the discriminator
    Given the UI resolved the LuminaPool schema from contractSchema
    And an event's fields begin with discriminator "3"
    When the UI calls decodeEventOrAction on that event
    Then the result's "kind" is "ReceiveMina"
    And the result names the sender and amountIn keys

  Scenario: UI dispatches a Swap event through the discriminator
    Given the UI resolved the LuminaPool schema from contractSchema
    And an event's fields begin with discriminator "4"
    When the UI calls decodeEventOrAction on that event
    Then the result's "kind" is "Swap"
    And the result names the sender, amountIn, and amountOut keys

  Scenario: PublicKey-typed slot consumes two raw fields and decodes to Base58
    Given a variant declares a slot at index 1 named "sender" of type "PublicKey"
    And the raw fields at indices 1 and 2 form a valid PublicKey field pair
    When the UI calls decodeEventOrAction
    Then the result's "sender" is a Base58 address starting with "B62q"

  Scenario: Single-shape contract applies its schema to every event
    Given the schema's events block is a single-shape { fields: [{ at: 0, name: "x", type: "Field" }] }
    And an event has fields = ["7"]
    When the UI calls decodeEventOrAction
    Then the result is { x: "7" }

  Scenario: Custom Struct type expands into nested labels
    Given the schema declares types.UserXY with fields x:Field and isOdd:Bool
    And a variant declares a slot at index 1 named "user" of type "UserXY"
    And the raw fields are ["0", "12345", "1"]
    When the UI calls decodeEventOrAction
    Then the result's "user" is { x: "12345", isOdd: true }

  # API-side decoding (hot feeds)

  Scenario: Multi-contract recent-events feed decodes server-side
    Given the "recent events" page queries events across 50 distinct contracts
    When the resolver assembles the page
    Then it fetches each contract's schema once via the KV edge cache
    And it calls decodeEventOrAction in the resolver for each event
    And the GraphQL response carries a "labeled" field per event

  Scenario: API-side decoder returns null on unknown discriminator
    Given the API resolver runs decodeEventOrAction on an event with an unrecognized discriminator
    Then the "labeled" field is null
    And the "fields" field still contains the raw array

  # UI fallback behavior

  Scenario: Unknown discriminator falls back to raw fields
    Given the LuminaPool schema is loaded in the UI
    And an event's discriminator value has no matching variant
    When the UI calls decodeEventOrAction
    Then the result is null
    And the UI renders the raw field array unchanged

  Scenario: Decoder error on a malformed event does not crash the page
    Given a variant reads slot 5 but the event has only 3 fields
    When the UI calls decodeEventOrAction
    Then the result is null
    And the page logs the error with contract address and event index
    And the raw field array is rendered unchanged

  Scenario: contractSchema null result shows the "Submit this contract" CTA
    Given contractSchema returns null for the requested contract
    When the contract page renders
    Then raw fields are shown for state, events, and actions
    And a "Submit this contract" CTA links to the registry's PR template

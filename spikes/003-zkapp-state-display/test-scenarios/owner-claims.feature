Feature: Contract Owner Claims and Display Metadata

  After a contract is verified, anyone who controls the contract account's
  private key can claim ownership by signing a deterministic payload with
  the account private key. Claims gate the ability to edit display
  metadata (homepage, repository link, description, logo). The claim is
  per-address — one verification key deployed to multiple accounts may
  have multiple independent owner claims (addendum §6).

  Background:
    Given contract "vkey-hash-hello" is verified in KV
    And account "B62qHello" on network "zeko-m-devnet" is a deployment of "vkey-hash-hello"
    And the owner controls the private key for "B62qHello"

  # Claim happy path

  Scenario: Owner claims a verified contract with a valid signature
    Given the UI displays a claim payload:
      | prefix     | zeko-explorer:contract-claim:v1            |
      | vkey_hash  | vkey-hash-hello                            |
      | address    | B62qHello                                  |
      | network    | zeko-m-devnet                              |
      | issued_at  | 2026-04-17T12:00:00Z                       |
      | nonce      | <random 32-byte field>                     |
    When the owner signs the payload with the "B62qHello" private key
    And the UI posts submitOwnerClaim(payload, signature) to the API
    Then the signature verifies against the public key derived from "B62qHello"
    And KV key "contract:claim:vkey-hash-hello:B62qHello" is written with the signed payload
    And the API returns a short-lived session token for metadata edits
    And the contract page subsequently shows the verified + owned badge

  Scenario: Signature over a tampered payload is rejected
    Given a valid signed claim payload was signed over the original canonical form
    When the client posts a payload with "address" field altered to "B62qEvil"
    Then the API rejects the claim with "signature does not match payload"
    And no KV writes occur

  Scenario: Claim signed with a key that doesn't match the address is rejected
    Given a claim payload references "address: B62qHello"
    When the payload is signed with the private key of "B62qOther"
    Then the API rejects the claim with "signature does not match address public key"
    And no KV writes occur

  # Freshness and replay protection

  Scenario: Stale claim payload (older than 10 minutes) is rejected
    Given a claim payload's issued_at is 11 minutes ago
    When the client submits the signed claim
    Then the API rejects it with "claim payload is stale"

  Scenario: Nonce reuse is rejected
    Given a claim with nonce "N1" was accepted 5 minutes ago
    When the same nonce "N1" is reused in a new claim
    Then the API rejects it with "nonce already used"
    And the nonce replay protection set holds "N1" for 30 minutes total

  # Metadata editing gated by ownership

  Scenario: Owner updates display metadata with a valid session token
    Given the owner holds a valid session token from a recent claim
    When the owner calls updateOwnerMetadata(vkeyHash: "vkey-hash-hello", sessionToken: <token>, patch: { homepage: "https://hello.dev", repository: "https://github.com/acme/hello-world" })
    Then KV key "contract:owner:vkey-hash-hello" is updated with the new homepage and repository
    And the labels, stateFields, events, and actions in "contract:vkey:vkey-hash-hello" are NOT modified

  Scenario: Metadata edits without a valid session token are rejected
    Given a client has no valid session token
    When the client calls updateOwnerMetadata on "vkey-hash-hello"
    Then the API returns an authorization error
    And KV is not modified

  Scenario: Session token expires and requires re-signing
    Given the owner's session token is older than its TTL
    When the owner attempts to call updateOwnerMetadata
    Then the API rejects the request with "session expired; re-claim required"
    And the owner must repeat the sign-and-submit claim flow

  # Ownership scope — per address, not per vkey

  Scenario: One vkey deployed to two accounts has two independent claims
    Given "vkey-hash-multi" is deployed to both "B62qDeployA" and "B62qDeployB"
    And "B62qDeployA" has been claimed by its owner
    And "B62qDeployB" has NOT been claimed
    When querying contract(vkeyHash: "vkey-hash-multi")
    Then the deployments list marks "B62qDeployA" as owner-claimed
    And "B62qDeployB" is shown as unclaimed

  Scenario: Display metadata falls back to manifest when no owner claim exists
    Given "contract:owner:vkey-hash-hello" is empty
    And the verified manifest declared name "HelloWorld (from manifest)" and homepage "https://acme.example"
    When the client queries contract(vkeyHash: "vkey-hash-hello")
    Then the returned OwnerInfo.displayName is "HelloWorld (from manifest)"
    And OwnerInfo.homepage is "https://acme.example"
    And a clear "claim this contract" CTA is still surfaced to the UI

  # Correctness boundaries — owners cannot change reflected data

  Scenario: Owner cannot edit stateFields labels
    Given the owner holds a valid session token
    When the owner posts a patch including stateFields: [{ index: 0, label: "MALICIOUS" }]
    Then the API rejects the patch with "stateFields are bound to the verification key and cannot be edited"
    And KV is not modified

  Scenario: Owner cannot edit events or actions schemas
    Given the owner holds a valid session token
    When the owner posts a patch including events.schemas or actions.schemas
    Then the API rejects the patch with "events/actions schemas are bound to the verification key and cannot be edited"
    And KV is not modified

  # Owner-supplied links

  Scenario: Owner adds a GitHub repository link (post-verification, via owner metadata)
    Given a contract was verified without a manifest repository field
    And the owner holds a valid session token
    When the owner calls updateOwnerMetadata with patch: { repository: "https://github.com/acme/new-repo" }
    Then the UI renders the repository link on the contract page
    And the verified-from-commit attribution still links to the original sourceRef

  Scenario: Owner adds a homepage / website link
    Given the owner holds a valid session token
    When the owner calls updateOwnerMetadata with patch: { homepage: "https://myzkapp.example" }
    Then the UI renders the homepage link with rel="noopener external"
    And the homepage URL must be HTTPS (HTTP submissions are rejected)

  Scenario: Owner uploads a logo
    Given the owner holds a valid session token
    When the owner uploads a PNG or SVG logo of <= 256 KB
    Then the logo is stored in Cloudflare R2
    And "contract:owner:vkey-hash-hello".logoUrl is set to the R2 URL
    And the UI renders the logo on the contract page header

  # Ownership transfer

  Scenario: Ownership transfers implicitly when the current owner loses key access
    Given "B62qHello" was claimed by owner A
    When owner A's private key is rotated (via an on-chain account update with a new auth token) and the signing key changes
    Then subsequent claim attempts with the new key succeed with a fresh signed payload
    And the prior owner claim at "contract:claim:vkey-hash-hello:B62qHello" is overwritten by the new payload

  Scenario: Delisting a claimed contract requires a signed delisting payload
    Given the owner holds the current claim
    When the owner signs a delisting payload (same structure as the claim, with intent "delist")
    Then KV removes "contract:owner:vkey-hash-hello" and "contract:claim:vkey-hash-hello:B62qHello"
    And the underlying "contract:vkey:vkey-hash-hello" verification entry is preserved
    And the contract page reverts to verified-but-unclaimed

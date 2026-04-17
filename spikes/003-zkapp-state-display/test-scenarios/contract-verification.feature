Feature: Contract Verification Submission Pipeline

  Anyone can submit an o1js contract for verification by providing a public
  git commit. A sandboxed worker clones the repo, installs dependencies,
  runs Class.compile(), reflects the @state / events / reducer.actionType
  layout, and — if an address was provided — matches the computed
  verification key against the one deployed on-chain. On success, the
  resulting metadata is written to Cloudflare KV at
  contract:vkey:<hash>. Labels are cryptographically bound to the
  compiled bytecode: modifying the class between compile and reflect
  would change the vkey and fail the MATCH stage (addendum §3, §4).

  Background:
    Given the Verification Service is online
    And Cloudflare KV namespace "zeko-explorer-contracts" is available
    And the API holds the Ed25519 public key used to verify worker results

  # Happy path — single-state, single-event HelloWorld

  Scenario: Successful verification of a simple HelloWorld contract
    Given repository "https://github.com/acme/hello-world" at commit "abc123d" has a HelloWorld contract with @state(Field) x and events { "x-updated": Field }
    And account "B62qHello" on network "zeko-m-devnet" is deployed with verification_key_hash "vkey-hash-hello"
    When a client calls submitContractForVerification with:
      | repository  | https://github.com/acme/hello-world |
      | commitSha   | abc123d...                          |
      | entryFile   | src/HelloWorld.ts                   |
      | className   | HelloWorld                          |
      | address     | B62qHello                           |
      | network     | zeko-m-devnet                       |
    Then a VerificationJob is created with status "PENDING"
    And the API returns the job id to the client
    And the pipeline advances through "CLONING", "INSTALLING", "COMPILING", "REFLECTING", "MATCHING", "VERIFIED"
    And the worker's computed vkeyHash equals "vkey-hash-hello"
    And KV key "contract:vkey:vkey-hash-hello" is written with:
      | stateFields[0].label | x           |
      | stateFields[0].type  | Field       |
      | events.discriminator | null        |
      | events.schemas[0].name | x-updated |
      | o1jsVersion          | 2.4.0       |
    And sourceRef.repository, commitSha, entryFile, className are recorded

  # SSE progress streaming

  Scenario: Client subscribes to verification progress and receives stage updates
    Given a verification job "job-42" is in progress
    When the client subscribes to verificationProgress(jobId: "job-42")
    Then the client receives an event for each stage transition in order
    And each event includes the current stage and any newly appended log lines
    And the final event carries status "VERIFIED" with the populated Contract result

  # Cryptographic binding — the key property

  Scenario: Modified class after compile is rejected at MATCHING stage
    Given the worker compiled class "TamperedContract" and computed vkeyHash "vkey-hash-T1"
    And the deployed account's on-chain vkeyHash is "vkey-hash-on-chain" which does not equal "vkey-hash-T1"
    When the pipeline reaches "MATCHING"
    Then the job transitions to status "FAILED"
    And the error reads "on-chain verification key does not match computed key"
    And no entry is written to KV
    And the failure is surfaced to the client via the SSE stream

  Scenario: Submitter cannot inject labels not present in the compiled class
    Given a submission for HelloWorld includes a manifest claiming stateFields[0].label "OWNER_SECRET"
    When the worker reflects the compiled class and sees stateFields[0] labeled "x"
    Then the manifest is rejected because stateFields declared in the manifest must exactly match the reflected layout
    And the job transitions to "FAILED" with error "manifest stateFields disagree with reflected layout"
    And no KV entry is written

  # Manifest validation

  Scenario: zeko.manifest.json with valid action discriminator is accepted
    Given the Zeko bridge repository includes zeko.manifest.json declaring actions.discriminator at fieldIndex 0 with values {"0": "commit", "1": "witness"}
    And the reflected actionType is Field with arity 1
    When the worker validates the manifest
    Then the discriminator fieldIndex 0 is within the reflected arity
    And each declared action schema's field count does not exceed the reflected action arity
    And the manifest is merged into the VerificationResult

  Scenario: Manifest with discriminator fieldIndex out of bounds is rejected
    Given a submission's actionType has reflected arity 2
    And the manifest declares actions.discriminator.fieldIndex 5
    When the worker validates the manifest
    Then the manifest is rejected with error "discriminator fieldIndex out of bounds for actionType"

  # Sandbox and abuse protection

  Scenario: Sandbox enforces network allow-list
    Given the sandbox network policy permits only github.com, registry.npmjs.org, and the Mina GraphQL endpoint
    When the cloned package attempts to curl an arbitrary host during install
    Then the network request fails
    And the job transitions to "FAILED" with a clear installation error
    And no partial KV entry is written

  Scenario: Compile exceeds the wall-clock budget
    Given the sandbox budget is 5 minutes wall-clock
    When Class.compile() does not return within the budget
    Then the sandbox process is terminated
    And the job transitions to "FAILED" with error "compilation exceeded time budget"

  Scenario: Rate-limiting rejects excess submissions from one IP
    Given IP "203.0.113.4" has already submitted 10 jobs in the past hour
    When IP "203.0.113.4" submits an 11th contract
    Then the API returns a 429 with "submission rate limit exceeded"
    And no job is created

  Scenario: Unsigned or badly-signed worker result is rejected by the API
    Given a worker emits a VerificationResult without a valid Ed25519 signature over the canonical JSON
    When the API receives the result
    Then the result is discarded
    And KV is not written
    And the job transitions to "FAILED" with error "verification result signature invalid"

  # Address / vkey matching edge cases

  Scenario: Submission without address skips the MATCHING stage
    Given submitContractForVerification is called with no address and no network
    When the pipeline reaches MATCHING
    Then MATCHING is recorded as skipped
    And the job still transitions to VERIFIED if reflection succeeded
    And the Contract entry is written to KV but has no deployments until the indexer records them

  Scenario: Multiple addresses share one verification key entry
    Given two accounts "B62qFooA" and "B62qFooB" on network "zeko-m-devnet" each have verification_key_hash "vkey-hash-foo"
    And the vkey "vkey-hash-foo" has been verified once
    When the indexer processes a zkApp command for each account
    Then KV contains both "contract:addr:zeko-m-devnet:B62qFooA" → "vkey-hash-foo" and "contract:addr:zeko-m-devnet:B62qFooB" → "vkey-hash-foo"
    And querying contract(vkeyHash: "vkey-hash-foo") lists both addresses under its deployments

  Scenario: Re-verification of the same commit is a no-op
    Given a Contract already exists at "contract:vkey:vkey-hash-hello" for commit "abc123d"
    When someone re-submits the same repository / commit / entry / class
    Then the worker still runs the pipeline (verifies integrity)
    And the resulting vkeyHash equals the existing entry
    And KV is overwritten with the same contents
    And any existing owner claims under "contract:claim:vkey-hash-hello:*" are preserved

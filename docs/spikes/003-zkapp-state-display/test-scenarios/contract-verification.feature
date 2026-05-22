Feature: Contract submission verification and manual KV publish

  Submissions to the zeko-contract-registry repository are directories with two
  files: contract.json (the schema-validated payload that lands in KV) and
  fixtures.json (golden tests consumed only in CI). Every contract.json declares
  "version": 1 and conforms to contract.v1.schema.json. The verify job runs
  "bun run verify <dir>" on every PR touching a contract directory. Publish is
  never automatic — a maintainer triggers workflow_dispatch, which re-runs
  verify and then executes "bun run upload put <dir>". The upload script issues
  one Cloudflare KV PUT per network listed in meta.networks.

  Background:
    Given the registry repo ships "contract.v1.schema.json" at the root
    And the schema file declares a "$schema" pointing at the draft 2020-12 meta-schema
    And the registry repo ships ".github/workflows/verify.yml" triggered on pull_request only
    And the registry repo ships ".github/workflows/publish.yml" triggered on workflow_dispatch only
    And branch protection on main requires the "verify" workflow to pass
    And the publish workflow is scoped to a protected environment that holds the Cloudflare secrets

  # Stage 0 — Schema self-check

  Scenario: The verify CLI self-checks its schema file at startup
    Given "contract.v1.schema.json" is a valid JSON Schema draft 2020-12 document
    When the verify CLI starts
    Then the CLI calls ajv.validateSchema on the schema file and passes

  Scenario: A broken schema file is detected before any submission is verified
    Given "contract.v1.schema.json" has been edited to introduce an invalid construct
    When the verify CLI starts
    Then the CLI throws before touching any submission
    And stderr identifies "contract.v1.schema.json" as the malformed input

  # Stage 1 — JSON Schema (versioned, Ajv-validated, not JSON.parse-cast)

  Scenario: The verify CLI validates submissions with an Ajv-compiled validator
    Given a submission is parsed from "contract.json"
    When the verify CLI processes it
    Then the CLI passes the parsed value through an Ajv-compiled validator
    And the CLI never treats the parsed value as a Submission before validation

  Scenario: Submissions may declare a "$schema" pointing at contract.v1.schema.json
    Given a submission declares "$schema" as "https://zeko.io/schema/v1/contract.json"
    When the verify CLI runs
    Then the CLI accepts the "$schema" property
    And editors that honour $schema can validate the file in place

  Scenario: Submission missing the meta block is rejected
    When the verify CLI runs on a submission without "meta"
    Then the CLI exits 1
    And stderr contains "must have required property 'meta'"

  Scenario: Submission with an unknown schema version is rejected
    When the verify CLI runs on a submission with "version": 2
    Then the CLI exits 1
    And stderr references the "version" constant constraint

  Scenario: Submission missing the networks array is rejected
    When the verify CLI runs on a submission whose meta has no "networks" key
    Then the CLI exits 1
    And stderr contains "must have required property 'networks'"

  Scenario: Submission with an empty networks array is rejected
    When the verify CLI runs on a submission whose "meta.networks" is []
    Then the CLI exits 1
    And stderr references the "minItems" constraint on "networks"

  Scenario Outline: Address pattern is enforced for both meta and owner
    When the verify CLI runs on a submission with <field> set to "<value>"
    Then the CLI exits 1
    And stderr contains a "pattern" violation referencing <field>

    Examples:
      | field         | value       |
      | meta.address  | not-a-b62q  |
      | owner.address | B62qSHORT   |

  # Stage 2 — Semantic checks

  Scenario: State slot whose declared type spans past field 8 is rejected
    Given a submission declares state.slots = [{ at: 7, name: "owner", type: "PublicKey" }]
    When the verify CLI runs
    Then the CLI exits 1
    And stderr contains "spans [7, 9] which exceeds 8"

  Scenario: Reference to an undeclared Struct type is rejected
    Given an event variant references type "UnknownThing" not in submission.types
    When the verify CLI runs
    Then the CLI exits 1
    And stderr contains "unknown type: UnknownThing"

  Scenario: Owner address that does not match meta.address is rejected
    Given a submission's owner.address differs from meta.address
    When the verify CLI runs
    Then the CLI exits 1
    And stderr contains "owner.address != meta.address"

  # Stage 3 — Fixture execution (separate file, not in JSON Schema)

  Scenario: Fixtures file is validated and executed by the CLI
    Given a contract directory contains "contract.json" and "fixtures.json"
    When the verify CLI runs on the directory
    Then the CLI parses "fixtures.json" as a FixtureFile
    And the CLI feeds each fixture through the interpreter

  Scenario: Missing fixtures.json is rejected
    Given a contract directory contains only "contract.json"
    When the verify CLI runs on the directory
    Then the CLI exits 1
    And stderr references the missing "fixtures.json"

  Scenario: Submission whose fixtures match the interpreter output passes
    Given the LuminaPool submission with its on-chain Swap, AddLiquidity, and ReceiveMina fixtures
    When the verify CLI runs
    Then the CLI exits 0
    And stdout contains "fixtures:  OK"

  Scenario: Fixture mismatch is reported with both expected and actual
    Given the LuminaPool Swap fixture is edited so expected.amountOut equals 999999999
    When the verify CLI runs
    Then the CLI exits 1
    And stderr contains "expected"
    And stderr contains "actual"
    And stderr identifies the offending fixture index and target

  # Stage 4 — Owner signature

  Scenario: Owner-signed submission passes and is graded "owner-signed"
    Given a submission has an owner block whose signature was produced over the canonical payload
    When the verify CLI runs
    Then the CLI exits 0
    And stdout's last line is "PASS — grade: owner-signed"

  Scenario: Owner block with an invalid signature is rejected
    Given a submission has an owner block whose signature does not match the payload
    When the verify CLI runs
    Then the CLI exits 1
    And stderr contains "signature does not verify against meta.address"

  Scenario: Mutating any field of a signed submission invalidates the signature
    Given a previously signed submission is edited in place to change meta.name
    When the verify CLI runs
    Then the CLI exits 1
    And stderr contains "signature does not verify against meta.address"

  # Stage 5 — Default grade

  Scenario: Submission with neither owner nor source is graded "community-submitted"
    Given the LuminaPool submission has no owner block and no meta.source
    When the verify CLI runs
    Then the CLI exits 0
    And stdout's last line is "PASS — grade: community-submitted"

  # verify.yml workflow (PR only)

  Scenario: PR discovers and verifies only the changed contract directories
    Given a PR changes files under 3 distinct "contracts/<name>/" directories
    When verify.yml runs
    Then "bun run verify" is invoked once per changed directory
    And the workflow fails if any directory exits non-zero

  Scenario: verify.yml never writes to KV
    Given a PR is open
    When verify.yml runs
    Then no Cloudflare KV request is issued
    And verify.yml does not reference the Cloudflare secrets

  Scenario: verify.yml and publish.yml are separate files
    When the registry's workflow directory is inspected
    Then verify.yml contains no upload step
    And publish.yml contains no PR trigger

  # publish.yml workflow (manual via workflow_dispatch)

  Scenario: Maintainer triggers publish after merge
    Given a maintainer invokes workflow_dispatch with mode "put" and dir "contracts/lumina-pool"
    When publish.yml runs
    Then the job first re-runs "bun run verify contracts/lumina-pool" and succeeds
    And the job then runs "bun run upload put contracts/lumina-pool"

  Scenario: Publish fails if re-verify fails
    Given a maintainer invokes workflow_dispatch with mode "put" and dir "contracts/lumina-pool"
    But the submission was tampered with between merge and dispatch
    When publish.yml runs
    Then the re-verify step exits non-zero
    And the upload step does not execute

  Scenario: Upload script re-validates the contract with Ajv before any network call
    Given a contract directory passed to the upload script
    When the script processes the directory
    Then it calls the same Ajv-compiled validator used by verify
    And it refuses to issue any PUT or DELETE if validation fails

  Scenario: Multi-network submission uploads one KV entry per network
    Given the submission's meta.networks is ["zeko-m-devnet", "zeko-m-mainnet"]
    When the upload script runs with mode "put"
    Then the script issues a PUT for key "zeko-m-devnet:<address>"
    And the script issues a PUT for key "zeko-m-mainnet:<address>"
    And the value of each PUT equals the contract.json bytes

  Scenario: Upload script reads credentials from environment
    Given CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, and KV_NAMESPACE_ID are set
    When the upload script runs
    Then it calls the Cloudflare KV REST API with the token as a bearer header
    And no wrangler binary or shell templating is involved

  Scenario: Upload script exits non-zero if required environment is missing
    Given CLOUDFLARE_API_TOKEN is unset
    When the upload script runs
    Then the script exits 1
    And stderr names the missing environment variable

  Scenario: Delete mode removes one KV entry per network
    Given a maintainer invokes workflow_dispatch with mode "delete" and dir "contracts/lumina-pool"
    When publish.yml runs
    Then the job does not re-verify
    And the script issues a DELETE for each key derived from meta.networks

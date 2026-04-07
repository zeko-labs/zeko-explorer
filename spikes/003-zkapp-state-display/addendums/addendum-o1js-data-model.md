# Addendum: o1js Data Model — State, Events, and Actions

## zkApp State (8 Fields)

Each zkApp account stores exactly **8 Field elements** (each ~32 bytes / 256 bits) as on-chain state. Declared in o1js:

```typescript
class MyContract extends SmartContract {
  @state(Field) num = State<Field>();
  @state(UInt64) balance = State<UInt64>();
  @state(PublicKey) owner = State<PublicKey>();  // consumes 2 Fields (x, isOdd)
  // ...up to 8 Fields total
}
```

**Display implications:**
- A single `@state` may consume 1 or 2 Fields depending on the type (`PublicKey` uses 2, `Field`/`UInt64`/`Bool` use 1).
- Without metadata, there is no way to know which fields belong to which `@state` variable or what type they represent.
- The raw representation is always an array of 8 field element strings.

## Events

Events are public arbitrary data emitted with transactions. Declared at the top level of a smart contract:

```typescript
events = {
  'add-merkle-leaf': Field,
  'update': MyCustomStruct,
};
// Emitted via:
this.emitEvent('add-merkle-leaf', newLeaf);
```

**Structure:**
- Each event has a **name** (string) and **data** (array of Field elements).
- Event types are defined in the contract source but **not stored on-chain** — only the raw field arrays are persisted.
- Events cannot be accessed provably inside smart contracts (read-only from outside via `fetchEvents()`).
- Archive nodes store events indexed by emitting account and block/transaction.

## Actions

Actions are structurally similar to events but have additional power:

```typescript
// Dispatched as actions:
this.reducer.dispatch(action);

// Processable inside the contract:
this.reducer.reduce(actions, State, callback);
```

**Key differences from events:**
- Actions maintain an **action state** — a rolling hash commitment (`actionState`) that proves which actions were dispatched.
- Actions can be **processed inside smart contracts** via the reducer pattern, enabling concurrent state updates.
- Actions have a **sequence number** and **state hash** that tracks the action accumulator progression.

## NATS Payload: account_update Structure

Each `account_update` in a zkApp command (from `zeko.l2.transactions`) contains:

```json
{
  "body": {
    "public_key": "<emitting account>",
    "update": {
      "app_state": ["Set <field>" | "Keep", ...8 entries],
      "verification_key": { "data": "...", "hash": "..." } | null
    },
    "actions": [["<field>", "<field>", ...], ...],
    "events": [["<field>", "<field>", ...], ...],
    "preconditions": { ... }
  }
}
```

The `changed_accounts` array in the same NATS message contains the **post-state** of each affected account, including updated `zkapp_state`:

```json
{
  "changed_accounts": [
    {
      "account": {
        "public_key": "<base58>",
        "zkapp_state": ["<field_0>", "<field_1>", "...", "<field_7>"]
      }
    }
  ]
}
```

## Indexer Extraction Rules

1. **Events**: For each field array in `account_update.body.events` → create a `zkapp_event` record linked to the transaction and emitting account.
2. **Actions**: For each field array in `account_update.body.actions` → create a `zkapp_action` record with computed `action_state`, linked to the transaction and emitting account.
3. **State**: When `account_update.body.update.app_state` contains "Set" entries → use the post-state from `changed_accounts[].account.zkapp_state`.
4. **Verification key**: When `account_update.body.update.verification_key` is present → extract `.hash` and store on the account record.

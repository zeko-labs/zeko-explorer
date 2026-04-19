# Spike 004: Production Deployment Topology

**Status:** Not started
**Blocking:** Milestone 1 (production deployment)
**Owner:** TBD

---

## Context

The explorer backend (NATS, SurrealDB, indexers, APIs) needs to run on Hetzner infrastructure. The local development environment uses Docker Compose + wrangler. The production topology is undecided.

The design must provide a clean migration path to Kubernetes (org-level decision, no fixed timeline). All services are containerized and follow 12-factor principles.

---

## Options to Evaluate

### Option A: Single Host + Docker Compose

- All services run on one Hetzner box via Docker Compose.
- Simplest to operate. Single point of failure.
- Good enough for devnet/alphanet. Risky for mainnet.

### Option B: Single Host + Nix

- Services managed directly by Nix (systemd units or similar) on one host.
- No Docker overhead. Nix ensures reproducibility.
- Harder to migrate to K8s (no container images as a byproduct).

### Option C: Multiple Hosts + Docker Compose

- Services spread across multiple Hetzner boxes.
- Docker Compose per host, or a tool like Docker Swarm for multi-host orchestration.
- Better fault isolation. More operational complexity.

### Option D: Multiple Hosts + Nix

- NixOS on multiple hosts. Services deployed via Nix configurations.
- Most reproducible. Steepest learning curve for ops.
- Migration to K8s requires building container images separately.

---

## Evaluation Criteria

1. **Operational simplicity** — How easy is it to deploy, update, and debug?
2. **Fault isolation** — Can NATS go down without taking APIs offline?
3. **K8s migration path** — How much rework is needed when the org moves to K8s?
4. **Per-network isolation** — Each network runs its own full stack. How does this scale across devnet/alphanet/mainnet?
5. **Monitoring and logging** — What's the observability story for each option?
6. **Cost** — Hetzner instance sizing and count.

---

## Questions to Answer

1. What's the expected resource footprint per network stack? (NATS, SurrealDB, 2 indexers, 2 APIs, L1 watcher, DA monitor)
2. Can all devnet services fit on a single small Hetzner box?
3. For mainnet, what's the minimum viable topology for acceptable availability?
4. Does the team have Nix ops experience for production (NixOS, deploy-rs, etc.), or is Docker more familiar?
5. How are secrets managed in each option?

---

## Deliverables

1. **Resource estimates** per network stack (CPU, memory, disk for NATS retention + SurrealDB).
2. **Recommendation** with justification for the initial production topology.
3. **Migration sketch** showing the path from the chosen topology to K8s.
4. **Per-network deployment plan** — how devnet, alphanet, and mainnet coexist.

---

## References

- Hetzner dedicated/cloud server pricing
- Current Zeko infrastructure setup (for reference)
- NixOS deployment tools: deploy-rs, colmena
- Docker Compose production best practices

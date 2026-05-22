#!/usr/bin/env nu

let nats_url = ($env.NATS_URL? | default "nats://localhost:4222")
let is_local_url = (
  ($nats_url =~ '^nats://(localhost|127\.0\.0\.1)(:[0-9]+)?$') or
  ($nats_url =~ '^(localhost|127\.0\.0\.1)(:[0-9]+)?$')
)

if not $is_local_url {
  print --stderr $"Refusing to configure NATS stream state for non-local server: ($nats_url)"
  print --stderr "Use kubectl port-forward or another localhost binding for local setup."
  exit 1
}

def ensure_stream [
  name: string
  subjects: string
  extra_args: list<string>
] {
  let existing = (nats --server $nats_url stream info $name --json | complete)

  if $existing.exit_code == 0 {
    print $"NATS stream ($name) already exists on ($nats_url); leaving it unchanged."
    return
  }

  nats --server $nats_url stream add $name --subjects $subjects --storage file --retention limits --discard old ...$extra_args --defaults
}

ensure_stream zeko-l2 "zeko.l2.>" ["--max-age", "2160h", "--dupe-window", "2m"]
ensure_stream zeko-l1 "zeko.l1.>" ["--max-age", "2160h", "--dupe-window", "2m"]
ensure_stream zeko-health "zeko.health" ["--max-msgs", "1000"]

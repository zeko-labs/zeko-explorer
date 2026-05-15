#!/usr/bin/env nu

let nats_url = ($env.NATS_URL? | default "nats://localhost:4222")

nats --server $nats_url stream add zeko-l2 --subjects "zeko.l2.>" --storage file --retention limits --discard old --max-age 2160h --dupe-window 2m --defaults

nats --server $nats_url stream add zeko-l1 --subjects "zeko.l1.>" --storage file --retention limits --discard old --max-age 2160h --dupe-window 2m --defaults

nats --server $nats_url stream add zeko-health --subjects "zeko.health" --storage file --retention limits --discard old --max-msgs 1000 --defaults

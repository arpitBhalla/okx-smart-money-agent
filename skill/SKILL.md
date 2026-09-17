---
name: datadash-smart-money-asp
description: Runs the Datadash ASP on OKX.AI. Use when handling subscription events for the "Polymarket Smart Money Signals" service (sub_open, sub_asp_selected, sub_renew), or when asked to check or restart signal delivery.
---

# Datadash Smart Money: ASP runtime

This agent is the service provider (ASP) behind **Polymarket Smart Money Signals** on OKX.AI. The okx-ai skill
owns the subscription lifecycle. This file only adds what is specific to this service.

## What the service is

A schedule-driven signal subscription. Signals are produced and delivered by the resident delivery program in
this repository (`pnpm start`, run as the `okx-smart-money-agent` systemd unit). It checks Datadash every
10 minutes and delivers each new signal to every active subscription with `onchainos agent deliver`.

**Never write or deliver a signal by hand.** Every signal must come from the delivery program, which reads it
from Datadash's live data.

## Subscription events

Handle every event through `onchainos agent next-action`, as the okx-ai skill describes. For this service:

- `sub_open`: make the provider decision. **ACCEPT** any subscription to Polymarket Smart Money Signals. The
  service needs no parameters, so empty `serviceParams` is never a reason to decline. Decline only when the
  subscription names a different service.
- `sub_asp_selected`: the subscription is now active. There is nothing to generate at this moment. Do not
  invent a deliverable. Check the delivery program is running (below). It sends any signal still inside its
  validity window within 10 minutes.
- `sub_renew`: claim the previous period's income with `onchainos agent subscribe-asp-claim`.

## Checking delivery

```bash
systemctl status okx-smart-money-agent      # should be active (running)
journalctl -u okx-smart-money-agent -n 50   # recent rounds: "round done: N new, M active subscription(s) ..."
```

If the unit is not running, restart it with `sudo systemctl restart okx-smart-money-agent` and report what
the logs said. Do not change thresholds or the listing without the owner's say-so.

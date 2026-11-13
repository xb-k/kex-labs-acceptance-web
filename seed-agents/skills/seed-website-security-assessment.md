---
name: website-security-assessment
description: Universal website security assessment — coverage-driven, dynamically-researched, evidence-backed. Black / gray / white box.
argument-hint: "One or more target URLs; optionally source code and/or a tech-stack profile"
disable-model-invocation: true
---

Assess a website by requirement coverage, not a fixed tool list. Research check items and tools per target; validate findings on an evidence ladder.

## Guardrails

- **Authorization first.** No active test until all five facts in step 1 are confirmed.
- **No production harm.** When unsure, mark `not-tested`, never run. See `reference/safety.md`.

## Steps

1. **Authorization gate.** Collect: (a) who authorized, (b) target allowlist (one or more URLs), (c) permitted intensity, (d) prohibited targets/actions, (e) emergency contact. Infer the box (black / gray / white) from the inputs, per `reference/methodology.md`.
   - Done when all five are recorded; missing any → passive only.

2. **Asset validation + profile + attack surface, per URL.** Confirm asset identity first (canonical host, resolved IP, CDN, WAF, TLS cert, environment) matches the expected target — flag any mismatch. Then profile stack and role (page / admin / API / other), and build the endpoint inventory per `reference/methodology.md`. Parse gray/white-box inputs per `reference/methodology.md` (tech-stack → tech-profile; source → git / local / archive; credentials → test accounts). Gray/white-box: verify provided items with light fingerprint checks, flag mismatches. Black-box: fingerprint platform / CMS / server / language (shallow, mandatory), then plugins / components / versions (deep, best-effort, mark `not-enumerated`).
   - Done when a tech profile exists and unverified items are marked, not assumed.

3. **Build the coverage matrix.** Pull the full WSTG checklist per dimension (`reference/coverage.md`) plus the fixed web baseline (`reference/web-baseline.md`), add system-specific items by research (parallel subagents, one per technology / dimension), score each (applicability / impact / reachability) into must / selective / record-only; choose a method per item.
   - Done when every item has a tier + method and every not-applicable item has a reason.

4. **Select tools.** For each must / selective item, research per `reference/tool-selection.md` (check items + vulnerabilities + tools), fill the suitability table, pick the smallest effective set.
   - Done when every must / selective item has a selected tool with a recorded reason.

5. **Propose the plan.** Write `templates/assessment-plan.md`: tool plan, T3 items listed individually, rate limit, stop conditions. Get one-time approval.
   - Done when the user approves.

6. **Execute.** Passive → active, throttled, per `reference/safety.md`. Treat every tool result as a candidate finding.
   - Done when every must / selective item has a tool result or an explicit `not-tested`.

7. **Validate.** Push each candidate through the evidence ladder in `reference/evidence.md` (parallel subagents, one per finding); assign Confirmed / Highly Likely / Likely / Possible / Informational.
   - Done when every finding has a status and supporting evidence.

8. **Coverage gate.** Every must / selective item has method + tool + evidence (or explicit `not-tested` with reason); every record-only / not-applicable item has its reason. Block the report until it passes.
   - Done when the gate passes.

9. **Report.** Write `templates/security-report.md` (Markdown + JSON): findings with severity + evidence + status, coverage matrix, research provenance, explicit gaps.
   - Done when both files exist and no finding lacks severity, evidence, or status.

## Retest mode

Given a prior JSON report + remediation notes, re-test prior findings + related rows — version verification, original PoC replay, related-row regression; emit `templates/retest-report.md` with per-finding status: Fixed / Still vulnerable / Partially fixed / Not retested.

## References

- `reference/methodology.md` — pipeline, standards union, assessment modes, attack surface, scope, capability boundary. Steps 1–2.
- `reference/coverage.md` — check-item dimensions, scoring, gate. Steps 3, 8.
- `reference/web-baseline.md` — fixed cookie / CSP / SRI / header rules with classification. Step 3.
- `reference/tool-selection.md` — source tiers, three-part research, suitability table. Step 4.
- `reference/safety.md` — intensity tiers, rate limits, stop conditions. Steps 5–6.
- `reference/evidence.md` — evidence ladder, impact rating, status rules. Step 7.

# Enterprise Security Scope: Sizing Pass (FR6.18)

> Scoping document, 2026-08-17, delivering FR6.18 from
> [`../backlog/101-feedback-round-4.md`](../backlog/101-feedback-round-4.md). Not code and
> not an overlay: nothing here is tasked until Jordan dispositions the open decisions at
> the end. Sizes use the backlog scale (1pt ≈ an hour or two · 2pt ≈ a half-day ·
> 3pt ≈ a full day). Ship-tier vocabulary: **OSS default** = lands in the public
> FSL-1.1-MIT build for everyone; **enterprise** = only worth building for orgs that
> deploy keywork as shared infrastructure, gated behind the P2 server if it needs one.

## The honest frame first

keywork today is a single-user local tool. There is no server, no accounts, no fleet.
That shape already buys a lot of what enterprise checklists ask for: nothing phones home,
credentials never leave the machine, the blast radius of any one install is one
developer's workspace. The gap analysis below is therefore two different lists wearing
one name. Some items harden the local tool itself (sandbox, secrets, supply chain) and
those belong in the OSS default because every user deserves them. Others only exist once
keywork becomes shared infrastructure (SSO, centralized audit, admin policy) and those
should wait for the P2 server rather than being bolted onto a local binary that has no
identity to federate.

The second frame worth stating: the security review order of record (93, WP-1..3) already
put the P0 hardening in the ground. This doc is about the next ring out, the things a
security questionnaire asks about before a company lets keywork touch its monorepo.

---

## 1. Audit log

**Today.** The session JSONL tree (Pi format v3, D8) is the audit substrate: every
message, tool call, compaction event, fork, model change lands as a typed entry with
id/parentId/timestamp, human-readable and greppable under the session dir. The crash
journal (`~/.keywork/tui-crash.log`) and the debug stream (`debug/*.jsonl` via
`engine/src/diagnostics.ts`) cover the failure paths. A19 (103) is already tasked at 2pt
to widen this to the full bar: permission grants and denials, preset changes, mode flips,
every context injection with provenance, all as first-class replayable entries.

**Enterprise bar.** Three things the JSONL doesn't give you: tamper evidence (the files
are plain user-writable JSON), retention/export (auditors want "give me everything agent
X did in March" without spelunking a home directory), and central collection (a security
team wants the fleet's logs in their SIEM, not on 200 laptops).

**Cost.**
- A19 as tasked, 2pt (already in the backlog; it is the content prerequisite for
  everything else here, since an audit log that omits permission decisions is theater).
- Hash-chained entries plus a `keywork audit export` command (per-entry hash of
  previous-hash + content, verify on export, emit a portable bundle), 2pt.
- SIEM forwarding (structured event shipper riding the D7 bus vocabulary, OTLP or plain
  HTTPS batch, config-declared endpoint), 3pt.

**Tier.** A19 and the export command are OSS default: single users benefit from replay
integrity too, and the JSONL stays the format. The SIEM forwarder is enterprise and
should not exist before the P2 server gives it a natural home.

## 2. SSO / IdP

**Today.** Nothing, correctly. Provider credentials are per-user (`~/.keywork/auth.json`,
the `api_key`/`oauth` tagged union), workspace trust is per-user
(`~/.keywork/trust.json`), and there is no keywork account anywhere. The OpenAI
subscription sign-in is the provider's identity, not keywork's.

**Enterprise bar.** Enterprise SSO means "our IdP decides who can use this and our
offboarding flow revokes it." For a local binary that is a policy fiction: the developer
has the binary and the API keys regardless. It becomes real exactly when the P2 server
lands and shared workspaces exist, because then keywork holds a surface an IdP can
actually gate.

**Cost.**
- OIDC on the P2 server (login redirect, token validation, session identity attached to
  workspace membership and audit entries), 3pt, honestly bigger if group-based
  authorization comes with it.
- SCIM provisioning: not sized, refused for now; it presumes a fleet-management story
  keywork has not chosen to have.

**Tier.** Enterprise, hard-gated on P2. Zero pre-P2 work, and the D7 bus being
server-shaped from day one means nothing needs restructuring to make room for it.

## 3. Secret handling

**Today.** Better than most of the field: credentials live in `~/.keywork/auth.json`
(0600, dir 0700) as a tagged union, never in the shareable config; stored credentials
outrank ambient env vars so a stale shell export can't hijack a provider; WP-1's bash
env scrub strips `*_API_KEY` and `KEYWORK_*` from child processes; the trust store
carries the same file-mode discipline. The known weakness is named in 103: it is
plaintext at rest, and `mcpServers.env` secrets ride the config layer.

**Enterprise bar.** Secrets at rest in the OS credential store, no secret material in
any file a backup agent or dotfiles sync might sweep, and a redaction guarantee for
every log surface (session JSONL, crash log, debug stream, future SIEM export).

**Cost.**
- E9 as tasked (103), 2pt: DPAPI/Credential Manager, Secret Service, Keychain;
  config references secrets by name; plaintext as `.describe()`-justified opt-out.
- Redaction sweep, 1pt: a single `redactSecrets` seam every log writer passes through,
  with a test that plants known secret shapes in tool output and proves they never
  reach disk.
- Policy switch `secrets.requireKeychain`, 1pt: fails startup rather than falling back
  to plaintext, for orgs that want the opt-out closed.

**Tier.** E9 and the redaction sweep are OSS default; single users get shoulder-surfed
and laptop-stolen too. The hard-require switch is a config option either tier can set,
so it ships with E9 rather than as an enterprise feature.

## 4. Sandbox / jail posture

**Today.** Two distinct layers, and being honest about the difference is the point.
The root jail (`engine/src/tools/confine.ts`, WP-1) confines `read`/`write`/`edit` to
the resolved project root at the path level; escapes throw before any I/O. The
permission gate (allow/ask/deny matrix, glob-scoped bash rules with the
chaining-character deny rule, `careful`/`standard`/`open` presets with
loosening-requires-confirmation) is the approval layer on top. What neither does:
confine what `bash` children actually touch. A permitted command can write anywhere the
user can. And per 103's framing lift, MCP servers are **trusted executable code running
outside the jail**: the config layer gates which servers load, the jail never sees
their syscalls.

**Enterprise bar.** OS-enforced confinement, which is exactly E8: the
`read-only`/`workspace-write`/`full-access` mode model with a fail-closed runner seam
(a platform runner must return enforcing arguments or the spawn fails), then real
enforcement via bwrap/Landlock on Linux and restricted tokens on Windows. Plus, for
orgs, the ability to pin policy: an admin-set floor (preset and sandbox mode) that the
local user cannot loosen from inside the TUI.

**Cost.**
- E8a mode model + runner seam + fail-closed tests, 3pt (as tasked in 103).
- E8b Linux enforcement, 3pt, contingent on the Q-DSH6 spike; a failed spike re-sizes
  upward.
- E8c Windows enforcement, 3pt, same contingency.
- Admin policy floor (a system-scope config layer that wins merges and renders as a
  locked indicator, honest-UI rule from E2), 2pt.

**Tier.** E8a–c are OSS default and are the single most load-bearing line in any
security review of an agent harness; shipping OS enforcement to everyone is also the
credibility move. The admin floor is enterprise: it only means something when someone
other than the user owns the machine's policy.

## 5. Update / supply-chain integrity

**Today.** The strongest area relative to effort spent: exact-pinned dependencies
enforced by `scripts/check-pins.ts` (which also requires GitHub Actions pinned to full
SHAs), `bun.lock` committed, `scripts/check-guardrails.ts` in CI, attribution discipline
in `NOTICE`. There is no auto-updater, which for once is a security feature: nothing
fetches and executes new code at runtime.

**Enterprise bar.** Signed release artifacts with verifiable provenance, so an org can
prove the binary they deployed came from this repo's CI and not a typosquat. If an
updater ever ships, signature verification before apply is non-negotiable, and the
fail-closed runner-seam precedent from E8 is the design to copy.

**Cost.**
- Release signing at G3 packaging (minisign or Sigstore keyless in CI, verification
  instructions in the README, checksums in the release), 2pt.
- Build provenance attestation (GitHub artifact attestation, SLSA-style, generated in
  the release workflow), 2pt.
- Updater integrity: 0pt now by policy; the decision of record should be that any
  future auto-update task inherits a mandatory verify-before-apply acceptance
  criterion.

**Tier.** OSS default, and launch-critical rather than optional: the repo goes public
at the M2 demo, and unsigned binaries from a brand-new repo is the exact shape supply
chain attacks impersonate.

## 6. SBOM

**Today.** None generated, but `bun.lock` plus exact pins means the input data is
already complete and honest; an SBOM here is a format-conversion exercise, not an
inventory hunt.

**Enterprise bar.** CycloneDX (or SPDX) generated in CI per release, attached to the
release artifacts next to the provenance attestation, so dependency-scanning tooling on
the org side has something to ingest.

**Cost.** 1pt: lockfile-to-CycloneDX in the release workflow, plus a CI check that the
SBOM stays in sync with the lock (the `check-pins.ts` ratchet precedent: a texture
without a ratchet is an aspiration).

**Tier.** OSS default, bundled into the same G3 release-workflow pass as signing.

## 7. Disclosure policy

**Today.** None, which is fine for a private repo and a real gap the moment it goes
public.

**Enterprise bar.** A `SECURITY.md` with a private intake channel (GitHub private
vulnerability reporting is free and sufficient), a stated response window, a supported-versions
statement, and a note on the coordinated-disclosure expectation. Enterprises
read this file before anything else in the repo.

**Cost.** 1pt: write the policy, enable private advisories, link it from the README.
The only real content decision is the response-window promise, which is Jordan's to
make because Jordan is the one who has to keep it.

**Tier.** OSS default, and it must exist at the moment of going public, so it belongs
to the M2 launch checklist alongside CI-green and docs-coherent.

---

## Totals

**OSS default tier: 21pt**, of which 13pt is already in the backlog:

| Item | pt | Status |
|---|---|---|
| A19 gates/injections as entries | 2 | tasked (103) |
| E8a sandbox mode model | 3 | tasked (103) |
| E8b Linux enforcement | 3 | tasked (103) |
| E8c Windows enforcement | 3 | tasked (103) |
| E9 keychain secrets | 2 | tasked (103) |
| Audit hash-chain + export | 2 | new |
| Log redaction sweep | 1 | new |
| Release signing | 2 | new (G3 rider) |
| Build provenance | 2 | new (G3 rider) |
| SBOM in CI | 1 | new (G3 rider) |
| SECURITY.md + intake | 1 | new (launch checklist) |

**Enterprise tier: 8pt**, all gated on P2 or org deployment:

| Item | pt | Gate |
|---|---|---|
| OIDC on the P2 server | 3 | P2 |
| SIEM/OTLP audit forwarder | 3 | P2 |
| Admin policy floor | 2 | org demand |

## Recommended sequencing

1. **Launch wall (before the M2 public moment):** SECURITY.md (1pt), release signing +
   provenance + SBOM as one G3 release-workflow pass (5pt). These are about how the
   repo looks the day strangers find it.
2. **Already-sequenced backlog:** A19, E9, then E8a → E8b → E8c per 103's own ordering
   and the Q-DSH6 spike. Nothing in this doc reorders them; the enterprise story just
   confirms they were the right calls.
3. **Rides A19:** the redaction sweep and the audit export command, since both want
   A19's widened entry vocabulary in place first.
4. **Post-P2, on demand:** OIDC, SIEM forwarder, admin policy floor. Do not build any
   of these speculatively; each should be pulled by a real deploying org.

## Open decisions for Jordan (Q-ES)

- **Q-ES1: is an enterprise build a product at all?** Everything in the enterprise
  tier could stay "consulting-grade config on the OSS build" instead of a distinct
  distribution. A separate build means a second CI matrix and a licensing story on top
  of FSL-1.1-MIT. Proposal: no separate build; enterprise features are OSS code paths
  that activate on config, revisit if a paying org asks.
- **Q-ES2: disclosure response window.** 90-day coordinated disclosure with a
  best-effort 7-day acknowledgment is the community-normal promise for a solo
  maintainer. Committing to less is a trap; committing to nothing reads badly.
- **Q-ES3: signing mechanism.** Sigstore keyless (no key custody, transparency log,
  heavier verify story for users) versus minisign (one key Jordan must protect,
  trivial verify). Proposal: minisign at launch for the simple verify one-liner,
  Sigstore attestation added alongside when the provenance task lands.
- **Q-ES4: hash-chained audit: OSS default-on or opt-in?** Default-on costs a hash
  per entry (noise in diffs, slight write cost) and buys tamper evidence almost nobody
  local needs. Proposal: the chain is always computed, verification only runs on
  export, and the JSONL stays byte-diffable by keeping the hash in the entry rather
  than a sidecar. Needs a look at what it does to Pi-format compatibility (D8).
- **Q-ES5: does the admin policy floor deserve to exist before someone asks?**
  It is the one enterprise item with no P2 dependency, so it could land early. But it
  is also a config surface (D9 says every option is a design failure until justified)
  serving a user who does not yet exist. Proposal: recorded here, built never, until
  a deploying org makes it concrete.
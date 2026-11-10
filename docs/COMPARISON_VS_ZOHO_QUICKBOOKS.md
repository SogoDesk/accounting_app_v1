# Honest Comparison — Your App vs Zoho Books vs QuickBooks Online

_Grounded in the actual current codebase (migrations 000–009, the GL engine layer, the full page set) • 29 June 2026_

## First, what your app actually is now (no inflation)

This is no longer a CRUD invoicing tool. Surveying the real code, it has:

- **A real double-entry general ledger** (`journal_entries`/`journal_lines`, deferred balance trigger, chart of accounts, fiscal periods) that subledgers post into through one engine (`services/gl/ledgerEngine.js`, 236 lines — the posting service routes through it).
- **An immutable, hash-chained ledger** (`prev_hash`/`entry_hash`, an immutability trigger, and a `verify-chain` endpoint with a "Verify ledger integrity" button).
- **Multi-entity + multi-location hierarchy** (`org_units`: Group → Entity → Branch) with **location tagging on every line** and **hierarchy consolidation with intercompany eliminations** (1600/2600 net to ~0).
- **Multi-currency** with functional-currency conversion, realized FX, and **unrealized FX revaluation** with auto-reversal.
- **Row-level RBAC** (`user_org_access` + scope middleware restricting queries to a user's allowed entities) plus Postgres RLS scaffolding.
- **Accrual/deferral recognition engine** + a **period-close** runner (FX revaluation + scheduled recognition).
- **Operating expenses** subledger (categories, fixed/recurring, variable, GST/TDS, reimbursements, monthly matrix).
- **Staffing-native domain**: candidates, placements (bill vs pay rate, gross margin), and **360° views** for client/vendor/placement/candidate that interlink.
- **Schema-free custom fields** (`custom_fields jsonb` + a `custom_field_defs` registry) and **race-free document numbering** (per-scope Postgres sequences).

That is a genuinely advanced ledger core. On a few specific axes it **exceeds** what QuickBooks Online and Zoho Books expose at their normal price tiers. But a ledger is roughly 20% of what makes those products worth paying for. The honest comparison is mostly about the other 80%.

## Feature-by-feature

Legend: ✅ strong · 🟠 partial/basic · ❌ absent

| Capability | Your app | Zoho Books | QuickBooks Online |
|---|---|---|---|
| Double-entry GL, COA, journals | ✅ (and immutable hash chain — they don't expose this) | ✅ | ✅ |
| Trial balance / P&L / Balance sheet | ✅ | ✅ | ✅ |
| **Multi-entity consolidation w/ eliminations** | ✅ native, free | 🟠 separate orgs; consolidation is limited / add-on | 🟠 only on QB Online **Advanced**, or via 3rd-party |
| **Location/branch-level tagging + roll-up** | ✅ unlimited hierarchy | 🟠 "branches" on higher plans | 🟠 "classes/locations", capped |
| Multi-currency + realized FX | ✅ | ✅ | ✅ |
| **Unrealized FX revaluation** | ✅ | 🟠 | 🟠 (Advanced) |
| Row-level access by location | ✅ | 🟠 role-based, coarser | 🟠 limited |
| Custom fields without migration | ✅ on every ledger line | 🟠 on records, limited | 🟠 limited |
| Staffing (placements, margin) | ✅ native | ❌ | ❌ |
| **Bank feeds (auto-import transactions)** | ❌ | ✅ thousands of banks | ✅ best-in-class |
| **Bank reconciliation** | ❌ | ✅ | ✅ |
| **Tax engine + filing (GST/VAT/sales tax returns)** | 🟠 stores GST/TDS amounts only | ✅ filing in many regions | ✅ filing + e-file |
| **Customer payment collection (cards/ACH/UPI)** | ❌ | ✅ gateways | ✅ QuickBooks Payments |
| **Receipt/bill OCR capture** | ❌ | ✅ | ✅ |
| Recurring invoices / subscriptions | 🟠 recurring expenses only | ✅ | ✅ |
| Customer/vendor portal | ❌ | ✅ | ✅ |
| Inventory | ❌ | ✅ | ✅ |
| Payroll | ❌ | 🟠 (regional) | ✅ (add-on) |
| Reporting depth (100s of canned reports, custom builder) | 🟠 the core statements + dashboards | ✅ | ✅ |
| Workflow automation / approvals | 🟠 bill approval only | ✅ rules engine | ✅ |
| Integrations marketplace | ❌ | ✅ 1000s | ✅ 1000s |
| Mobile apps | ❌ | ✅ | ✅ |
| Audit log | ✅ + hash-chain integrity proof | ✅ | ✅ |
| Security certifications (SOC 2 / ISO) | ❌ | ✅ | ✅ |
| Reliability / uptime / backups / support | ❌ (self-run) | ✅ SLA | ✅ SLA |
| Proven, reconciled to real bank data | ❌ (unproven) | ✅ | ✅ |
| Per-seat cost | $0 (you own it) | $ per org/user | $ per company/user |

## Where your app genuinely WINS (for your specific business)

These are real, not flattery:

1. **True multi-entity + branch consolidation with eliminations, at no extra tier.** This is the thing both competitors gate behind their most expensive plans or third-party tools. You have it natively across an unlimited hierarchy.
2. **A cryptographically immutable ledger you can *prove* is untampered.** Neither QB nor Zoho exposes a verifiable hash chain to you. For audit defensibility, that's a differentiator.
3. **Staffing-native accounting.** Placement → invoice → payment, with bill-rate vs pay-rate gross margin and candidate/client 360°. QB/Zoho will never model your core business; you'd bolt a CRM/ATS alongside them.
4. **Schema-free custom fields on the ledger itself**, and full data ownership with zero per-seat cost.
5. **Tailored exactly to your process** — no fighting a generic product's assumptions.

## Where it honestly LOSES — and these matter a lot

1. **No bank feeds, no reconciliation.** This is the big one. QB/Zoho continuously import bank transactions and let you reconcile the ledger to the actual bank statement. **Your ledger is not tied to bank reality.** An elegant, immutable, consolidated ledger that nobody has reconciled to a bank statement is *internally* consistent but not yet *externally* trustworthy. Until you build reconciliation, the books can drift from what's actually in the bank.
2. **No tax compliance/filing.** You store GST/TDS amounts; you do not compute or file returns. QB/Zoho do region-specific tax and e-filing. For statutory compliance you'd still need an accountant/another tool.
3. **It's unproven.** There is little real data flowing, **no automated test suite**, and earlier security issues (secrets committed to git, JWT in localStorage) that a system of record must not have. QB/Zoho carry a decade of edge cases, thousands of customers shaking out bugs, SOC 2, backups, and 24/7 ops. Yours runs on your machine with no SLA.
4. **None of the "boring" breadth**: payment collection, OCR receipt capture, recurring billing/subscriptions, customer portal, inventory, payroll, mobile apps, an integrations marketplace, hundreds of canned reports. Individually small; collectively, it's most of why people pay for these products.
5. **No support, onboarding, or guidance** — you are the support team.

## The honest verdict

**As an architecture / ledger core:** your app is genuinely impressive and, on multi-entity consolidation, eliminations, location tagging, immutability, and staffing-fit, it is *more capable for your use case* than the mid-tier of QuickBooks Online or Zoho Books. You did not build a toy.

**As an accounting product:** it is not close, and it's important to be clear-eyed about why. The gap isn't the ledger — it's everything around it that makes a ledger *trustworthy and usable*: reconciliation to real bank data, tax/compliance, proven reliability, security hardening, breadth, and a support/ops organization. QB and Zoho are not better at double-entry than you; they are better at being a dependable, compliant, reconciled, fully-staffed product.

**The realistic positioning for you:** treat this as a superb **in-house operational and management-accounting system** purpose-built for your staffing, multi-entity reality — a place to run AR/AP/expenses, see true consolidated and per-branch numbers, and own your data. For the things that need to be tied to bank reality and filed with a government, either (a) **reconcile/feed it against a compliant system** (your schema already has `quickbooks_*` sync fields — that intent was there), or (b) **invest specifically in the missing trust layer**: bank import + reconciliation first, then a test suite, then security hardening, then tax. In that order.

You can absolutely beat QuickBooks and Zoho *at being your company's tool*. You will not beat them at *being a general accounting product*, and you shouldn't try — the win is being unbeatable at the narrow thing they can't tailor to you, while staying honest that the books aren't audit-ready until they're reconciled and tested.

## If you want the gap closed, in priority order
1. **Bank statement import + reconciliation** (CSV/OFX first; feeds later). Without this, nothing else makes the books trustworthy.
2. **Automated test suite** around posting, FX, eliminations, recognition — a ledger of record cannot be untested.
3. **Security hardening** — rotate the committed secrets, move tokens to httpOnly cookies, finish RLS enforcement.
4. **Tax computation + return-ready reports** for your regions (US/UK/India).
5. **Real usage** — get a full month of actual transactions flowing and reconciled before trusting any statement.

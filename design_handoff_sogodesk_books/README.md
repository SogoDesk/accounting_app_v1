# Handoff: SogoDesk Books — UI redesign

## Overview
A full visual redesign of SogoDesk Books (React 18 + Vite frontend, `accounting_app/frontend`).
The current app uses a left sidebar with seven accordion groups and a dark glass "saas" theme.
The redesign replaces that shell with a **centred top pill nav with per-group dropdowns**, and
restyles every module screen on a single card system that ships in **light and dark** from one
set of tokens.

Eleven screens are specified: Dashboard, Clients, Payments, Bills & vendor payments, Expenses,
Chart of accounts + Journal entries, Financial reports, Banking & reconciliation, Placements &
candidates, Timesheets, Settings.

## About the design files
`SogoDesk Books Screens.dc.html` and `SogoDesk Books Mockups.dc.html` are **design references
authored in HTML** — static prototypes showing intended layout, colour, type and state. They are
not production code and should not be copied into the app.

The task is to **recreate these designs inside the existing React + Vite codebase**, using its
established patterns: `src/layouts/MainLayout.jsx` for the shell, `src/components/ui/index.jsx`
for shared primitives, `src/pages/**` for screens, `src/styles/saas.css` for tokens, `recharts`
for charts (already a dependency, used in `DashboardPage.jsx`), and `ThemeContext` for light/dark.

## Fidelity
**High fidelity.** Colours, type, spacing, radii and shadows below are final. Recreate pixel-perfectly.
All screens are designed at a **1440px** content width inside a 22px page gutter.

## Design tokens

### Colour — light
| Token | Value | Use |
|---|---|---|
| `--canvas` | `radial-gradient(900px 320px at 18% -8%, #1b1839→transparent 70%), radial-gradient(700px 300px at 92% 6%, #161a35→transparent 70%), #edeefa` (light: `#e6e5fb` / `#e9edfb` / `#edeefa`) | page background behind the app card |
| `--surface` | `#ffffff` | app card, all cards |
| `--surface-sunken` | `#faf9fe` | table header + footer rows |
| `--border` | `#e6e4f2` | controls, buttons, chips |
| `--border-soft` | `#efedf7` | cards |
| `--border-hair` | `#eceaf6` / `#f4f3f9` | dividers / table row rules |
| `--ink` | `#14131f` | headings, figures |
| `--ink-2` | `#3c3a52` | body |
| `--muted` | `#8b8a9c` | captions, labels |
| `--faint` | `#a6a4b8` | table column headers, placeholders |
| `--icon` | `#4a4860` | icon strokes |
| `--accent` | `#5b4de3` | primary |
| `--accent-nav` | `#6552e8` | active nav pill |
| `--accent-soft` | `#f0edfd` / `#eef0fd` | accent tints |
| `--accent-row` | `#f7f5ff` + `inset 3px 0 0 #5b4de3` | selected table row |
| `--success` | `#2ec27e` (text on tint `#1a8f5c`, tint `#e7f8f0`) | |
| `--danger` | `#f04438` (text on tint `#c9372c`, tint `#fdeceb`) | |
| `--warn` | `#e08b3a` (text on tint `#96701f`, tint `#fdf3e8`) | |
| chart series | `#5b4de3` → `#7a6bef` gradient (primary), `#ddd8fa` (secondary), `#8b7cf0`, `#c9c1f8`, `#e4e0fb`, `#f0a05a` | |

### Colour — dark
Same structure, swapped surfaces. Nothing about layout or size changes.
| Token | Value |
|---|---|
| `--canvas` | `radial-gradient(900px 320px at 18% -8%, #1b1839, transparent 70%), radial-gradient(700px 300px at 92% 6%, #161a35, transparent 70%), #08080f` |
| `--surface` (app card) | `#12111f`, border `rgba(255,255,255,.06)` |
| `--surface` (cards) | `#1a1930`, border `rgba(255,255,255,.08)` |
| `--surface-sunken` | `rgba(255,255,255,.04)` |
| `--border` | `rgba(255,255,255,.1)` |
| `--border-hair` | `rgba(255,255,255,.08)` / `rgba(255,255,255,.07)` |
| `--ink` | `#f2f1f8` |
| `--ink-2` | `#c4c2d8` |
| `--muted` | `#8b89a3` |
| `--faint` | `#77748f` |
| `--icon` | `#b6b4cc` |
| `--accent` | `#5b4de3`, text-on-dark `#a99bff`, tint `rgba(101,82,232,.26)` |
| `--accent-row` | `rgba(124,108,245,.22)` + `inset 3px 0 0 #8b7cf0` |
| `--success` / `--danger` / `--warn` text | `#6bdba7` / `#ff8b82` / `#f0b070` |
| tints | `rgba(46,194,126,.18)` / `rgba(240,68,56,.18)` / `rgba(224,139,58,.2)` |

**Theme-aware inversion of the nav pill.** In light mode the nav pill is dark (`#17162a`) with
`#b9b7cc` labels. In dark mode it inverts to light (`#f5f4fa`, border `rgba(255,255,255,.16)`)
with `#54526b` labels. The active pill is `#6552e8` with white text in both.

### Typography
- **UI:** Plus Jakarta Sans — 400/500/600/700/800. Google Fonts.
- **Numerals, codes, dates:** IBM Plex Mono — 400/500/600. Every currency figure, document number,
  account code, FX rate and date uses it. Large figures also set `font-variant-numeric: tabular-nums`.

| Role | Spec |
|---|---|
| Page title | 800 40px/1, `letter-spacing:-.03em`, `--ink` |
| Page subtitle | 500 13px, `--muted`, 7px below title |
| Brand wordmark | 800 16px/1.1, `-.02em` |
| Brand sub | 500 10.5px/1.3, `--muted` |
| Nav pill item | 600 13px (active 700), `white-space:nowrap` |
| Card / section title | 800 15px, `-.01em` |
| KPI label | 700 11px, `letter-spacing:.07em`, `text-transform:uppercase`, `--muted` |
| KPI figure | 800 31px/1, `-.035em`, tabular |
| KPI currency prefix | 600 16px, `--muted` |
| KPI delta | 700 11.5px (colour) + 500 11.5px `--muted` |
| Table column header | 700 10px, `.07em`, uppercase, `--faint` |
| Table cell | 500 13px, `--ink-2`; primary cell 700 13px `--ink`; numeric 600–700 12.5px mono |
| Table sub-line | 500 11px, `--muted` |
| Status chip | 700 10.5px, `letter-spacing:.03em`, `padding:4.5px 10px`, `border-radius:999px` |
| Button label | 700 14px (primary) / 700 13.5px (secondary) / 700 12.5px (in-panel) |
| Filter pill | 600 12.5px (active 700) |

### Geometry
| Element | Spec |
|---|---|
| Page gutter | 22px around the app card |
| App card | `border-radius:30px`, `padding:26px 28px 28px` |
| Card | `border-radius:22px`, `padding:20px` |
| Small card / tile | `border-radius:18px`, `padding:16px` |
| List panel | `border-radius:24px`, `padding:20px 20px 22px` |
| Table shell inside a panel | `border-radius:16px` |
| Nav pill group | `border-radius:999px`, `padding:5px`, item `padding:9px 14px`, gap 2px |
| Dropdown panel | `border-radius:16–18px`, `padding:7–8px`, item `padding:9px 11px`, `border-radius:10–11px` |
| Primary button | `height:46px`, `padding:0 22px`, `border-radius:14px` |
| Secondary button | `height:46px`, `padding:0 18px`, `border-radius:14px` |
| Icon button (header) | `46×46`, `border-radius:14px`; topbar `40×40`, `border-radius:12px` |
| Filter pill | `height:42px`, `padding:0 15px`, `border-radius:999px` |
| Table row | `height:52px` (58px when the row carries a sub-line), header 40px, footer 46px |
| Avatar | circle, 32px in tables, 38–40px in headers |
| Grid gap | 16px between cards, 14px inside panels, 10–12px between controls |

### Elevation
| Level | Value |
|---|---|
| App card | `0 1px 3px rgba(20,19,31,.05), 0 28px 70px -30px rgba(31,28,74,.28)` |
| Card | `0 1px 2px rgba(20,19,31,.04), 0 10px 28px -16px rgba(20,19,31,.16)` |
| Accent card | `0 1px 2px rgba(91,77,227,.06), 0 12px 30px -18px rgba(91,77,227,.4)` |
| Primary button | `0 8px 20px rgba(91,77,227,.32)` |
| Dropdown | `0 18px 44px rgba(23,22,42,.16)` (nav) / `0 22px 54px rgba(23,22,42,.18)` (profile) |
| Dark-mode equivalents | same geometry, `rgba(0,0,0,.6–.85)` |

## The shell (replaces `MainLayout.jsx`)

### Top bar — single 40px-tall row, three zones
**Left:** 40×40 logo mark (`border-radius:12px`) + wordmark "SogoDesk Books" over
"Multi-entity accounting & staffing".

**Centre:** the nav pill. Seven items in the order of `NAV_GROUP_ORDER`:
Home · Sales · Purchases · Expenses · Accounting · Workforce · Settings.
Every item except Home carries a chevron at 11px, `opacity:.6` when inactive. The active group's
pill is filled `#6552e8`. **Labels must never wrap** — set `white-space:nowrap`.

**Right:** region switcher pill (status dot + region name + currency code in mono + chevron,
`height:40px`, `border-radius:999px`), search icon button, notification icon button with a 6px
`#f04438` dot ringed in the surface colour, and the avatar.

### Group dropdown
Opens on click, anchored to its trigger's left edge, 56px below the topbar, 230px wide.
A `.07em`-tracked group label, then one row per page: 16px icon, label, and the row count in mono
on the right. The current page is filled `--accent-soft` with `--accent` text.

Keep the existing permission filtering: build the pill list and each dropdown from the same
`NAV` array and `myPerms` logic already in `MainLayout.jsx` — a group whose items are all
filtered out disappears from the pill.

### Profile dropdown
Anchored to the avatar's right edge, 274px wide, `border-radius:18px`, `padding:8px`.
Order: user block (38px avatar, name 800 13.5px, role chip 700 9.5px `.06em` in accent tint) →
divider → **Change password** → **Switch to light/dark mode** → divider → **THEME COLOUR**
section → divider → **Logout** in danger colour.

**Theme colour** is a new preference. Five options, each a 22px `border-radius:7px` swatch +
13px label, the active one on `#f4f1fe` (dark: `rgba(101,82,232,.26)`) with a 15px accent check
at the right:

| Name | Hex |
|---|---|
| Purple *(default)* | `#5b4de3` |
| Blue | `#1570d6` |
| Pink | `#b8476e` |
| Green | `#53a37c` |
| Orange | `#e0a02e` |

Implement it as a CSS custom property (`--accent`) set on `:root`, persisted alongside the
existing theme preference, and derive the tints (`--accent-soft`, `--accent-row`, the button
shadow) with `color-mix(in srgb, …)` — `saas.css` already uses `color-mix` extensively.

### Page header
Back button (44px circle, 1px border), title, subtitle, then right-aligned actions:
zero or more secondary buttons, an optional icon button, and one primary button.

## Screens

Each screen below lists its content. All of them share: shell → page header → KPI row →
filter row → main content.

### 1. Dashboard
Greeting title ("Good morning, Ravi"), subtitle naming the regions and open period.
Actions: period picker, Export, Quick create.
- **KPI row, 5 up:** Invoiced · Receivables · Collected · Payables · Gross margin (a percentage,
  rendered as 800 31px figure + 700 15px unit).
- **Row 2 (1.45fr / 1fr):** *Revenue vs. expense* — a 12-month grouped bar chart, two bars per
  month (revenue on the accent gradient, expense on `#ddd8fa`), 150px tall, `border-radius:5px 5px 2px 2px`,
  a swatch legend, then a three-figure summary (Revenue YTD / Expense YTD / Net).
  *AR ageing* — a 140px donut (22px stroke) over a four-row legend (Current, 1–30, 31–60, 60+),
  then a three-stat row (DSO, Collection rate, Bad debt) and an accent-tinted forecast strip.
- **Row 3, 3 up:** Top clients by open balance (avatar rows) · Needs attention (icon rows linking
  to overdue invoices, pending approvals, unapproved timesheets, an unclosed period) · Quick actions
  (2×3 grid; the first tile is filled accent; footer shows the signed-in user and role chip).

### 2. Clients
KPIs: Active clients · Open balance · Over credit limit · Avg. payment terms.
Filters: regions, status, currency, account manager, search.
Table — Client (avatar + name + contact sub-line) · Code · Region · Terms · Cycle ·
Credit limit · Open balance · Status. Footer totals the open balance in group currency.
Clients over their credit limit show the balance in danger colour and an `OVER LIMIT` chip.

### 3. Payments
KPIs: Collected · Applied to invoices · Unapplied credit · FX gain/loss.
Main table — Receipt · Client · Applied to · Method · Date · FX rate · Amount.
Unapplied receipts show "Unapplied" in warn colour instead of an invoice number.
Right rail (336px): *Unapplied credit* list with a "Match to invoices" button, and
*By method* with a legend plus a single stacked proportion bar.

### 4. Bills & vendor payments
KPIs: Open payables · Due this week · Awaiting approval · Paid.
Main table — Bill # · Vendor · Bill date · Due · Total · Balance · Status
(`APPROVED` / `PENDING` / `PART PAID`).
Right rail (372px): *Approval queue* — one card per pending bill with Approve / Reject pills,
the top card filled accent; below it, *Recent vendor payments*.

### 5. Expenses
KPIs: Spend · Fixed/recurring · Variable · Vs. budget.
Row of three: by-category donut + legend · monthly trend bars · by-region progress bars with a
"missing receipts" warning line.
Table — Date · Category (chip) · Description · Region · Method · Receipt (`ATTACHED` / `MISSING`) · Amount.
Panel tabs: Variable / Fixed & recurring / Categories.

### 6. Chart of accounts + Journal entries
KPI row of five, one per account class: Assets · Liabilities · Equity · Income · Expenses.
Left (1fr): the account tree — Code · Account (indented 18px per level, class rows in 800) · Balance.
Right (1.12fr): journal entries list, a selected entry expanded into its debit/credit lines with a
"Balanced" footer, a `CHAIN VERIFIED` badge in the panel header, and the hash-chain line
(`prev … → hash …`) at the bottom — this surfaces the immutable ledger from `postingService`.

### 7. Financial reports
Five report cards across the top (Profit & loss, Balance sheet, Trial balance, General ledger,
Cash flow); the active one is accent-tinted with a filled icon tile.
Left: the P&L statement — Account · Amount · % rev, with section rows (Revenue, Direct costs,
Gross profit, Operating expenses, Net profit) in 800 on the sunken surface and detail rows indented.
Right: revenue mix donut, a by-region mini table, and period-close status (Closed / ready / Open).

### 8. Banking & reconciliation
Three bank account cards (the selected one accent-tinted) plus a reconciliation progress card
showing "86 of 98 lines matched", a progress bar, and `12 UNMATCHED` / `DIFF` chips.
Left: statement lines with a match/warn icon per row. Right: the suggested-match panel for the
selected unmatched line — three ranked candidates with a % match badge, the top one filled accent,
"Match to …" and "Create journal entry" actions, then a reconciliation summary.

### 9. Placements & candidates
KPIs: Active placements · Monthly revenue · Monthly cost · Blended margin · Bench candidates.
Table — Candidate (avatar + code + job title) · Client / end client · Billing type chip ·
Bill · Pay · Margin · Ends. Use the seven values from `src/data/billingTypes.js`
(`HOURLY`, `DAILY`, `WEEKLY`, `MONTHLY`, `ANNUAL`, `FIXED`, `PERM_FEE`) and compute the margin
column with `placementMargin()` — do not recompute it in the view.
Right rail: the selected placement — three 62px progress rings (Margin, Utilisation, Compliance),
an economics list, and a compliance checklist with an expiring item in warn colour.

### 10. Timesheets
KPIs: Hours submitted · Awaiting approval · Approved & ready to bill · Missing timesheets.
Panel tabs: Awaiting approval / Approved / Invoiced, with counts.
Table — Candidate · Client · Placement · Hours · Bill rate · Value · Proof · action pill
(`APPROVE`, or `CHASE` when proof is missing).
Right rail: the week grid (seven day tiles, logged days filled accent, pending in a light accent,
empty days on the sunken surface), the total, the attached client-approval file, and
"Approve & invoice" / "Reject"; below it, *Ready to invoice* grouped by client with a batch button.

### 11. Settings
Six setting cards in two rows of three — Organisation & regions, Currencies & rates,
Document numbering, Tax & rates, Notifications, Users — each with an icon tile, title,
sub-line, and 3–4 key/value rows on the sunken surface.
Below, the **roles & permissions matrix**: modules down the side, the four built-in roles across
(`SUPER_ADMIN`, `FINANCE_ADMIN`, `ACCOUNT_MANAGER`, `RECRUITER`), a filled accent tick or an empty
tile per cell, and a caption noting that deletes and user administration always require
`SUPER_ADMIN`. Right rail: audit log entries and a fiscal-year summary.

## Interactions & behaviour
- **Nav dropdown:** click to open, click-outside and Escape to close, one open at a time.
  Preserve the existing keyboard-dismiss behaviour in `MainLayout.jsx`.
- **Profile dropdown:** same open/close model; theme and theme-colour changes apply immediately
  and persist.
- **Row selection:** clicking a table row applies `--accent-row` plus the 3px inset left bar and
  drives the right-hand detail rail where one exists (Payments, Bills, Banking, Placements, Timesheets).
- **Filter pills:** an active filter switches to the accent border + tint + 700 weight; the
  "Active filters" counter next to them reflects the number applied.
- **Hover:** cards lift to the next elevation step; table rows take the sunken surface; nav and
  dropdown items take a subtle accent tint. Transition `background-color/border-color/box-shadow .2s ease`
  — matching the existing transition block at the top of `saas.css`.
- **Empty and loading states:** keep the current `SkeletonRows` component; give it the new row
  height and hairline colour.

## State
- `theme`: `'light' | 'dark'` — already in `ThemeContext`.
- `accent`: one of the five theme colours — new; store next to `theme` and write `--accent` on `:root`.
- `openGroup`: which nav dropdown is open (replaces the sidebar accordion's `openGroup`).
- `profileOpen`: unchanged.
- `activeRegion`: drives the region switcher; already loaded from `/regions`.
- Per screen: filter values, selected row id, active panel tab.
- No new data fetching — every figure shown maps to an endpoint the app already calls.

## Assets
No image assets. All icons are 24×24 stroked SVGs at `stroke-width:1.8–2.2`, taken from the
existing `iconFor()` set in `MainLayout.jsx`. The logo mark and all avatars are **placeholders**
(diagonally hatched blocks with initials) — replace them with the real brand mark and user photos.

## Files in this bundle
| File | What it is |
|---|---|
| `SogoDesk Books Screens.dc.html` | The eleven screens, each shown light and dark side by side. Open in a browser. |
| `SogoDesk Books Mockups.dc.html` | The three original direction explorations (Studio / Ledger / Console) that led to this system. Reference only. |

## Suggested order of work
1. Tokens — add the light/dark/accent custom properties to `saas.css`, extend `ThemeContext` with `accent`.
2. Shell — rewrite `MainLayout.jsx` as the top bar + dropdowns, keeping the `NAV` array,
   permission filtering and search intact.
3. Shared primitives — card, KPI card, table, status chip, filter pill, panel header with tabs,
   into `src/components/ui/index.jsx`.
4. Screens, in this order: Dashboard → Clients → Invoices → Payments → Bills → Expenses →
   Accounting → Banking → Workforce → Timesheets → Settings.

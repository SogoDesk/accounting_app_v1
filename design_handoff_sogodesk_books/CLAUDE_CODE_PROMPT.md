# Prompt for Claude Code

Run this from the repository root.

```
Read design_handoff_sogodesk_books/README.md end to end, then open
design_handoff_sogodesk_books/SogoDesk Books Screens.dc.html in a browser and look at every screen.
That HTML is a design reference, not code to copy.

Reimplement the SogoDesk Books frontend (React 18 + Vite, in frontend/) to match it, working in
this order and stopping for my review after each step:

1. Tokens. Add the light and dark custom properties from the README to src/styles/saas.css, and
   extend src/context/ThemeContext.jsx with an "accent" preference (purple #5b4de3 default, plus
   blue #1570d6, pink #b8476e, green #53a37c, orange #e0a02e). Write --accent on :root and derive
   every accent tint with color-mix so one variable retints the whole app. Persist it next to the
   existing theme value.

2. Shell. Rewrite src/layouts/MainLayout.jsx: replace the sidebar with the centred top pill nav and
   per-group dropdowns described in the README. Keep the existing NAV array, NAV_GROUP_ORDER,
   myPerms permission filtering, SEARCH_ACTIONS search and change-password modal working exactly as
   they do now — this is a visual change, not a behavioural one. Add the theme-colour section to the
   profile dropdown. The nav pill is dark on light and light on dark.

3. Primitives. Add Card, StatCard, DataTable, StatusChip, FilterPill and PanelHeader to
   src/components/ui/index.jsx using the tokens, and refactor src/components/common/StatCard.jsx
   onto the new one. Every currency figure, document number, account code and date renders in
   IBM Plex Mono; everything else in Plus Jakarta Sans.

4. Screens, one commit each: DashboardPage, ClientsPage, InvoicesPage, PaymentsPage, BillsPage,
   ExpensesPage, ChartOfAccountsPage + JournalEntriesPage, FinancialReportsPage, BankingPage,
   PlacementsPage, TimesheetsPage, SettingsPage. Use the existing API calls and recharts — do not
   add dependencies or change any endpoint, and read the placement margin from placementMargin()
   in src/data/billingTypes.js rather than recomputing it.

Constraints: no new npm packages, no changes under backend/ or database/, and every screen must
render correctly in both themes and all five accent colours before you call a step done.
```

import { Navigate, Route, Routes } from 'react-router-dom'
import { useAuth } from './context/AuthContext'
import ProtectedRoute from './components/ProtectedRoute'
import MainLayout from './layouts/MainLayout'
import LoginPage from './pages/LoginPage'
import DashboardPage from './pages/DashboardPage'
import RegionsPage from './pages/RegionsPage'
import ClientsPage from './pages/ClientsPage'
import ClientDetailPage from './pages/ClientDetailPage'
import VendorsPage from './pages/VendorsPage'
import VendorDetailPage from './pages/VendorDetailPage'
import PlacementDetailPage from './pages/PlacementDetailPage'
import CandidatesPage from './pages/CandidatesPage'
import CandidateDetailPage from './pages/CandidateDetailPage'
import PlacementsPage from './pages/PlacementsPage'
import TimesheetsPage from './pages/TimesheetsPage'
import InvoicesPage from './pages/InvoicesPage'
import InvoicePrintPage from './pages/InvoicePrintPage'
import PaymentsPage from './pages/PaymentsPage'
import BillsPage from './pages/BillsPage'
import VendorPaymentsPage from './pages/VendorPaymentsPage'
import ApprovalsPage from './pages/ApprovalsPage'
import UsersPage from './pages/UsersPage'
import AuditLogsPage from './pages/AuditLogsPage'
import SettingsPage from './pages/SettingsPage'
import ExpensesPage from './pages/ExpensesPage'
import BankingPage from './pages/banking/BankingPage'
import FixedExpensesPage from './pages/expenses/FixedExpensesPage'
import ExpenseCategoriesPage from './pages/expenses/CategoriesPage'
import CategoryDetailPage from './pages/expenses/CategoryDetailPage'
import MonthlySummaryPage from './pages/expenses/MonthlySummaryPage'
import AccountingOverviewPage from './pages/accounting/AccountingOverviewPage'
import AccountRegisterPage from './pages/accounting/AccountRegisterPage'
import FinancialReportsPage from './pages/accounting/FinancialReportsPage'
import JournalEntriesPage from './pages/accounting/JournalEntriesPage'
import ChartOfAccountsPage from './pages/accounting/ChartOfAccountsPage'
import PeriodClosePage from './pages/accounting/PeriodClosePage'
import { PAGE_ACCESS } from './utils/acl'

function PublicRoute({ children }) {
  const { isLoggedIn, loading } = useAuth()
  if (loading) return null
  if (isLoggedIn) return <Navigate to="/dashboard" replace />
  return children
}

function P({ page, roles }) {
  return (
    <ProtectedRoute allowedRoles={roles}>
      <MainLayout>{page}</MainLayout>
    </ProtectedRoute>
  )
}

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<PublicRoute><LoginPage /></PublicRoute>} />
      <Route path="/dashboard" element={<P page={<DashboardPage />} />} />
      <Route path="/regions" element={<P page={<RegionsPage />} roles={PAGE_ACCESS.regions} />} />
      <Route path="/clients" element={<P page={<ClientsPage />} roles={PAGE_ACCESS.clients} />} />
      <Route path="/clients/:id" element={<P page={<ClientDetailPage />} roles={PAGE_ACCESS.clients} />} />
      <Route path="/vendors" element={<P page={<VendorsPage />} roles={PAGE_ACCESS.vendors} />} />
      <Route path="/vendors/:id" element={<P page={<VendorDetailPage />} roles={PAGE_ACCESS.vendors} />} />
      <Route path="/candidates" element={<P page={<CandidatesPage />} roles={PAGE_ACCESS.candidates} />} />
      <Route path="/candidates/:id" element={<P page={<CandidateDetailPage />} roles={PAGE_ACCESS.candidates} />} />
      <Route path="/placements" element={<P page={<PlacementsPage />} roles={PAGE_ACCESS.placements} />} />
      <Route path="/placements/:id" element={<P page={<PlacementDetailPage />} roles={PAGE_ACCESS.placements} />} />
      <Route path="/timesheets" element={<P page={<TimesheetsPage />} roles={PAGE_ACCESS.placements} />} />
      <Route path="/invoices" element={<P page={<InvoicesPage />} roles={PAGE_ACCESS.invoices} />} />
      <Route path="/invoices/:id/print" element={<ProtectedRoute allowedRoles={PAGE_ACCESS.invoices}><InvoicePrintPage /></ProtectedRoute>} />
      <Route path="/payments" element={<P page={<PaymentsPage />} roles={PAGE_ACCESS.payments} />} />
      <Route path="/bills" element={<P page={<BillsPage />} roles={PAGE_ACCESS.bills} />} />
      <Route path="/vendor-payments" element={<P page={<VendorPaymentsPage />} roles={PAGE_ACCESS.vendorPayments} />} />
      <Route path="/banking" element={<P page={<BankingPage />} roles={PAGE_ACCESS.banking} />} />
      <Route path="/expenses" element={<P page={<ExpensesPage />} roles={PAGE_ACCESS.expenses} />} />
      <Route path="/expenses/fixed" element={<P page={<FixedExpensesPage />} roles={PAGE_ACCESS.expenses} />} />
      <Route path="/expenses/categories" element={<P page={<ExpenseCategoriesPage />} roles={PAGE_ACCESS.expenses} />} />
      <Route path="/expenses/categories/:id" element={<P page={<CategoryDetailPage />} roles={PAGE_ACCESS.expenses} />} />
      <Route path="/expenses/summary" element={<P page={<MonthlySummaryPage />} roles={PAGE_ACCESS.expenses} />} />
      <Route path="/approvals" element={<P page={<ApprovalsPage />} roles={PAGE_ACCESS.approvals} />} />
      <Route path="/accounting" element={<P page={<AccountingOverviewPage />} roles={PAGE_ACCESS.accounting} />} />
      <Route path="/accounting/reports" element={<P page={<FinancialReportsPage />} roles={PAGE_ACCESS.accounting} />} />
      <Route path="/accounting/journal-entries" element={<P page={<JournalEntriesPage />} roles={PAGE_ACCESS.accounting} />} />
      <Route path="/accounting/chart-of-accounts" element={<P page={<ChartOfAccountsPage />} roles={PAGE_ACCESS.accounting} />} />
      <Route path="/accounting/accounts/:id" element={<P page={<AccountRegisterPage />} roles={PAGE_ACCESS.accounting} />} />
      <Route path="/accounting/period-close" element={<P page={<PeriodClosePage />} roles={PAGE_ACCESS.accounting} />} />
      <Route path="/users" element={<P page={<UsersPage />} roles={PAGE_ACCESS.users} />} />
      <Route path="/audit-logs" element={<P page={<AuditLogsPage />} roles={PAGE_ACCESS.auditLogs} />} />
      <Route path="/settings" element={<P page={<SettingsPage />} roles={PAGE_ACCESS.settings} />} />
      <Route path="/settings/:tab" element={<P page={<SettingsPage />} roles={PAGE_ACCESS.settings} />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  )
}

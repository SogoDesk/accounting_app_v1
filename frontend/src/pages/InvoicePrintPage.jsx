import { useEffect, useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import api, { resolveAssetUrl } from '../services/api'
import { fmt, fmtDateDisplay, customerLabel } from '../components/ui/index.jsx'

const normalizeNumber = (value) => {
  const num = Number(value || 0)
  return Number.isNaN(num) ? 0 : num
}

const formatQty = (value) => {
  const num = normalizeNumber(value)
  return Number.isInteger(num) ? String(num) : num.toFixed(2)
}

const formatMoneyBare = (value) =>
  normalizeNumber(value).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })

const splitAddress = (value) =>
  String(value || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)

const buildBankLines = (invoice) => [
  ['Bank Name', invoice.bank_name],
  ['Account Name', invoice.bank_account_name],
  ['Account Number', invoice.bank_account_number],
  ['Direct deposit / ACH Routing Number', invoice.bank_routing_number],
  ['Swift / IFSC', invoice.bank_swift_ifsc],
  ['Branch Details', invoice.bank_branch_details],
].filter(([, value]) => value)

export default function InvoicePrintPage() {
  const { id } = useParams()
  const navigate = useNavigate()
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    api.get(`/invoices/${id}/print`)
      .then((response) => setData(response.data?.data || null))
      .catch(() => navigate('/invoices'))
      .finally(() => setLoading(false))
  }, [id, navigate])

  if (loading) {
    return (
      <div className="invoice-print-loader">
        Loading invoice...
      </div>
    )
  }

  if (!data) return null

  const invoice = data
  const lineItems = Array.isArray(invoice.line_items) && invoice.line_items.length > 0
    ? invoice.line_items
    : [{
        id: 'fallback',
        description: invoice.job_title || invoice.notes || invoice.candidate_name || 'Professional Services',
        quantity: invoice.hours_or_units || 1,
        rate: invoice.bill_rate || 0,
        amount: invoice.subtotal || 0,
        candidate_name: invoice.candidate_name,
        activity_label: invoice.candidate_name || 'Consulting Services',
        job_title: invoice.job_title,
        line_date: invoice.invoice_date,
      }]

  const taxLines = Array.isArray(invoice.tax_lines) ? invoice.tax_lines : []
  const bankLines = buildBankLines(invoice)
  const companyAddressLines = splitAddress(invoice.company_address)
  const clientAddressLines = splitAddress(invoice.billing_address)
  const customerMessage = invoice.customer_message || 'Thank you for your Business.'
  const paymentIntro = bankLines.length > 0 ? 'Please find ACH Details for Payments' : ''
  const logoSrc = resolveAssetUrl(invoice.logo_url)

  return (
    <div className="invoice-print-page">
      <div className="invoice-print-toolbar no-print">
        <button className="secondary-btn" onClick={() => navigate(-1)}>Back</button>
        <button className="primary-btn" onClick={() => window.print()}>Print / PDF</button>
      </div>

      <article className="print-invoice qb-invoice">
        <header className="qb-invoice-top">
          <div className="qb-company-block">
            {logoSrc ? <img src={logoSrc} alt="Company logo" className="qb-logo" /> : null}
            <strong>{invoice.company_name || 'Company'}</strong>
            {companyAddressLines.map((line) => <span key={line}>{line}</span>)}
            {invoice.company_id_value ? (
              <span>{invoice.company_id_label || 'ID'}: {invoice.company_id_value}</span>
            ) : null}
          </div>
        </header>

        <section className="qb-title-row">
          <h1>INVOICE</h1>
        </section>

        <section className="qb-meta-row">
          <div className="qb-bill-to">
            <div className="qb-label">BILL TO</div>
            <strong>{invoice.client_name || customerLabel()}</strong>
            {invoice.primary_contact_name ? <span>{invoice.primary_contact_name}</span> : null}
            {clientAddressLines.map((line) => <span key={line}>{line}</span>)}
            {invoice.tax_identifier ? <span>Tax ID: {invoice.tax_identifier}</span> : null}
          </div>

          <dl className="qb-invoice-facts">
            <div>
              <dt>INVOICE #</dt>
              <dd>{invoice.invoice_number}</dd>
            </div>
            <div>
              <dt>DATE</dt>
              <dd>{fmtDateDisplay(invoice.invoice_date)}</dd>
            </div>
            <div>
              <dt>DUE DATE</dt>
              <dd>{fmtDateDisplay(invoice.due_date)}</dd>
            </div>
            <div>
              <dt>TERMS</dt>
              <dd>{invoice.invoice_terms_label || 'Net 30'}</dd>
            </div>
          </dl>
        </section>

        <table className="qb-items-table">
          <thead>
            <tr>
              <th>DATE</th>
              <th>ACTIVITY</th>
              <th>DESCRIPTION</th>
              <th className="text-right">QTY</th>
              <th className="text-right">RATE</th>
              <th className="text-right">AMOUNT</th>
            </tr>
          </thead>
          <tbody>
            {lineItems.map((item, index) => (
              <tr key={item.id || index}>
                <td>{fmtDateDisplay(item.line_date || invoice.invoice_date)}</td>
                <td>{item.activity_label || item.candidate_name || 'Consulting Services'}</td>
                <td>{item.description || item.job_title || 'Professional Services'}</td>
                <td className="text-right qb-mono">{formatQty(item.quantity)}</td>
                <td className="text-right qb-mono">{formatMoneyBare(item.rate)}</td>
                <td className="text-right qb-mono">{formatMoneyBare(item.amount)}</td>
              </tr>
            ))}
          </tbody>
        </table>

        <section className="qb-bottom-row">
          <div className="qb-payment-note">
            {customerMessage ? <p>{customerMessage}</p> : null}
            {paymentIntro ? <p>{paymentIntro}</p> : null}
            {bankLines.map(([label, value]) => (
              <p key={label}>
                <strong>{label}:</strong> {value}
              </p>
            ))}
            {invoice.notes ? <p className="qb-notes">{invoice.notes}</p> : null}
          </div>

          <div className="qb-totals">
            <div>
              <span>Subtotal</span>
              <strong>{fmt(invoice.subtotal, invoice.currency)}</strong>
            </div>
            {taxLines.map((line) => (
              <div key={line.id || line.tax_name}>
                <span>{line.tax_name} ({normalizeNumber(line.tax_percent).toFixed(2)}%)</span>
                <strong>{fmt(line.tax_amount, invoice.currency)}</strong>
              </div>
            ))}
            {taxLines.length === 0 && normalizeNumber(invoice.tax_amount) > 0 ? (
              <div>
                <span>Tax</span>
                <strong>{fmt(invoice.tax_amount, invoice.currency)}</strong>
              </div>
            ) : null}
            <div>
              <span>Total</span>
              <strong>{fmt(invoice.total_amount, invoice.currency)}</strong>
            </div>
            {normalizeNumber(invoice.payment_received_amount) > 0 ? (
              <div>
                <span>Paid</span>
                <strong>{fmt(invoice.payment_received_amount, invoice.currency)}</strong>
              </div>
            ) : null}
            <div className="qb-balance-due">
              <span>BALANCE DUE</span>
              <strong>{fmt(invoice.balance_outstanding, invoice.currency)}</strong>
            </div>
          </div>
        </section>
      </article>
    </div>
  )
}

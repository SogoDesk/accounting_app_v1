import { useEffect, useMemo, useState } from 'react'
import api from '../../services/api'
import { useToast } from '../../context/ToastContext'
import { Drawer, Input, SearchableSelect } from '../ui'

// Reusable "type-to-create" side drawer for simple name + ledger-account
// records (expense categories, payment methods). Mirrors the invoice form's
// quick-create pattern so the Add Expense / Fixed Expense forms behave the same.
export default function QuickAddDrawer({
  open,
  title,
  endpoint,
  initialName = '',
  accounts = [],
  accountLabel = 'Ledger account',
  accountHint,
  namePlaceholder = 'Name',
  saveLabel = 'Save',
  onClose,
  onCreated,
}) {
  const toast = useToast()
  const [name, setName] = useState(initialName)
  const [accountId, setAccountId] = useState('')
  const [saving, setSaving] = useState(false)

  // Reset the draft each time the drawer (re)opens with a fresh typed name.
  useEffect(() => {
    if (open) { setName(initialName || ''); setAccountId(''); setSaving(false) }
  }, [open, initialName])

  const accountOptions = useMemo(
    () => accounts.map((a) => ({ value: String(a.id), label: `${a.account_code} · ${a.account_name}` })),
    [accounts],
  )

  const save = async () => {
    if (!name.trim()) { toast.error('Name is required'); return }
    setSaving(true)
    try {
      const res = await api.post(endpoint, { name: name.trim(), gl_account_id: accountId || null })
      const created = res.data?.data
      if (!created) throw new Error('Create response missing data')
      toast.success(`"${created.name}" added`)
      onCreated?.(created)
      onClose?.()
    } catch (e) {
      toast.error(e.response?.data?.message || e.message || 'Failed to add')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Drawer
      open={open}
      onClose={onClose}
      title={title}
      width={460}
      footer={(
        <>
          <button className="btn btn-secondary" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" onClick={save} disabled={saving}>{saving ? 'Saving…' : saveLabel}</button>
        </>
      )}
    >
      <div className="form-grid">
        <Input label="Name" required value={name} onChange={(e) => setName(e.target.value)} placeholder={namePlaceholder} />
        <SearchableSelect
          label={accountLabel}
          value={accountId}
          options={accountOptions}
          placeholder="Map to a ledger account..."
          emptyMessage="No accounts found"
          hint={accountHint}
          onChange={(e) => setAccountId(e.target.value)}
        />
      </div>
    </Drawer>
  )
}

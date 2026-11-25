-- Up Migration
-- =============================================================================
-- Default email templates and invoice reminder settings for every tenant.
--
-- These rows used to be inserted lazily by modules/email/ensureEmailSchema.js
-- on the first email request. That module is gone (workflow step 0.2): new
-- tenants get them from provisionTenant (seedEmailDefaults), and this
-- migration fills them in for tenants that already exist. Existing rows are
-- never changed. Template text is a snapshot of modules/email/defaultTemplates.js
-- at the time of writing.
-- =============================================================================

DO $$
DECLARE t record;
BEGIN
  FOR t IN SELECT id FROM public.tenants ORDER BY id LOOP
    -- Row-level security is forced on these tables; act as that tenant.
    PERFORM set_config('app.tenant_id', t.id::text, true);

    INSERT INTO public.email_templates
      (tenant_id, template_key, name, description, subject, body)
    SELECT t.id, v.template_key, v.name, v.description, v.subject, v.body
      FROM (VALUES
      ($tpl$INVOICE$tpl$, $tpl$Invoice email$tpl$, $tpl$Sent to the client when you email an invoice.$tpl$, $tpl$Invoice {{invoice_number}} from {{company_name}}$tpl$, $tpl$<table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f6f8;padding:24px 0">
<tr><td align="center">
<table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;background:#ffffff;border-radius:12px;overflow:hidden;font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif">

  <tr><td style="padding:0;line-height:0">
    <img src="{{header_banner_url}}" alt="" style="width:100%;max-width:600px;display:block;border:0">
  </td></tr>

  <tr><td style="padding:28px 28px 8px">
    <p style="margin:0 0 14px;font-size:15px;color:#1a1a1a">Hi {{contact_name}},</p>
    <p style="margin:0 0 20px;font-size:15px;line-height:1.6;color:#3b4350">
      Please find attached invoice <strong>{{invoice_number}}</strong> for
      <strong>{{client_name}}</strong>. A summary is below.
    </p>
  </td></tr>

  <tr><td style="padding:0 28px">
    <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e6eaee;border-radius:10px">
      <tr>
        <td style="padding:12px 16px;font-size:13px;color:#6b7684;border-bottom:1px solid #eef1f4">Invoice number</td>
        <td align="right" style="padding:12px 16px;font-size:13px;font-weight:600;color:#1a1a1a;border-bottom:1px solid #eef1f4">{{invoice_number}}</td>
      </tr>
      <tr>
        <td style="padding:12px 16px;font-size:13px;color:#6b7684;border-bottom:1px solid #eef1f4">Invoice date</td>
        <td align="right" style="padding:12px 16px;font-size:13px;font-weight:600;color:#1a1a1a;border-bottom:1px solid #eef1f4">{{invoice_date}}</td>
      </tr>
      <tr>
        <td style="padding:12px 16px;font-size:13px;color:#6b7684;border-bottom:1px solid #eef1f4">Due date</td>
        <td align="right" style="padding:12px 16px;font-size:13px;font-weight:600;color:#1a1a1a;border-bottom:1px solid #eef1f4">{{due_date}}</td>
      </tr>
      <tr>
        <td style="padding:12px 16px;font-size:13px;color:#6b7684;border-bottom:1px solid #eef1f4">Payment terms</td>
        <td align="right" style="padding:12px 16px;font-size:13px;font-weight:600;color:#1a1a1a;border-bottom:1px solid #eef1f4">{{payment_terms}}</td>
      </tr>
      <tr>
        <td style="padding:14px 16px;font-size:14px;font-weight:700;color:#1a1a1a;background:#f7fafa;border-radius:0 0 0 10px">Amount due</td>
        <td align="right" style="padding:14px 16px;font-size:18px;font-weight:700;color:#12a594;background:#f7fafa;border-radius:0 0 10px 0">{{balance_due}}</td>
      </tr>
    </table>
  </td></tr>

  <tr><td style="padding:22px 28px 4px">
    <p style="margin:0;font-size:14px;line-height:1.6;color:#3b4350">
      Please quote the invoice number with your payment. If you have any questions
      about this invoice, just reply to this email.
    </p>
  </td></tr>

  <tr><td style="padding:20px 28px 28px">
    <p style="margin:0;font-size:14px;color:#3b4350">Kind regards,<br><strong>{{company_name}}</strong></p>
  </td></tr>

  <tr><td style="padding:16px 28px;background:#f7fafa;border-top:1px solid #eef1f4">
    <p style="margin:0;font-size:11.5px;line-height:1.5;color:#8a939f">
      <strong>{{company_name}}</strong><br>{{company_address}}<br>{{footer_note}}
    </p>
  </td></tr>

</table>
</td></tr>
</table>$tpl$),
      ($tpl$REMINDER$tpl$, $tpl$Payment reminder$tpl$, $tpl$Sent before and after the due date while the invoice is unpaid.$tpl$, $tpl$Reminder: invoice {{invoice_number}} is due {{due_date}}$tpl$, $tpl$<table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f6f8;padding:24px 0">
<tr><td align="center">
<table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;background:#ffffff;border-radius:12px;overflow:hidden;font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif">

  <tr><td style="padding:0;line-height:0">
    <img src="{{header_banner_url}}" alt="" style="width:100%;max-width:600px;display:block;border:0">
  </td></tr>

  <tr><td style="padding:28px 28px 8px">
    <p style="margin:0 0 14px;font-size:15px;color:#1a1a1a">Hi {{contact_name}},</p>
    <p style="margin:0 0 20px;font-size:15px;line-height:1.6;color:#3b4350">
      A reminder that invoice <strong>{{invoice_number}}</strong> for <strong>{{balance_due}}</strong>
      is due on <strong>{{due_date}}</strong>.
    </p>
  </td></tr>

  <tr><td style="padding:0 28px">
    <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e6eaee;border-radius:10px">
      <tr>
        <td style="padding:12px 16px;font-size:13px;color:#6b7684;border-bottom:1px solid #eef1f4">Invoice number</td>
        <td align="right" style="padding:12px 16px;font-size:13px;font-weight:600;color:#1a1a1a;border-bottom:1px solid #eef1f4">{{invoice_number}}</td>
      </tr>
      <tr>
        <td style="padding:12px 16px;font-size:13px;color:#6b7684;border-bottom:1px solid #eef1f4">Due date</td>
        <td align="right" style="padding:12px 16px;font-size:13px;font-weight:600;color:#1a1a1a;border-bottom:1px solid #eef1f4">{{due_date}}</td>
      </tr>
      <tr>
        <td style="padding:14px 16px;font-size:14px;font-weight:700;color:#1a1a1a;background:#f7fafa;border-radius:0 0 0 10px">Amount outstanding</td>
        <td align="right" style="padding:14px 16px;font-size:18px;font-weight:700;color:#12a594;background:#f7fafa;border-radius:0 0 10px 0">{{balance_due}}</td>
      </tr>
    </table>
  </td></tr>

  <tr><td style="padding:22px 28px 4px">
    <p style="margin:0;font-size:14px;line-height:1.6;color:#3b4350">
      If payment is already on its way, please ignore this message. Otherwise just
      reply here and we'll help.
    </p>
  </td></tr>

  <tr><td style="padding:20px 28px 28px">
    <p style="margin:0;font-size:14px;color:#3b4350">Kind regards,<br><strong>{{company_name}}</strong></p>
  </td></tr>

  <tr><td style="padding:16px 28px;background:#f7fafa;border-top:1px solid #eef1f4">
    <p style="margin:0;font-size:11.5px;line-height:1.5;color:#8a939f">
      <strong>{{company_name}}</strong><br>{{company_address}}<br>{{footer_note}}
    </p>
  </td></tr>

</table>
</td></tr>
</table>$tpl$)
      ) AS v(template_key, name, description, subject, body)
    ON CONFLICT (tenant_id, template_key) DO NOTHING;

    INSERT INTO public.invoice_reminder_settings (tenant_id)
    VALUES (t.id)
    ON CONFLICT (tenant_id) DO NOTHING;
  END LOOP;

  PERFORM set_config('app.tenant_id', '', true);
END $$;

-- Down Migration
-- Seeded rows are left in place; tenants may have edited them.

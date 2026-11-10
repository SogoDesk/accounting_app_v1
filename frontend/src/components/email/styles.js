export const sectionLabel = {
  fontSize: 11, fontWeight: 700, letterSpacing: '.08em',
  textTransform: 'uppercase', color: 'var(--text3)', marginBottom: 10,
}

export const card = {
  background: 'var(--bg-panel)', border: '1px solid var(--border)',
  borderRadius: 14, padding: 26,
}

export const PREVIEW_CSS = `html,body{margin:0;padding:0;overflow-x:hidden}`
  + `body{font:14px/1.65 -apple-system,'Segoe UI',Roboto,sans-serif;color:#1a1a1a}`
  + `img{max-width:100%;height:auto}table{max-width:100%!important}`

export const previewDoc = (html) =>
  `<!doctype html><meta charset="utf-8"><base href="${window.location.origin}/">`
  + `<style>${PREVIEW_CSS}</style><body>${html || '<div style="padding:24px;color:#9aa4b0">Nothing to preview yet</div>'}</body>`

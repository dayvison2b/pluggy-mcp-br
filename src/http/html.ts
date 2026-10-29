export function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

export function page(title: string, body: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <style>
    body { font-family: Georgia, serif; margin: 2.5rem auto; max-width: 40rem; line-height: 1.5; color: #1c1917; background: #faf7f2; padding: 0 1rem; }
    h1 { font-size: 1.7rem; }
    code { font-family: ui-monospace, monospace; font-size: 0.92em; }
    form { display: grid; gap: 0.75rem; margin-top: 1.5rem; }
    input[type=password] { font: inherit; padding: 0.55rem 0.7rem; }
    button { font: inherit; padding: 0.55rem 0.8rem; background: #1c1917; color: #faf7f2; border: 0; }
    .error { color: #9f1239; }
  </style>
</head>
<body>
${body}
</body>
</html>`;
}

export function loginHtml(fields: Record<string, string>, error?: string): string {
  const hidden = Object.entries(fields)
    .map(([name, value]) => `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}">`)
    .join('');
  const alert = error ? `<p class="error">${escapeHtml(error)}</p>` : '';
  return page(
    'Sign in — pluggy-mcp-br',
    `<h1>Sign in as the owner</h1>
<p>Only the owner of this connector signs in. The password is the <code>OWNER_PASSWORD</code> variable, which lives on the server and is not committed to the repository.</p>
<p>After signing in, the Grok Bot can only read accounts, balances, transactions and bills. Nothing is paid from here.</p>
${alert}
<form method="post" action="/authorize">
  ${hidden}
  <label>Owner password <input type="password" name="password" autocomplete="current-password" required></label>
  <button type="submit">Authorize read</button>
</form>`,
  );
}

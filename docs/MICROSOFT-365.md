# Connecting a Microsoft 365 (Outlook) inbox

Microsoft is retiring password logins for sending mail from Microsoft 365, so this app connects to
Microsoft 365 through an **app registration**, the Microsoft version of a Google Cloud project. The app
then sends and reads mail through the Microsoft Graph API over HTTPS. No mailbox password is stored,
and it works even if the server's mail ports are blocked.

You do this once per Microsoft 365 organization (amigosrecruiting.net), not once per inbox.
Every inbox on that domain can use the same three values.

## 1. Make sure you have full admin access

You need to sign in to <https://entra.microsoft.com> as a **Global Administrator** (or Application
Administrator) of the amigosrecruiting.net Microsoft 365 account.

If the account was bought through **GoDaddy**, GoDaddy often keeps that role for itself. If
*Identity → Applications → App registrations* is missing or **New registration** is greyed out, call
GoDaddy and ask for Global Admin access to your Microsoft 365 tenant. If they won't grant it, ask
about moving the account off GoDaddy's management (GoDaddy calls this "defederating").

## 2. Register the app

1. entra.microsoft.com → **Identity → Applications → App registrations → New registration**.
2. Name: `Amigos Outreach`. Supported account types: **Accounts in this organizational directory only**.
   Leave Redirect URI blank. Click **Register**.
3. On the app's **Overview** page, copy the **Application (client) ID** and the **Directory (tenant) ID**.

## 3. Give it permission to send and read mail

1. **API permissions → Add a permission → Microsoft Graph → Application permissions**.
2. Tick **Mail.Send** and **Mail.Read**, then **Add permissions**.
3. Click **Grant admin consent for …** and confirm. Both rows should show a green check.

## 4. Create a client secret

1. **Certificates & secrets → Client secrets → New client secret**.
2. Description `Amigos Outreach`, expiry **24 months**. Click **Add**.
3. Copy the **Value** right away (not the Secret ID). Microsoft only shows it once.
4. Put the expiry date in your calendar. Before it expires, create a new secret and paste it into the inbox.

## 5. Add the inbox in the dashboard

**Sending inboxes → Add an inbox**:

- Sender name and email, for example `Carlos Rivera` / `carlos@amigosrecruiting.net`. The mailbox must exist
  in Microsoft 365 and have a license.
- How it connects: **Microsoft 365 / Outlook (app connection)**
- Paste the tenant ID, client ID and client secret.
- Click **Add inbox**, open it, and click **Test Microsoft 365 connection**.

The secret is encrypted in the app's database with `APP_SECRET`. Don't paste it into chat or email.

## 6. Turn on DKIM for amigosrecruiting.net

As of October 2026, amigosrecruiting.net has SPF and DMARC set up but **no DKIM**. Gmail and Yahoo expect it from
anyone sending in volume.

1. <https://security.microsoft.com> → **Email & collaboration → Policies & rules → Threat policies →
   Email authentication settings → DKIM**.
2. Select **amigosrecruiting.net**. Microsoft shows two CNAME records (`selector1._domainkey` and `selector2._domainkey`).
3. Add both CNAMEs in GoDaddy DNS, wait about 15 minutes, then switch **Sign messages for this domain with DKIM signatures** on.
4. Check it on this app's **Deliverability** page.

## Optional: limit the app to the outreach mailbox

`Mail.Send` and `Mail.Read` as application permissions cover every mailbox in the organization. To limit the
app to the outreach inbox(es), create a mail-enabled security group containing them and run this in Exchange Online PowerShell:

```powershell
New-ApplicationAccessPolicy -AppId <client-id> -PolicyScopeGroupId outreach-inboxes@amigosrecruiting.net `
  -AccessRight RestrictAccess -Description "Amigos Outreach can only use the outreach inboxes"
```

## Sending limits

New Microsoft 365 accounts are watched closely for bulk sending. A mailbox that suddenly sends hundreds of cold
emails can be blocked from sending. Keep each inbox on its warm-up ramp: 10 a day in week one, plus 10 a week,
which this app does automatically. To cover the list faster, add more inboxes rather than raising the limits.
If an inbox gets blocked, the app pauses it and shows the error on the dashboard.

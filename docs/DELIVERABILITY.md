# Deliverability: fixing Gmail and keeping the new domain clean

## What probably happened to amigosrecruiting.com

A DNS check of amigosrecruiting.com (run from the **Deliverability** page) shows:

| Record | Value |
|---|---|
| MX | Microsoft 365 (`amigosrecruiting-com.mail.protection.outlook.com`) |
| SPF | `v=spf1 include:spf.protection.outlook.com -all` |
| DKIM | Microsoft 365 selectors (`selector1`, `selector2`) |
| DMARC | `v=DMARC1; p=quarantine; …` |

That setup is correct for normal Microsoft 365 email. But it says **only Microsoft's servers may send as
@amigosrecruiting.com** (`-all`), and anything that fails should be **quarantined** (`p=quarantine`).

If Flowdesk sent the campaigns through its own mail servers, rather than by logging into your Microsoft 365
mailbox, those emails failed SPF and weren't signed with your DKIM key. Gmail then followed your DMARC policy
and sent them to spam. On top of that, sending one identical email to a large list builds a spam reputation in Gmail
for the domain itself.

**Worth checking:** in Flowdesk, see how the sender was connected. If it was "custom SMTP via Flowdesk" or a
Flowdesk sending domain rather than a Microsoft 365 login, that's very likely the main cause. Either way, the fix is the same.

## The plan

### 1. Protect the main domain
- Stop all bulk/cold email from amigosrecruiting.com. Use it only for normal one-to-one email with clients and candidates.
- Leave SPF, DKIM, and DMARC as they are. They're correct for Microsoft 365.
- Add amigosrecruiting.com to [Google Postmaster Tools](https://postmaster.google.com) to watch its reputation recover.
  With clean, low-volume sending this usually takes 1–3 months.

### 2. Set up outreach domains
- Buy 1–3 domains that are clearly yours: `amigoshiring.com`, `getamigosrecruiting.com`, `amigosrecruiting.co`.
- Redirect each one's website (301) to amigosrecruiting.com.
- Create **Google Workspace** inboxes on them (2–3 per domain), each under a real person's name, with a profile photo
  and the same signature. Google Workspace is recommended over Microsoft 365 for outreach inboxes, partly because
  Microsoft is phasing out the SMTP password login that sending tools rely on.
- DNS for each domain (the Deliverability page checks these):
  - SPF: `v=spf1 include:_spf.google.com ~all`
  - DKIM: Google Admin → Apps → Google Workspace → Gmail → Authenticate email → generate and publish, then *Start authentication*
  - DMARC: `_dmarc` TXT `v=DMARC1; p=none; rua=mailto:dmarc@yourdomain.com` (move to `p=quarantine` after a couple of months)
  - Optional: a subdomain like `go.amigoshiring.com` pointing to this app, so unsubscribe links and the logo use your own domain.

### 3. Warm up before sending
- Run every new inbox through a warm-up service (Instantly, Smartlead, Lemwarm, Mailreach, etc.) for **2–3 weeks**
  before the first campaign, and keep warm-up running afterward.
- In this app, each inbox's **warm-up start date** ramps its cold volume automatically: 10/day in week one,
  +10 each week, up to the inbox's cap (30–40 recommended).

### 4. Send like a person, not a blast
This system already does the following:
- A different campaign every month, rotating subject lines, and small per-recipient wording differences.
- Plain, reply-style follow-ups in the same thread (these get the most replies and look least like marketing).
- Two send days a week, one email at a time, at random intervals, with at most 2 per company domain per day.
- One-click unsubscribe headers (required by Gmail/Yahoo for bulk senders), a visible unsubscribe link, and a postal address.
- Replies stop the sequence immediately. "Remove me" replies are honored automatically.
- Automatic pause if the bounce rate goes over 4%.

What you need to do:
- **Clean the list** before importing. The importer removes dead domains and agent/attorney addresses. For large lists,
  also run them through a verifier (ZeroBounce, NeverBounce, MillionVerifier). Aim for under 2% bounces.
- **Watch Google Postmaster Tools** for each outreach domain. Keep the spam rate under 0.1% and never let it reach 0.3%.
- **Reply quickly** to anyone who answers. Replies are the strongest positive signal a sender can get.

### 5. If an outreach domain gets burned
Pause its inboxes in the dashboard, let warm-up keep running, and move volume to your other domain.
That's why there are at least two: your main domain is never at risk.

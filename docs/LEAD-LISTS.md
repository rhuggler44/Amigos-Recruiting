# Lead lists: employers who filed for H-2A / H-2B workers

## Where the data comes from

The U.S. Department of Labor's Office of Foreign Labor Certification publishes every H-2A and H-2B labor
certification case as public **disclosure data**:

- **OFLC Performance Data:** https://www.dol.gov/agencies/eta/foreign-labor/performance
  Look for *H-2A* and *H-2B* "Disclosure Data" for the current fiscal year (updated quarterly, Excel files).
- **SeasonalJobs.dol.gov:** current job orders, useful for spotting employers who are hiring right now.

Each row is one case: employer name and address, point-of-contact name/email/phone, job title,
occupation (SOC), industry (NAICS), number of workers requested and certified, begin/end dates, case status,
and the employer's attorney or agent.

## Getting it into the system

1. Download the H-2B (and/or H-2A) disclosure file.
2. Open it in Excel or Google Sheets and **Save as / Download as CSV**.
3. Optional but recommended: filter to the cases that matter, for example a recent fiscal year, certified or partially
   certified cases, and the states or industries you want to focus on.
4. In the dashboard, go to **Contacts → Import a list** and upload the CSV.

The importer automatically:
- maps the DOL column names (`EMPLOYER_NAME`, `EMPLOYER_POC_EMAIL`, `EMPLOYER_POC_FIRST_NAME`, `NAICS_CODE`, `SOC_TITLE`,
  `TOTAL_WORKERS_NEEDED`, `BEGIN_DATE`, `CASE_NUMBER`…) and common CRM export columns (`Email`, `First Name`, `Company`…)
- merges repeat cases from the same employer (adding up the workers requested)
- detects the visa program from the case number (H-300 = H-2A, H-400 = H-2B)
- sorts each employer into an industry for industry-specific copy
- tidies company names for natural-sounding emails ("BLUE RIDGE LAWN & GARDEN INC" becomes "Blue Ridge Lawn & Garden")
- skips rows where the contact email is the attorney/agent's, and any domain that shows up more than 5 times
  (usually a visa agency filing for many clients; those people don't make hiring decisions)
- drops addresses whose domain can't receive mail
- skips anyone on the do-not-contact list, and never reactivates someone who unsubscribed or bounced

See `samples/dol-h2b-sample.csv` for the expected shape (fake data).

## Good segments to try

| Audience | Why |
|---|---|
| H-2B employers who were only *partially* certified, or filed late in the window | Most likely to come up short on visa numbers |
| Landscaping + construction in TX, FL, the Southeast | Large H-2B users, close to where many candidates live |
| Hospitality in FL / resort areas, in the fall and winter months | Winter season staffing |
| H-2A farms with big headcounts | High volume per placement; H-2A has no cap, so lead with speed and cost instead of the lottery |

Use the **Audience** filters on each campaign (industry, visa program, state, minimum workers) to target these.

## A note on wording

The built-in copy describes candidates as workers who are "already in the U.S. and authorized to work". It keeps the
focus on where workers live and on skipping the visa process, not on placing or excluding anyone by
national origin. Staffing agencies are covered by equal-employment law, so it's worth having an employment
attorney review your standard pitch and placement practices once.

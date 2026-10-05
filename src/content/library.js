// Built-in content calendar. Every month has its own angle tied to the visa calendar, so the list
// never gets the same email twice. Copy can be edited per campaign in the dashboard, or
// regenerated with Claude (see ai-writer.js).
//
// Body markup (see render/email.js):
//   blank line = new paragraph · "## " heading · "- " bullets · "1. " numbered steps
//   "> " highlighted callout · "[[button]]" CTA button · "---" divider · **bold** · [text](url)
// Merge fields: {{first_name|there}} {{company|your team}} {{state_name}} {{industry_label}} {{industry_roles}}
//   {{industry_pitch}} {{visa_type|H-2}} {{month}} {{next_month}} {{year}} {{next_year}} {{sender_first_name}}
// Spintax: {option one|option two} — each recipient gets a stable random pick.

export const INDUSTRY_COPY = {
  landscaping: {
    roles: 'landscape laborers, mow crews, install and hardscape helpers, and crew leads',
    pitch: 'Landscape companies use us to fill mow, install, and maintenance crews when visa workers arrive late, come in short, or never get approved. Most of our candidates have done this work before and are ready for long days outside.',
  },
  agriculture: {
    roles: 'harvest hands, packing-shed workers, greenhouse and nursery workers, and equipment operators',
    pitch: 'Farms use us when the crop is ready and the paperwork isn\'t. Our candidates already live in the U.S., so there are no consulate appointments or travel delays between "we need people" and "they\'re working."',
  },
  hospitality: {
    roles: 'housekeepers, laundry staff, line cooks, dishwashers, and grounds crew',
    pitch: 'Hotels, resorts, and restaurants use us to cover housekeeping, kitchen, and grounds roles when seasonal visa staff fall through, so occupancy doesn\'t have to drop because rooms can\'t get turned.',
  },
  construction: {
    roles: 'general laborers, concrete and masonry helpers, framing helpers, and cleanup crews',
    pitch: 'Contractors use us to add reliable laborers when a project ramps up and the visa route is too slow or too uncertain to plan around.',
  },
  manufacturing: {
    roles: 'production workers, packers, machine helpers, and forestry and reforestation crews',
    pitch: 'Plants and forestry outfits use us to keep lines and crews fully staffed through seasonal peaks without waiting on petitions or visa numbers.',
  },
  seafood: {
    roles: 'processing-line workers, packers, and sanitation crews',
    pitch: 'Processors use us to staff lines for the season when visa allocations come in short, with workers who are already in the U.S. and can travel to you.',
  },
  other: {
    roles: 'general laborers and seasonal crew members',
    pitch: 'Employers in all kinds of seasonal industries use us as a second route to labor: workers who are already in the U.S. and authorized to work, recruited and screened for your roles.',
  },
};

const HOW_IT_WORKS = `## How it works
1. **Tell us what you need:** roles, headcount, location, pay, and start date.
2. **We recruit and screen:** candidates who already live in the U.S. (from Texas and Florida to Puerto Rico) and are authorized to work, matched to your job requirements.
3. **They show up ready to work:** no petitions, no consulate interviews, no cap lottery.`;

const CALLOUT = `> **No visa paperwork. No lottery. No waiting on a consulate.** Just hard-working people who are already here and want the job.`;

// One entry per calendar month (1–12).
export const MONTH_THEMES = {
  1: {
    key: 'lottery-backup', title: 'H-2B lottery backup plan',
    angle: 'The H-2B cap lottery for April 1 start dates. Many applicants will not get numbers; offer a backup plan before they find out.',
    subjects: ['a backup plan for the H-2B lottery', 'if your H-2B numbers come up short', '{backup|plan B} crew for {{company|your team}}'],
    preheader: 'Workers already in the U.S. — no lottery required.',
    headline: 'If the lottery doesn\'t go your way, your season still can.',
    intro: 'Every January thousands of employers file for the same H-2B visas, and the cap only covers part of them. Whether or not {{company|your company}} gets selected, it\'s worth having a second way to staff up this spring.',
    seeing: ['The H-2B cap (33,000 per half-year) is routinely oversubscribed, so many approved employers still get no visa numbers.', 'Employers who wait on lottery results often lose weeks they can\'t get back once the season starts.', 'Teams that line up a backup source in January are the ones fully staffed in April.'],
    followup: 'Quick follow-up on my note about a backup plan for the H-2B lottery. If {{company|your company}} doesn\'t get all the visas you filed for, we can fill those spots with workers who are already in the U.S. and authorized to work.',
    breakup: 'I\'ll stop reaching out after this one. If the lottery results leave you short this spring, just reply "crew" and I\'ll call you the same day.',
  },
  2: {
    key: 'came-up-short', title: 'Came up short on visas',
    angle: 'Lottery and cap results are coming in. Speak to employers who did not get the numbers they needed for spring.',
    subjects: ['came up short on visas?', 'still need {{industry_short|workers}} for spring?', 'spring crew for {{company|your team}}'],
    preheader: 'The spring season doesn\'t have to wait on visa numbers.',
    headline: 'Came up short on visas? Your season doesn\'t have to.',
    intro: 'This is the time of year when a lot of employers find out they won\'t get every worker they planned on. If that\'s {{company|you}} this year, we can help fill the gap with people who are already here.',
    seeing: ['More employers are asking about domestic recruiting as a standing backup, not just an emergency fix.', 'Start dates are getting pushed back while companies wait on supplemental visa announcements.', 'Workers already in the U.S. can often start within a couple of weeks of a signed order.'],
    followup: 'Following up in case the visa results left {{company|your team}} short for spring. We recruit workers who already live in the U.S., so there\'s nothing to wait on. How many people are you missing?',
    breakup: 'Last note from me. If you end up short for spring, reply with a headcount and start date and I\'ll put a plan together for you.',
  },
  3: {
    key: 'spring-ramp', title: 'Spring is here — is your crew?',
    angle: 'Spring season ramp-up. Work is starting and many crews are not full yet.',
    subjects: ['is your spring crew full?', 'spring is here, are your workers?', '{{company|your team}} + spring staffing'],
    preheader: 'Fill open spots now, before the work backs up.',
    headline: 'Spring is here. Is your crew?',
    intro: 'The work is starting whether every position is filled or not. If {{company|your team}} is still missing people for the season, we can help you close the gap now instead of playing catch-up in May.',
    seeing: ['Visa workers are arriving late or in smaller groups than requested.', 'Turnover in the first few weeks is the most expensive part of the season.', 'Employers are using domestic recruits to fill the gap until (or instead of) visa arrivals.'],
    followup: 'Checking back on spring staffing. If {{company|your team}} is still short, tell me how many people and where. We\'ll show you who we have available.',
    breakup: 'I don\'t want to clutter your inbox, so this is my last email for now. When you need people this season, reply here or call {{phone}}.',
  },
  4: {
    key: 'start-now', title: 'Workers who can start this month',
    angle: 'Peak season is starting; emphasize speed and availability: candidates who can start quickly.',
    subjects: ['workers who can start this month', 'need people {sooner|faster} than visas allow?', 'quick question about {{month}} staffing'],
    preheader: 'Candidates already in the U.S., ready to start.',
    headline: 'Workers who can start this month, with no consulate wait.',
    intro: 'When the season is already underway, waiting on visa processing isn\'t a plan. We recruit people who already live in the U.S. and are authorized to work, so they can start when you need them.',
    seeing: ['Short-notice requests are up as visa workers arrive late or don\'t arrive at all.', 'Employers who bring people on early in the season keep them longer.', 'Crews that start full avoid overtime costs and turning down work.'],
    followup: 'Following up: are you still looking for people this month? We have candidates ready to go and can usually start the process the same week.',
    breakup: 'This is my last note. If you ever need workers on short notice, keep this email and reply when the time comes.',
  },
  5: {
    key: 'summer-surge', title: 'Summer gaps before they cost you',
    angle: 'Summer peak demand. Labor gaps mean turning down jobs or overtime costs.',
    subjects: ['covering summer gaps at {{company|your company}}', 'turning down work this summer?', 'summer crew backup'],
    preheader: 'An open spot costs more than the hire.',
    headline: 'Fill the summer gaps before they cost you jobs.',
    intro: 'Summer is when one open spot turns into overtime, missed jobs, and burned-out crews. If you\'re heading into the busiest stretch of the year short-handed, we can help.',
    seeing: ['The busiest months are also when workers are hardest to find locally.', 'Overtime and turned-down work usually cost more than filling the role.', 'More employers are keeping a domestic backup crew on call through the summer.'],
    followup: 'Quick follow-up on summer staffing. Are you fully covered for June and July, or could you use a few more people?',
    breakup: 'Last email from me for now. If summer gets busier than your crew can handle, just reply with "summer" and I\'ll be in touch.',
  },
  6: {
    key: 'midseason-turnover', title: 'Replace mid-season losses fast',
    angle: 'Mid-season turnover: workers leave, no-shows, injuries. Replacing visa workers mid-season is nearly impossible; domestic recruits can be fast.',
    subjects: ['lost a few people mid-season?', 'replacing workers mid-season', 'mid-season {help|backup} for {{company|your team}}'],
    preheader: 'Replace them in days, not months.',
    headline: 'Lost a few people mid-season? Replace them in days, not months.',
    intro: 'Once the season starts, you can\'t easily replace a visa worker who leaves. If {{company|your crew}} has lost people to turnover, injuries, or no-shows, we can backfill with workers who are already in the country.',
    seeing: ['Mid-season departures are the hardest gap to fill through the visa process.', 'Employers are asking for 2–5 person backfills more than full crews this time of year.', 'Fast replacements keep the rest of the crew from burning out.'],
    followup: 'Following up: has {{company|your team}} had any mid-season turnover? Even if it\'s just two or three spots, we can help fill them.',
    breakup: 'I\'ll leave it here. If someone walks off the job this season, reply to this email and we\'ll start recruiting a replacement right away.',
  },
  7: {
    key: 'second-half', title: 'Fall/winter season without the October cap',
    angle: 'Second-half H-2B filings for October 1 start dates (fall/winter seasons). Encourage building in a backup before the second-half cap.',
    subjects: ['planning for fall and winter staffing', 'the October 1 cap and your fall crew', 'backup plan for {{company|your}} fall season'],
    preheader: 'Don\'t bet the whole season on the second-half cap.',
    headline: 'Planning fall and winter? Don\'t bet the season on the second-half cap.',
    intro: 'Second-half H-2B filings are underway for October start dates, and that cap fills quickly too. If {{company|your company}} staffs for fall or winter, now is the time to set up a second source of workers.',
    seeing: ['Second-half visa numbers are as competitive as spring.', 'Fall and winter employers like resorts, processors, and holiday operations face the same shortage.', 'A domestic recruiting plan made in July means no scramble in October.'],
    followup: 'Following up on fall staffing. Want me to put together a backup plan alongside your visa filing? It just takes a quick call.',
    breakup: 'Last note from me. If the fall visa numbers don\'t come through, reply "fall" and we\'ll get started on your crew.',
  },
  8: {
    key: 'late-season', title: 'Late-season and harvest staffing',
    angle: 'Late summer / early harvest: workload stays high while some seasonal workers leave. Offer reinforcements.',
    subjects: ['late-season help for {{company|your team}}', 'finishing the season short-handed?', 'help for the back half of the season'],
    preheader: 'Finish the season strong.',
    headline: 'Finish the season with a full crew.',
    intro: 'The back half of the season is when crews get thin. Workers head home early, contracts end, and the work keeps coming. We can add people now so {{company|your team}} finishes strong.',
    seeing: ['Early departures leave crews short right when harvest and fall work peak.', 'Employers are adding short-term reinforcements instead of overworking the crew they have.', 'Workers already in the U.S. can relocate for the remainder of a season.'],
    followup: 'Checking in on staffing for the rest of the season. Do you need a few extra people for the late-season push?',
    breakup: 'I\'ll stop here. If you need reinforcements before the season wraps, reply anytime.',
  },
  9: {
    key: 'harvest', title: 'Harvest help from workers already here',
    angle: 'Harvest and fall peak. Emphasize workers already in the U.S. who can travel to the job.',
    subjects: ['harvest and fall help', 'fall workers for {{company|your operation}}', 'need people for {{month}}?'],
    preheader: 'Experienced workers, no visa wait.',
    headline: 'Harvest and fall help from workers already in the U.S.',
    intro: 'Fall work doesn\'t wait for paperwork. We connect employers like {{company|you}} with experienced workers who already live in the U.S. and are ready to travel for the season.',
    seeing: ['Fall is one of the tightest labor markets of the year for seasonal employers.', 'Many employers now combine visa workers with a domestic crew for flexibility.', 'Candidates with prior seasonal experience are in high demand, so early orders get the best matches.'],
    followup: 'Following up on fall staffing. If {{company|your team}} could use more hands, tell me how many and where. I\'ll show you who\'s available.',
    breakup: 'Last email for now. Save this one for the next time the work outpaces the crew.',
  },
  10: {
    key: 'next-season', title: 'Get ahead of next season',
    angle: 'Fall/winter work plus early planning for next year. Employers are deciding now whether to file for visas again; offer a plan that doesn\'t depend on the cap.',
    subjects: ['already thinking about {{next_year}}?', 'your {{next_year}} crew, without the lottery', 'quick idea for next season'],
    preheader: 'A labor plan that doesn\'t depend on the cap.',
    headline: 'Already planning {{next_year}}? Build in a plan that doesn\'t depend on the cap.',
    intro: 'Most seasonal employers are deciding right now how to staff next year. If {{company|your company}} relies on H-2 visas, we\'d like to be your backup, or your main source if you\'re tired of the lottery.',
    seeing: ['Employers who plan in the fall are first in line for experienced workers.', 'More companies are splitting their crew between visa workers and domestic recruits to reduce risk.', 'Winter employers (resorts, holiday operations, processors) are hiring now.'],
    followup: 'Following up on next season. Would a 10-minute call to map out a backup crew for {{next_year}} be useful?',
    breakup: 'I\'ll let this be my last note for now. When you\'re planning {{next_year}} staffing, reply here and we\'ll put numbers together.',
  },
  11: {
    key: 'lock-in', title: 'Lock in next year before the filing rush',
    angle: 'Pre-filing season for next year\'s spring H-2B. Encourage locking in a domestic recruiting plan before January.',
    subjects: ['before the January filing rush', '{{next_year}} staffing: a second option', 'lock in your spring crew early'],
    preheader: 'Plan your spring crew before January.',
    headline: 'Lock in your {{next_year}} crew before the filing rush.',
    intro: 'In a few weeks thousands of employers will file for spring H-2B visas, and many will come up short again. Setting up a domestic recruiting plan now means {{company|your company}} isn\'t waiting on a lottery to know whether you have a season.',
    seeing: ['Spring filing windows open right after the new year, and the cap fills on day one.', 'Employers who line up a backup before filing have more options if they\'re not selected.', 'Early orders give us more time to recruit the right people for your roles.'],
    followup: 'Following up before the holidays get busy. Want to plan a backup crew for spring {{next_year}} now, so you\'re covered either way?',
    breakup: 'Last note for this year. If you\'d like a backup plan for spring, reply "spring" and I\'ll reach out after the holidays.',
  },
  12: {
    key: 'year-end', title: 'Your next-year labor plan, with a backup',
    angle: 'Year-end planning; January 1 is the first H-2B filing day for April start dates. Position Amigos as the plan B that removes lottery risk.',
    subjects: ['your {{next_year}} labor plan', 'a backup for January filings', 'plan B for spring {{next_year}}'],
    preheader: 'Go into January with a backup already in place.',
    headline: 'Go into {{next_year}} with a backup plan already in place.',
    intro: 'January 1 is when the race for spring H-2B visas starts again. Whatever {{company|your company}} files for, we can have a domestic recruiting plan ready so the lottery doesn\'t decide your season.',
    seeing: ['January filings will far exceed the available spring visas again.', 'Lottery results won\'t come until weeks after filing, which is a long time to wait without a plan.', 'A backup plan costs nothing to set up and is there when you need it.'],
    followup: 'Following up before the new year. Should we have a backup crew plan ready for {{company|you}} in case the January lottery doesn\'t go your way?',
    breakup: 'This is my last email of the year. If you want a backup plan for spring, reply anytime. We\'ll be ready.',
  },
};

export function themeForMonth(month) {
  const m = Number(String(month).split('-')[1]);
  return MONTH_THEMES[m];
}

export function themeByKey(key) {
  return Object.values(MONTH_THEMES).find((t) => t.key === key);
}

/** Build the default 4-touch sequence for a month from its theme. */
export function buildSequence(theme) {
  const step1 = {
    step: 1, delay_days: 0, style: 'newsletter', thread_with_previous: 0,
    subjects: theme.subjects.join('\n'),
    preheader: theme.preheader,
    headline: theme.headline,
    body: [
      'Hi {{first_name|there}},',
      theme.intro,
      '## What we\'re seeing this {{month}}',
      theme.seeing.map((s) => `- ${s}`).join('\n'),
      HOW_IT_WORKS,
      CALLOUT,
      '[[button]]',
      'Or just reply with the roles, headcount, and start date you\'re working with, and I\'ll {get back to you|follow up} within one business day.',
    ].join('\n\n'),
    cta_text: 'Start hiring with Amigos',
    cta_url: '',
  };

  const step2 = {
    step: 2, delay_days: 7, style: 'plain', thread_with_previous: 1,
    subjects: '',
    preheader: '',
    headline: '',
    body: [
      '{Hi|Hey} {{first_name|there}},',
      theme.followup,
      'We regularly place {{industry_roles}}. {Want me to send over|Should I send} a few details on how it works?',
    ].join('\n\n'),
    cta_text: '', cta_url: '',
  };

  const step3 = {
    step: 3, delay_days: 7, style: 'newsletter', thread_with_previous: 0,
    subjects: ['how {{industry_short|seasonal}} employers are staffing without visas', 'a second route to {{industry_short|seasonal}} workers', '{{state_name|your area}} employers: a backup crew plan'].join('\n'),
    preheader: 'Workers already in the U.S. and authorized to work.',
    headline: 'A backup crew plan for {{industry_label|seasonal employers}}',
    body: [
      'Hi {{first_name|there}},',
      '{{industry_pitch}}',
      '## Roles we fill most often',
      '{{industry_roles_list}}',
      '## Why employers add us to their plan',
      [
        '- **No visa risk:** our candidates already live in the U.S. and are authorized to work.',
        '- **Screened for your job:** we check paperwork, experience, and fit before anyone is sent your way.',
        '- **Flexible headcount:** a full crew, or just two or three backfills.',
        '- **Support after placement:** we stay involved with both you and the worker.',
      ].join('\n'),
      '[[button]]',
      'If it\'s easier, call us at {{phone}} or just reply with what you need.',
    ].join('\n\n'),
    cta_text: 'Tell us what you need',
    cta_url: '',
  };

  const step4 = {
    step: 4, delay_days: 7, style: 'plain', thread_with_previous: 1,
    subjects: '',
    preheader: '',
    headline: '',
    body: [
      '{{first_name|Hi}},',
      theme.breakup,
      '{Thanks|Appreciate it},',
    ].join('\n\n'),
    cta_text: '', cta_url: '',
  };

  return [step1, step2, step3, step4];
}

const INDUSTRY_SHORT = {
  landscaping: 'landscaping', agriculture: 'farm', hospitality: 'hospitality', construction: 'construction',
  manufacturing: 'manufacturing', seafood: 'seafood', other: '',
};

export function industryVars(industry) {
  const key = INDUSTRY_COPY[industry] ? industry : 'other';
  const copy = INDUSTRY_COPY[key];
  const roles = copy.roles.replace(/, and /, ', ').split(/,\s*/).map((r) => r.replace(/^and /, ''));
  return {
    industry_pitch: copy.pitch,
    industry_roles: copy.roles,
    industry_roles_list: roles.map((r) => `- ${r.charAt(0).toUpperCase()}${r.slice(1)}`).join('\n'),
    industry_short: INDUSTRY_SHORT[key],
  };
}

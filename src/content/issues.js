// Starter newsletter issues. Issue 1 is the email Amigos has been sending from Flodesk; the others
// are variations on it so the list doesn't get the same email every time. All load as drafts.

export const STARTER_ISSUES = [
  {
    title: 'Empower your team (the original Flodesk email)',
    subjects: [
      'Discover top Hispanic workers with Amigos Recruiting',
      'hard-working crews, already in the U.S.',
      'need workers for {{company|your team}}?',
    ],
    preheader: 'Hard-working people who are already here and want the job.',
    headline: 'Discover top Hispanic workers with Amigos Recruiting',
    image_url: '/hero-worker.jpg',
    image_alt: 'Empower your team with the vibrancy of Hispanic talent',
    body: `{Hi|Hello} {{first_name|there}},

I'm reaching out on behalf of Amigos Recruiting, a recruitment platform dedicated to connecting businesses with Hispanic workers already based in the United States. We know how much finding the right fit for your team matters, and we're here to make the process simpler for you.

We focus on connecting employers with dedicated, hard-working people from the Hispanic community nationwide. Whether you're looking to grow your crew or fill specific roles, we tailor the search to your requirements.

Visit our website at amigosrecruiting.com to see how we can help you find the right candidates for your team. Or call us directly at **{{phone}}** to talk through your hiring needs.

Thank you for considering Amigos Recruiting. We look forward to working with you.

[[button]]`,
    cta_text: 'Visit our website',
  },
  {
    title: 'A backup plan for the visa lottery',
    subjects: [
      'a backup plan if the visas fall through',
      'workers who don\'t depend on the H-2B cap',
      'staffing {{company|your team}} without the lottery',
    ],
    preheader: 'No petitions, no consulate interviews, no cap lottery.',
    headline: 'Workers who don\'t depend on the visa lottery',
    image_url: '/hero-worker.jpg',
    image_alt: 'A hard-working employee ready for the job',
    body: `{Hi|Hello} {{first_name|there}},

Every year, good employers file for H-2 visas on time and still come up short. The cap fills, the lottery doesn't go their way, or workers arrive weeks late.

Amigos Recruiting gives you another option. We recruit Hispanic workers who already live in the U.S. and are authorized to work here, so there's no petition, no consulate interview and no waiting on a cap.

## How it works

1. **Tell us what you need:** roles, headcount, location, pay and start date.
2. **We recruit and screen:** candidates who match your requirements.
3. **They show up ready to work:** no visa paperwork on your end.

> Use us as your backup plan, or as your main source if you're tired of the lottery.

[[button]]

Or reply to this email with the roles and dates you're working with, and we'll get back to you within one business day.`,
    cta_text: 'Start hiring',
  },
  {
    title: 'Fill the roles you can\'t keep filled',
    subjects: [
      'the roles that are hardest to keep filled',
      'replacing workers mid-season',
      'crews for {{industry_label|seasonal work}}',
    ],
    preheader: 'When someone leaves mid-season, we help you replace them fast.',
    headline: 'Fill the roles you can\'t keep filled',
    image_url: '/hero-worker.jpg',
    image_alt: 'A dependable worker on the job',
    body: `{Hi|Hello} {{first_name|there}},

Turnover in the middle of a busy season is expensive. When someone leaves, the work doesn't wait.

{{industry_pitch}}

## Roles we recruit for

{{industry_roles_list}}

Because our candidates already live in the U.S. and are authorized to work, we can move as fast as your schedule needs, whether you need one replacement or a full crew.

[[button]]

Just reply with the role and how many people you need. A real person reads every reply.`,
    cta_text: 'Tell us what you need',
  },
  {
    title: 'Plan next season\'s crew now',
    subjects: [
      'already planning {{next_year}}?',
      'next season\'s crew, sorted early',
      'thinking about next season yet?',
    ],
    preheader: 'Employers who plan early get first pick of experienced workers.',
    headline: 'Plan next season\'s crew now',
    image_url: '/hero-worker.jpg',
    image_alt: 'An experienced worker ready for next season',
    body: `{Hi|Hello} {{first_name|there}},

Most seasonal employers are deciding right now how they'll staff next year. The ones who plan early get first pick of experienced, reliable workers.

Amigos Recruiting can be part of that plan. Tell us your start date and headcount, and we'll start lining up candidates who already live in the U.S. and are authorized to work.

- No visa petitions or consulate interviews
- Candidates screened for experience and fit
- Support for you and your new workers after placement

[[button]]

Prefer to talk it through? Call us at **{{phone}}**.`,
    cta_text: 'Plan my crew',
  },
  {
    title: 'Why employers call Amigos',
    subjects: [
      'dependable workers, without the paperwork',
      'how Amigos Recruiting works',
      'a quick note for {{company|your team}}',
    ],
    preheader: 'Hard-working people who are already here and want the job.',
    headline: 'Hard-working people, ready to work',
    image_url: '/hero-worker.jpg',
    image_alt: 'A hard-working employee smiling at work',
    body: `{Hi|Hello} {{first_name|there}},

Finding people who show up, work hard and stay through the season is the hardest part of running a crew. That's the only thing we do.

Amigos Recruiting connects employers with Hispanic workers who already live in the United States, from Texas and Florida to Puerto Rico, and are authorized to work. We screen every candidate for experience and fit before you meet them.

> No visa paperwork. No lottery. No waiting on a consulate. Just hard-working people who want the job.

[[button]]

If you have a hiring need coming up, reply with the details or call **{{phone}}**. We'll take it from there.`,
    cta_text: 'Visit our website',
  },
];

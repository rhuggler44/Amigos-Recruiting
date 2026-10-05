import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { config } from '../config.js';
import { all, getSettings } from '../db.js';
import { themeForMonth, themeByKey } from './library.js';
import { monthLabel } from '../lib/time.js';

const EmailSchema = z.object({
  step: z.number().int().min(1).max(6),
  style: z.enum(['newsletter', 'plain']),
  delay_days: z.number().int().min(0).max(21),
  thread_with_previous: z.boolean(),
  subjects: z.array(z.string().max(90)),
  preheader: z.string().max(140),
  headline: z.string().max(140),
  body: z.string().min(40).max(4000),
  cta_text: z.string().max(40),
});
const CampaignSchema = z.object({
  campaign_name: z.string().max(80),
  emails: z.array(EmailSchema).min(3).max(5),
});

const JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['campaign_name', 'emails'],
  properties: {
    campaign_name: { type: 'string' },
    emails: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['step', 'style', 'delay_days', 'thread_with_previous', 'subjects', 'preheader', 'headline', 'body', 'cta_text'],
        properties: {
          step: { type: 'integer' },
          style: { type: 'string', enum: ['newsletter', 'plain'] },
          delay_days: { type: 'integer' },
          thread_with_previous: { type: 'boolean' },
          subjects: { type: 'array', items: { type: 'string' } },
          preheader: { type: 'string' },
          headline: { type: 'string' },
          body: { type: 'string' },
          cta_text: { type: 'string' },
        },
      },
    },
  },
};

const SYSTEM = `You write cold outreach email sequences for Amigos Recruiting, a U.S. recruiting agency.

What Amigos does: it recruits Hispanic workers who already live in the United States (Texas, Florida, Puerto Rico and elsewhere) and are authorized to work here, and places them with employers that need seasonal or hard-to-fill labor: landscaping, farms and nurseries, hotels and resorts, restaurants, seafood and food processing, construction, manufacturing, and forestry. Amigos screens candidates for paperwork, experience and fit, and supports both sides after placement.

Who receives these emails: owners and managers at businesses that have filed for H-2A or H-2B seasonal worker visas (public U.S. Department of Labor records). Their pain: the H-2B cap (66,000 per year, 33,000 per half) is oversubscribed and decided by lottery, approved employers often get no visa numbers, visa workers arrive late, the process is slow and costly, and mid-season turnover is hard to replace. Amigos is a backup plan, or a primary source, that does not depend on visas: no petitions, no consulate interviews, no lottery.

Writing rules:
- Sound like a real person at a small company: plain words, short sentences, about an 8th-grade reading level. No hype, no corporate filler ("premier", "seamless", "leverage", "synergy", "delve"), no exclamation marks, no ALL CAPS, no emoji.
- Never invent facts: no made-up statistics, client names, testimonials, placement counts, prices, or guaranteed timelines. Describe workers as "already in the U.S. and authorized to work", never as "citizens" in general.
- Avoid spam-filter triggers in subjects: no "free", "guarantee", "act now", "urgent", "$", "100%", or misleading "Re:"/"Fwd:" prefixes. Subjects are 2–7 words, mostly lowercase, and specific to the month's angle.
- Every email must make sense on its own, invite a simple reply, and be respectful of the reader's time.
- Do not include a signature, unsubscribe line, or postal address; those are added automatically.

Sequence format: return 4 emails.
- Step 1: style "newsletter", delay_days 0, thread_with_previous false. A short branded issue: greeting, 2–3 sentence intro tied to the month's angle, a "## " section with 3 bullets about what employers are dealing with right now, a "## How it works" section with 3 numbered steps, one "> " callout line, then "[[button]]", then a one-line reply invitation. 180–260 words.
- Step 2: style "plain", delay_days 7, thread_with_previous true (sent as a reply in the same thread, so subjects must be an empty list). 40–80 words, one question.
- Step 3: style "newsletter", delay_days 7, thread_with_previous false. An industry-focused issue that uses {{industry_pitch}} as its own paragraph and {{industry_roles_list}} under a "## " heading, plus a different angle from step 1, then "[[button]]". 120–200 words.
- Step 4: style "plain", delay_days 7, thread_with_previous true, subjects empty. A polite last note, 25–50 words, with an easy one-word reply option.
Give 3 subject variants for steps 1 and 3 (used for A/B testing). Headline and preheader are only for newsletter steps; use "" for plain steps. cta_text is a 2–5 word button label for newsletter steps and "" for plain steps.

Body markup (the only formatting available): blank line between blocks; "## Heading"; "- " bullets; "1. " numbered steps; "> " callout; "[[button]]" on its own line; **bold**; no other markdown, no HTML, no links.
Merge fields you may use (always give a fallback where shown): {{first_name|there}}, {{company|your team}}, {{state_name|your area}}, {{industry_label|seasonal employers}}, {{industry_roles}}, {{industry_pitch}}, {{industry_roles_list}}, {{month}}, {{next_year}}, {{phone}}. Optional spintax for small wording variety: {option a|option b}.`;

export function aiAvailable() {
  return Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
}

/**
 * Ask Claude for a fresh 4-email sequence for `month`.
 * Returns { name, emails } in the same shape as library.buildSequence().
 */
export async function generateCampaignCopy({ month, themeKey, notes = '', client }) {
  if (!client && !aiAvailable()) throw new Error('Set ANTHROPIC_API_KEY to generate copy with Claude.');
  const theme = (themeKey && themeByKey(themeKey)) || themeForMonth(month);
  const settings = getSettings();
  const recentSubjects = all(`SELECT ce.subjects FROM campaign_emails ce JOIN campaigns c ON c.id = ce.campaign_id
    WHERE ce.subjects != '' ORDER BY c.id DESC LIMIT 12`).flatMap((r) => r.subjects.split('\n')).filter(Boolean).slice(0, 30);

  const prompt = [
    `Write the ${monthLabel(month)} sequence.`,
    `This month's angle: ${theme.title}. ${theme.angle}`,
    notes ? `Extra direction from the Amigos team: ${notes}` : '',
    recentSubjects.length ? `Subjects already used in recent months (do not reuse or closely imitate):\n${recentSubjects.map((s) => `- ${s}`).join('\n')}` : '',
    `Company phone for reference: ${settings.company_phone}.`,
  ].filter(Boolean).join('\n\n');

  const stream = (client || new Anthropic()).beta.messages.stream({
    model: config.anthropicModel,
    max_tokens: 16000,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    system: SYSTEM,
    output_config: { effort: 'high', format: { type: 'json_schema', schema: JSON_SCHEMA } },
    messages: [{ role: 'user', content: prompt }],
  });
  const message = await stream.finalMessage();
  if (message.stop_reason === 'refusal') throw new Error('Claude declined to write this sequence. Try different direction notes.');
  if (message.stop_reason === 'max_tokens') throw new Error('The response was cut off. Try again.');
  const text = message.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  let parsed;
  try {
    parsed = CampaignSchema.parse(JSON.parse(text));
  } catch (err) {
    throw new Error(`Claude returned copy in an unexpected shape: ${err.message.slice(0, 300)}`);
  }

  const emails = parsed.emails
    .sort((a, b) => a.step - b.step)
    .map((e, i) => ({
      step: i + 1,
      style: e.style,
      delay_days: i === 0 ? 0 : Math.max(3, e.delay_days),
      thread_with_previous: i > 0 && e.thread_with_previous,
      subjects: e.thread_with_previous && i > 0 ? '' : e.subjects.map((s) => s.trim()).filter(Boolean).join('\n'),
      preheader: e.style === 'newsletter' ? e.preheader : '',
      headline: e.style === 'newsletter' ? e.headline : '',
      body: e.body.trim(),
      cta_text: e.style === 'newsletter' ? e.cta_text : '',
      cta_url: '',
    }));
  if (!emails[0].subjects) throw new Error('Claude did not provide subject lines for the first email. Try again.');
  return { name: `${monthLabel(month)}: ${parsed.campaign_name}`, theme, emails };
}

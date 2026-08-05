'use strict';

/**
 * Editable public copy.
 *
 * Every customer-facing document the setup engine publishes lives here so the
 * wording can be changed without touching a single line of logic. Each entry is
 * rendered into a branded embed by `services/panelService.js`.
 */

const RULES = Object.freeze({
  title: 'Community Guidelines',
  intro:
    'This is a professional workspace shared by our team and our clients. ' +
    'The guidelines below keep it useful for everyone. Membership implies acceptance.',
  sections: [
    {
      name: '01 · Professional Conduct',
      value:
        'Treat everyone with respect. Harassment, discrimination, personal attacks and deliberate provocation are not tolerated.',
    },
    {
      name: '02 · Keep Channels On Topic',
      value:
        'Use the channel that matches your message. Project discussion belongs in your ticket, not in public channels.',
    },
    {
      name: '03 · No Advertising',
      value:
        'Unsolicited promotion, invite links and direct-message advertising are prohibited. Partnership requests go through the Promotion Partnership ticket.',
    },
    {
      name: '04 · No Spam or Disruption',
      value:
        'Flooding, mass mentions, repeated messages and automated abuse result in immediate moderation action.',
    },
    {
      name: '05 · Safe Content Only',
      value:
        'No NSFW material, malicious links, pirated software, cheats or exploits of any kind.',
    },
    {
      name: '06 · One Ticket Per Request',
      value:
        'Open a single ticket per project. Duplicate tickets are merged or closed to keep response times fast.',
    },
    {
      name: '07 · Privacy',
      value:
        'Never share credentials, tokens or personal data in public channels. Sensitive material belongs in your private ticket.',
    },
    {
      name: '08 · Discord Terms',
      value:
        'Discord\'s [Terms of Service](https://discord.com/terms) and [Community Guidelines](https://discord.com/guidelines) apply at all times.',
    },
  ],
  footer: 'Guidelines are enforced at staff discretion. Repeat violations escalate automatically.',
});

const FAQ = Object.freeze({
  title: 'Frequently Asked Questions',
  intro: 'The answers below cover most questions. Anything else — open a ticket and ask.',
  sections: [
    {
      name: '❓ How do I place an order?',
      value:
        'Open a ticket in the create-ticket channel, choose the service you need and complete the short project form. ' +
        'You receive a written quote before any work begins.',
    },
    {
      name: '💳 Which payment methods are accepted?',
      value:
        'PayPal (Goods & Services) and bank transfer for larger engagements. Cryptocurrency may be accepted for international clients on request. ' +
        'Invoices are issued before work starts.',
    },
    {
      name: '⏱️ How long does a project take?',
      value:
        'Small utilities: 1–3 days. Standard projects: 1–2 weeks. Large systems: scheduled after a scoping call. ' +
        'Every quote includes a written delivery estimate.',
    },
    {
      name: '💰 How is pricing determined?',
      value:
        'Pricing is based on scope, complexity and timeline. Fixed-price quotes are standard; hourly billing is available for ongoing maintenance.',
    },
    {
      name: '↩️ What is the refund policy?',
      value:
        'Deposits are refundable until development begins. Once development starts, refunds are prorated against completed work. ' +
        'Delivered work is non-refundable — see the Terms of Service.',
    },
    {
      name: '🎨 Do you take free commissions?',
      value:
        'A limited number of small projects are accepted for portfolio purposes. Selection is discretionary and based on originality, ' +
        'usefulness and available capacity. Paid work always takes priority.',
    },
    {
      name: '🕒 What are your support hours?',
      value:
        'Office hours are published in the working-hours channel. Outside those hours, messages are answered on the next business day.',
    },
    {
      name: '⭐ Where can I read reviews?',
      value:
        'Every verified review from a completed order is published in the reviews channel. Reviews are never edited or filtered.',
    },
    {
      name: '📬 How do I reach the team?',
      value:
        'Tickets are the only supported support channel — they are logged, transcribed and never lost. Direct messages are not monitored.',
    },
  ],
  footer: 'Answers are reviewed regularly. Open a support ticket if something is unclear.',
});

const TOS = Object.freeze({
  title: 'Terms of Service',
  intro:
    'These terms govern every engagement with the studio. Placing an order constitutes acceptance. ' +
    'They exist to protect both parties and to keep expectations clear.',
  sections: [
    {
      name: '1 · Payment',
      value:
        'A deposit of 50% is required before development begins, with the balance due on delivery. ' +
        'Projects under a small-order threshold may require payment in full upfront. Work pauses if an invoice becomes overdue.',
    },
    {
      name: '2 · Scope & Revisions',
      value:
        'Each quote defines a fixed scope. Two rounds of revisions within that scope are included. ' +
        'Additional revisions or new requirements are quoted separately as a change request.',
    },
    {
      name: '3 · Ownership & Licensing',
      value:
        'Full ownership of the delivered source code transfers to the client on final payment. ' +
        'The studio retains the right to reference the project in its portfolio unless a confidentiality agreement states otherwise.',
    },
    {
      name: '4 · Cancellation',
      value:
        'Either party may cancel in writing at any time. Completed work is invoiced up to the cancellation date; ' +
        'the remaining deposit is refunded. Deliverables are released only for work that has been paid for.',
    },
    {
      name: '5 · Delivery',
      value:
        'Delivery estimates are made in good faith based on the agreed scope. Delays caused by missing information, ' +
        'late feedback or scope changes extend the timeline accordingly. Clients are notified proactively of any change.',
    },
    {
      name: '6 · Communication',
      value:
        'All project communication happens in the project ticket so that it is logged and transcribed. ' +
        'Clients are expected to respond to blocking questions within a reasonable timeframe.',
    },
    {
      name: '7 · Support & Warranty',
      value:
        'Defects in delivered functionality are fixed free of charge for 30 days after delivery. ' +
        'New features, third-party breaking changes and hosting issues fall outside the warranty.',
    },
    {
      name: '8 · Liability',
      value:
        'Software is delivered on an "as is" basis after acceptance. The studio is not liable for indirect, incidental or ' +
        'consequential damages, data loss, or loss of revenue. Total liability is limited to the amount paid for the engagement.',
    },
    {
      name: '9 · Prohibited Work',
      value:
        'The studio does not build malware, spam tooling, credential harvesters, cheats, or anything that violates the ' +
        'terms of a third-party platform. Such requests are declined without refund of any consultation fee.',
    },
    {
      name: '10 · Amendments',
      value:
        'These terms may be updated. Changes never apply retroactively to an engagement that is already in progress.',
    },
  ],
  footer: 'Last reviewed on publication. Questions about these terms are welcome in a support ticket.',
});

/**
 * Pricing copy.
 *
 * Deliberately quote-based: no published prices. Every project is priced on the
 * work it actually takes, so a list of numbers would either be wrong or would
 * anchor a customer to the wrong figure. `from` is kept as `null` on every
 * service — the renderer prints "Custom quote" for it — so a studio that later
 * wants published starting prices can add numbers without touching any code.
 */
const PRICING = Object.freeze({
  title: 'Pricing & Quotes',
  intro:
    'Every project is priced individually, because no two are the same amount of work. ' +
    'Tell us what you need and you get a written, fixed-price quote before anything starts — ' +
    'no hourly meter, no scope creep, no surprises on the invoice.',
  currency: '$',
  services: [
    {
      name: 'Discord Bot Development',
      emoji: '🤖',
      from: null,
      note: 'Slash commands, dashboards, moderation, economy, custom integrations.',
    },
    {
      name: 'Minecraft Plugin Development',
      emoji: '🧩',
      from: null,
      note: 'Spigot, Paper, Velocity and Fabric. Includes config and documentation.',
    },
    {
      name: 'Website Development',
      emoji: '🌐',
      from: null,
      note: 'Landing pages, storefronts, dashboards. Responsive and SEO-ready.',
    },
    {
      name: 'API Development',
      emoji: '🔌',
      from: null,
      note: 'REST and realtime APIs, authentication, documentation, deployment.',
    },
    {
      name: 'Custom Software',
      emoji: '⚙️',
      from: null,
      note: 'Desktop tools, services and bespoke systems built to specification.',
    },
    {
      name: 'Automation & Tooling',
      emoji: '🔁',
      from: null,
      note: 'Scripts, scrapers, pipelines and internal tooling.',
    },
    {
      name: 'Bug Fixes & Maintenance',
      emoji: '🐞',
      from: null,
      note: 'Diagnosis included. Priced once the cause is actually understood.',
    },
    {
      name: 'Code Review & Consulting',
      emoji: '🔍',
      from: null,
      note: 'Architecture review, security review, written recommendations.',
    },
  ],
  /** What actually moves the number — set expectations without naming one. */
  factors: [
    'How much has to be built from scratch versus assembled from known parts',
    'How many moving pieces have to talk to each other reliably',
    'Whether it needs a database, hosting, or a dashboard alongside it',
    'How much edge-case handling and testing the job genuinely warrants',
    'How soon you need it — rush work displaces other scheduled projects',
  ],
  notes: [
    'Quotes are free. Describing your project costs you nothing and commits you to nothing.',
    'The quote is fixed. Once agreed, the price does not move unless you change the scope.',
    'A deposit secures your slot in the queue; the balance is due on delivery.',
    'Small fixes are often cheaper than you expect — ask before assuming.',
    'Ongoing maintenance and retainers are arranged separately at a reduced rate.',
  ],
  footer: 'Open a ticket for a free, no-obligation quote. Quotes are valid for 14 days.',
});

const PORTFOLIO = Object.freeze({
  title: 'What We Build',
  intro:
    'A selection of the work the studio delivers. Individual case studies are published below as projects complete.',
  services: [
    {
      name: '🤖 Discord Bots',
      value: 'Moderation suites, ticket platforms, economy systems, dashboards and API-backed integrations.',
    },
    {
      name: '🧩 Minecraft Plugins',
      value: 'Gameplay systems, minigames, protection tooling, cross-server networks and performance work.',
    },
    {
      name: '🌐 Websites',
      value: 'Marketing sites, storefronts and web applications built on modern, maintainable stacks.',
    },
    {
      name: '📊 Dashboards',
      value: 'Operational dashboards with authentication, live data and role-based access control.',
    },
    {
      name: '🔌 APIs',
      value: 'REST and realtime services, third-party integrations, documented and deployment-ready.',
    },
    {
      name: '🔁 Automation',
      value: 'Data pipelines, scheduled jobs, scrapers and internal tooling that removes manual work.',
    },
    {
      name: '⚙️ Custom Software',
      value: 'Desktop utilities, background services and bespoke systems built to specification.',
    },
  ],
  footer: 'Every project ships with documentation, source code and a 30-day defect warranty.',
});

const WELCOME = Object.freeze({
  title: 'Welcome to the Studio',
  intro:
    'You have joined the client workspace of a professional software development studio. ' +
    'Everything you need is a click away.',
  sections: [
    { name: '🎫 Start a project', value: 'Open a ticket, pick a service and complete a short brief. You get a written quote before any work begins.' },
    { name: '💰 Understand pricing', value: 'Starting prices for every service are published, and every quote is fixed-price.' },
    { name: '📁 Review our work', value: 'Browse delivered projects and verified customer reviews before you commit.' },
    { name: '📈 Check availability', value: 'Live developer status, office hours and the current project queue are always public.' },
  ],
  footer: 'Read the guidelines before posting. We are glad to have you here.',
});

/** Free portfolio commission programme copy. */
const FREE_COMMISSION = Object.freeze({
  title: 'Free Portfolio Commission Programme',
  intro:
    'A limited number of projects are built free of charge to strengthen the studio portfolio. ' +
    'This is a genuine offer with genuine limits — please read before applying.',
  sections: [
    { name: '✅ What is included', value: 'A complete, working build with source code and documentation, delivered to the same standard as paid work.' },
    { name: '📏 Suitable scope', value: 'Small, self-contained projects. Anything that would normally be quoted above a few hours of work is out of scope.' },
    { name: '🎯 How projects are selected', value: 'Selection is based on originality, usefulness to a wider audience, portfolio value and current capacity.' },
    { name: '⚠️ No guarantee', value: 'Submitting an application does not guarantee acceptance. Most applications are declined simply due to capacity.' },
    { name: '💼 Commercial projects', value: 'Applications with a clear commercial purpose receive a paid quote instead of a free build.' },
    { name: '⏳ Priority', value: 'Paid engagements always take priority. Free builds are scheduled around them and have no committed deadline.' },
  ],
  footer: 'Applications are reviewed individually — usually within three business days.',
});

/** Promotion partnership programme copy. */
const PROMOTION = Object.freeze({
  title: 'Promotion Partnership Programme',
  intro:
    'Minecraft SMP content is streamed regularly to an audience that typically reaches 100+ concurrent viewers. ' +
    'Servers that fit the audience may be showcased on stream or within the community.',
  sections: [
    { name: '📺 What promotion looks like', value: 'On-stream gameplay and commentary, a community announcement, and placement in the partner listing for the duration agreed.' },
    { name: '🔎 How applications are reviewed', value: 'Each application is reviewed individually on quality, originality, stability and fit with the audience.' },
    { name: '⚠️ Not guaranteed', value: 'Meeting every requirement does not guarantee promotion. Slots are limited and selection is discretionary.' },
    { name: '📋 What we look for', value: 'A stable, well-built server, a distinctive concept, an active and well-moderated community, and an experience that is genuinely enjoyable to play on camera.' },
    { name: '🚫 What is declined', value: 'Pay-to-win economies, unmoderated communities, servers with fewer than a handful of active players, and anything violating Mojang\'s commercial guidelines.' },
  ],
  footer: 'Applications are reviewed within five business days. A decision is always communicated.',
});

module.exports = { RULES, FAQ, TOS, PRICING, PORTFOLIO, WELCOME, FREE_COMMISSION, PROMOTION };

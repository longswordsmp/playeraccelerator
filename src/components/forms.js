'use strict';

/**
 * Modal form definitions.
 *
 * Discord caps a modal at five text inputs, which is the hard constraint every
 * form here is designed around: each one asks for exactly the five things that
 * matter most for its workflow, and the remaining detail is gathered
 * conversationally inside the ticket.
 *
 * `buildForm(ticket)` picks the right form for a ticket's service category.
 */

const components = require('../utils/components');
const customId = require('../utils/customId');
const validators = require('../utils/validators');
const { TICKET_TYPE_MAP } = require('../config/server');
const { padId } = require('../utils/formatters');

/** The standard project brief, used for every paid service category. */
const ORDER_FORM = {
  action: 'orderSubmit',
  title: (ticket) => `Project Brief · #${padId(ticket.number)}`,
  fields: [
    { id: 'title', label: 'Project name', placeholder: 'Ticket bot for my community', max: 100 },
    {
      id: 'description',
      label: 'What do you need built?',
      style: 'paragraph',
      placeholder: 'Describe the features, the users, and what success looks like.',
      min: 20,
      max: 1500,
    },
    { id: 'budget', label: 'Budget', placeholder: 'e.g. $150, or 100-200', required: false, max: 60 },
    { id: 'deadline', label: 'Preferred deadline', placeholder: 'e.g. within 2 weeks, or a specific date', required: false, max: 100 },
    {
      id: 'extra',
      label: 'Reference links & notes',
      style: 'paragraph',
      required: false,
      placeholder: 'Similar projects, designs, repositories, and how best to reach you.',
      max: 1000,
    },
  ],
};

/** Free portfolio commission application. */
const FREE_COMMISSION_FORM = {
  action: 'freeCommissionSubmit',
  title: (ticket) => `Free Commission · #${padId(ticket.number)}`,
  fields: [
    { id: 'title', label: 'Project name', placeholder: 'A short, descriptive name', max: 100 },
    {
      id: 'description',
      label: 'Detailed description',
      style: 'paragraph',
      placeholder: 'What exactly should it do? Be specific — vague applications are declined.',
      min: 30,
      max: 1500,
    },
    {
      id: 'purpose',
      label: 'What is it for?',
      style: 'paragraph',
      placeholder: 'Who uses it, and what problem does it solve for them?',
      max: 700,
    },
    {
      id: 'pitch',
      label: 'Why should this be selected?',
      style: 'paragraph',
      placeholder: 'Originality, usefulness to others, portfolio value.',
      max: 700,
    },
    { id: 'extra', label: 'References & timing', style: 'paragraph', required: false, placeholder: 'Links, images, and any timing you have in mind.', max: 700 },
  ],
};

/** Promotion partnership application. */
const PROMOTION_FORM = {
  action: 'promotionSubmit',
  title: (ticket) => `Promotion Application · #${padId(ticket.number)}`,
  fields: [
    { id: 'server', label: 'Server name, IP and version', placeholder: 'Example SMP | play.example.net | 1.21', max: 200 },
    {
      id: 'description',
      label: 'Describe your server',
      style: 'paragraph',
      placeholder: 'The concept, the community, what a new player experiences on day one.',
      min: 30,
      max: 1200,
    },
    {
      id: 'features',
      label: 'What makes it different?',
      style: 'paragraph',
      placeholder: 'Custom plugins, world design, events — what nobody else has.',
      max: 900,
    },
    { id: 'players', label: 'Current concurrent players', placeholder: 'e.g. 35', required: false, max: 20 },
    {
      id: 'links',
      label: 'Discord invite, website, trailer',
      style: 'paragraph',
      required: false,
      placeholder: 'One per line.',
      max: 500,
    },
  ],
};

/** Bug report against delivered work. */
const BUG_FORM = {
  action: 'orderSubmit',
  title: (ticket) => `Bug Report · #${padId(ticket.number)}`,
  fields: [
    { id: 'title', label: 'Summary', placeholder: 'Ticket panel button does nothing on mobile', max: 100 },
    {
      id: 'description',
      label: 'Steps to reproduce',
      style: 'paragraph',
      placeholder: '1. Open the panel\n2. Tap Create Ticket\n3. Nothing happens',
      min: 15,
      max: 1200,
    },
    { id: 'budget', label: 'Which project is affected?', placeholder: 'Order number, or the project name', required: false, max: 100 },
    { id: 'deadline', label: 'How urgent is this?', placeholder: 'Blocking / annoying / cosmetic', required: false, max: 60 },
    {
      id: 'extra',
      label: 'Logs, screenshots, environment',
      style: 'paragraph',
      required: false,
      placeholder: 'Anything that helps us reproduce it.',
      max: 900,
    },
  ],
};

/** General support enquiry. */
const SUPPORT_FORM = {
  action: 'orderSubmit',
  title: (ticket) => `Support Request · #${padId(ticket.number)}`,
  fields: [
    { id: 'title', label: 'Subject', placeholder: 'Question about my invoice', max: 100 },
    {
      id: 'description',
      label: 'How can we help?',
      style: 'paragraph',
      placeholder: 'Tell us what you need. Include any order numbers.',
      min: 10,
      max: 1500,
    },
    { id: 'budget', label: 'Related order (optional)', placeholder: 'e.g. 0042', required: false, max: 40 },
    { id: 'deadline', label: 'Is this time sensitive?', required: false, placeholder: 'Yes — need an answer today / No', max: 80 },
    { id: 'extra', label: 'Anything else', style: 'paragraph', required: false, max: 700 },
  ],
};

const FORMS = {
  order: ORDER_FORM,
  freeCommission: FREE_COMMISSION_FORM,
  promotion: PROMOTION_FORM,
  bug: BUG_FORM,
  support: SUPPORT_FORM,
};

/**
 * Build the modal for a ticket, chosen by its service category.
 * @param {object} ticket
 * @returns {import('discord.js').ModalBuilder}
 */
function buildForm(ticket) {
  const type = TICKET_TYPE_MAP[ticket.type];
  const definition = FORMS[type?.form ?? 'order'] ?? ORDER_FORM;
  return components.modal({
    id: customId.build('ticket', definition.action, ticket._id.toString()),
    title: definition.title(ticket),
    fields: definition.fields,
  });
}

/**
 * Normalise a submitted project brief into the shape `orderService` expects.
 * @param {import('discord.js').ModalSubmitInteraction} interaction
 * @param {object} ticket
 */
function parseBrief(interaction, ticket) {
  const get = (id) => {
    try {
      return interaction.fields.getTextInputValue(id);
    } catch {
      return '';
    }
  };

  const extra = get('extra');
  return {
    title: validators.text(get('title'), 'Project name', { max: 150, allowNewlines: false }),
    description: validators.text(get('description'), 'Description', { max: 3000, min: 5 }),
    budget: validators.budget(get('budget')),
    deadline: validators.clean(get('deadline'), { max: 150, allowNewlines: false }),
    references: validators.extractUrls(extra),
    notes: validators.clean(extra, { max: 1500 }),
    serviceType: ticket.type,
    isFreeCommission: ticket.type === 'free-commission',
  };
}

/**
 * Normalise a free-commission application.
 * @param {import('discord.js').ModalSubmitInteraction} interaction
 * @param {object} ticket
 */
function parseFreeCommission(interaction, ticket) {
  const get = (id) => {
    try {
      return interaction.fields.getTextInputValue(id);
    } catch {
      return '';
    }
  };

  const extra = get('extra');
  return {
    title: validators.text(get('title'), 'Project name', { max: 150, allowNewlines: false }),
    description: validators.text(get('description'), 'Description', { max: 3000, min: 20 }),
    requirements: validators.clean(get('purpose'), { max: 1000 }),
    notes: [
      get('pitch') ? `Why it should be selected: ${validators.clean(get('pitch'), { max: 900 })}` : '',
      extra ? `Additional: ${validators.clean(extra, { max: 700 })}` : '',
    ].filter(Boolean).join('\n\n'),
    budget: { raw: 'Free portfolio commission', amount: 0 },
    deadline: '',
    references: validators.extractUrls(extra),
    serviceType: ticket.type,
    isFreeCommission: true,
  };
}

/**
 * Normalise a promotion application.
 * @param {import('discord.js').ModalSubmitInteraction} interaction
 */
function parsePromotion(interaction) {
  const get = (id) => {
    try {
      return interaction.fields.getTextInputValue(id);
    } catch {
      return '';
    }
  };

  // "Name | ip | version" is the shape the placeholder asks for; fall back
  // gracefully when a customer types it differently.
  const serverLine = validators.text(get('server'), 'Server details', { max: 200, allowNewlines: false });
  const [namePart, ipPart, versionPart] = serverLine.split('|').map((part) => part.trim());

  const links = get('links');
  const urls = validators.extractUrls(links);
  const invite = urls.find((url) => /discord\.(?:gg|com)/i.test(url)) ?? '';
  const trailer = urls.find((url) => /(?:youtube\.com|youtu\.be|twitch\.tv)/i.test(url)) ?? '';
  const website = urls.find((url) => url !== invite && url !== trailer) ?? '';

  const playersRaw = get('players');
  const playerMatch = String(playersRaw).match(/\d+/);

  return {
    serverName: namePart || serverLine,
    serverIp: ipPart ? validators.clean(ipPart, { max: 120, allowNewlines: false }) : '',
    version: versionPart ? validators.clean(versionPart, { max: 40, allowNewlines: false }) : '',
    description: validators.text(get('description'), 'Description', { max: 2000, min: 20 }),
    features: validators.clean(get('features'), { max: 1500 }),
    playerCount: playerMatch ? Number(playerMatch[0]) : null,
    website,
    discordInvite: invite,
    trailerUrl: trailer,
    pitch: validators.clean(get('features'), { max: 1500 }),
    additional: validators.clean(links, { max: 500 }),
  };
}

/** The review modal, shown after a star rating is chosen. */
function reviewModal(ticketId, rating) {
  return components.modal({
    id: customId.build('review', 'submit', ticketId, rating),
    title: `Your ${rating}-star review`,
    fields: [
      {
        id: 'feedback',
        label: 'Overall feedback',
        style: 'paragraph',
        placeholder: 'How was the experience from start to finish?',
        min: 10,
        max: 1500,
      },
      { id: 'liked', label: 'What went well?', style: 'paragraph', required: false, max: 700 },
      { id: 'improvements', label: 'What could be better?', style: 'paragraph', required: false, max: 700 },
      { id: 'recommend', label: 'Would you recommend us?', required: false, placeholder: 'Yes / No / Maybe', max: 60 },
      { id: 'additional', label: 'Anything else', style: 'paragraph', required: false, max: 700 },
    ],
  });
}

module.exports = {
  FORMS,
  buildForm,
  parseBrief,
  parseFreeCommission,
  parsePromotion,
  reviewModal,
};

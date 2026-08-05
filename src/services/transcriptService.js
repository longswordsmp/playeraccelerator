'use strict';

/**
 * Ticket transcript generation.
 *
 * Produces a self-contained, styled HTML transcript (no external assets, no CDN
 * dependency — it opens correctly from disk years later) and, optionally, a
 * Markdown copy for archival.
 *
 * Every piece of message content is HTML-escaped before rendering. A transcript
 * is an untrusted document: it contains whatever a customer typed, so escaping
 * is a security control, not a formatting nicety.
 */

const fs = require('node:fs/promises');
const path = require('node:path');

const { env } = require('../config/env');
const { fetchMessages } = require('../utils/discord');
const { logger } = require('../utils/logger');
const { COLORS } = require('../config/branding');

const log = logger.child('transcripts');

/** Escape text for safe interpolation into HTML. */
function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/**
 * Render Discord markdown to HTML.
 * Input is escaped first, so no user markup can ever become live HTML.
 * @param {string} value
 */
function renderMarkdown(value) {
  let html = escapeHtml(value);

  // Code blocks first so their contents are not further transformed.
  const blocks = [];
  html = html.replace(/```(\w+)?\n?([\s\S]*?)```/g, (_, lang, code) => {
    blocks.push(`<pre class="block"${lang ? ` data-lang="${escapeHtml(lang)}"` : ''}><code>${code.trim()}</code></pre>`);
    return `\u0000BLOCK${blocks.length - 1}\u0000`;
  });

  html = html
    .replace(/`([^`\n]+)`/g, '<code>$1</code>')
    .replace(/\*\*\*([^*]+)\*\*\*/g, '<strong><em>$1</em></strong>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*\n]+)\*/g, '<em>$1</em>')
    .replace(/__([^_]+)__/g, '<u>$1</u>')
    .replace(/~~([^~]+)~~/g, '<s>$1</s>')
    .replace(/^&gt; (.+)$/gm, '<blockquote>$1</blockquote>')
    .replace(/&lt;@!?(\d+)&gt;/g, '<span class="mention">@$1</span>')
    .replace(/&lt;@&amp;(\d+)&gt;/g, '<span class="mention">@role</span>')
    .replace(/&lt;#(\d+)&gt;/g, '<span class="mention">#channel</span>')
    .replace(/&lt;t:(\d+)(?::\w)?&gt;/g, (_, epoch) => `<span class="ts">${new Date(Number(epoch) * 1000).toUTCString()}</span>`)
    .replace(/(https?:\/\/[^\s<"]+)/g, '<a href="$1" rel="noopener noreferrer nofollow" target="_blank">$1</a>')
    .replace(/\n/g, '<br>');

  return html.replace(/\u0000BLOCK(\d+)\u0000/g, (_, index) => blocks[Number(index)]);
}

/** Format a date for the transcript header and message rows. */
const formatDate = (date) => new Date(date).toISOString().replace('T', ' ').slice(0, 19).concat(' UTC');

/**
 * Build the complete HTML document.
 * @param {object} ticket the ticket document
 * @param {import('discord.js').Message[]} messages oldest-first
 * @param {object} meta
 */
function buildHtml(ticket, messages, meta) {
  const rows = messages.map((message) => {
    const author = message.author;
    const isBot = author?.bot;
    const attachments = [...(message.attachments?.values() ?? [])];
    const embedsHtml = (message.embeds ?? []).map((embed) => {
      const parts = [];
      if (embed.title) parts.push(`<div class="e-title">${escapeHtml(embed.title)}</div>`);
      if (embed.description) parts.push(`<div class="e-desc">${renderMarkdown(embed.description)}</div>`);
      for (const field of embed.fields ?? []) {
        parts.push(`<div class="e-field"><div class="e-name">${escapeHtml(field.name)}</div><div class="e-value">${renderMarkdown(field.value)}</div></div>`);
      }
      if (embed.footer?.text) parts.push(`<div class="e-footer">${escapeHtml(embed.footer.text)}</div>`);
      const color = typeof embed.color === 'number' ? `#${embed.color.toString(16).padStart(6, '0')}` : '#6366f1';
      return `<div class="embed" style="border-left-color:${color}">${parts.join('')}</div>`;
    }).join('');

    const attachmentsHtml = attachments.map((attachment) => {
      const url = escapeHtml(attachment.url);
      const name = escapeHtml(attachment.name ?? 'attachment');
      const isImage = /\.(png|jpe?g|gif|webp)$/i.test(attachment.name ?? '');
      return isImage
        ? `<a class="att" href="${url}" target="_blank" rel="noopener noreferrer"><img src="${url}" alt="${name}" loading="lazy"></a>`
        : `<a class="att file" href="${url}" target="_blank" rel="noopener noreferrer">📎 ${name}</a>`;
    }).join('');

    const content = message.content ? `<div class="content">${renderMarkdown(message.content)}</div>` : '';
    const avatar = escapeHtml(author?.displayAvatarURL?.({ size: 64, extension: 'png' }) ?? '');

    return `
      <div class="msg" id="m${escapeHtml(message.id)}">
        <img class="avatar" src="${avatar}" alt="" loading="lazy">
        <div class="body">
          <div class="head">
            <span class="name">${escapeHtml(author?.username ?? 'Unknown')}</span>
            ${isBot ? '<span class="tag">BOT</span>' : ''}
            <span class="time">${formatDate(message.createdAt)}</span>
          </div>
          ${content}
          ${embedsHtml}
          ${attachmentsHtml ? `<div class="atts">${attachmentsHtml}</div>` : ''}
        </div>
      </div>`;
  }).join('');

  const primary = `#${COLORS.primary.toString(16).padStart(6, '0')}`;
  const accent = `#${COLORS.accent.toString(16).padStart(6, '0')}`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>Ticket #${escapeHtml(String(ticket.number).padStart(4, '0'))} · Transcript</title>
<style>
  :root{--bg:#0f1117;--panel:#171923;--panel-2:#1e2130;--text:#e6e8f0;--muted:#8b90a5;--primary:${primary};--accent:${accent};--border:#262a3a}
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--text);font:15px/1.55 "Segoe UI",Inter,system-ui,-apple-system,sans-serif}
  .wrap{max-width:960px;margin:0 auto;padding:32px 20px 80px}
  header{background:linear-gradient(135deg,var(--primary),var(--accent));border-radius:14px;padding:26px 28px;margin-bottom:26px}
  header h1{margin:0 0 6px;font-size:22px;letter-spacing:.2px}
  header p{margin:0;opacity:.9;font-size:13px}
  .meta{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px;margin-bottom:28px}
  .card{background:var(--panel);border:1px solid var(--border);border-radius:10px;padding:12px 14px}
  .card .k{font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:var(--muted);margin-bottom:4px}
  .card .v{font-size:14px;font-weight:600;word-break:break-word}
  .log{background:var(--panel);border:1px solid var(--border);border-radius:12px;overflow:hidden}
  .msg{display:flex;gap:13px;padding:13px 18px;border-bottom:1px solid var(--border)}
  .msg:last-child{border-bottom:0}
  .msg:hover{background:var(--panel-2)}
  .avatar{width:38px;height:38px;border-radius:50%;flex:0 0 38px;background:var(--panel-2)}
  .body{min-width:0;flex:1}
  .head{display:flex;align-items:center;gap:8px;margin-bottom:3px;flex-wrap:wrap}
  .name{font-weight:600;color:#fff}
  .tag{background:var(--primary);color:#fff;font-size:10px;font-weight:700;padding:1px 5px;border-radius:4px;letter-spacing:.04em}
  .time{color:var(--muted);font-size:11px}
  .content{white-space:pre-wrap;word-break:break-word}
  .content a{color:#7dd3fc}
  code{background:#0b0d13;padding:1px 5px;border-radius:4px;font-family:ui-monospace,Consolas,monospace;font-size:13px}
  pre.block{background:#0b0d13;padding:12px 14px;border-radius:8px;overflow-x:auto;margin:8px 0;border:1px solid var(--border)}
  pre.block code{background:none;padding:0}
  blockquote{border-left:3px solid var(--muted);margin:4px 0;padding-left:10px;color:var(--muted)}
  .mention{background:rgba(99,102,241,.22);color:#c7d2fe;padding:0 3px;border-radius:3px}
  .embed{border-left:4px solid var(--primary);background:var(--panel-2);border-radius:0 6px 6px 0;padding:10px 14px;margin:8px 0;max-width:560px}
  .e-title{font-weight:700;margin-bottom:5px}
  .e-desc{font-size:14px;color:#cdd2e3}
  .e-field{margin-top:8px}
  .e-name{font-weight:600;font-size:13px}
  .e-value{font-size:13px;color:#cdd2e3}
  .e-footer{margin-top:9px;font-size:11px;color:var(--muted)}
  .atts{display:flex;flex-wrap:wrap;gap:8px;margin-top:8px}
  .att img{max-width:320px;max-height:240px;border-radius:8px;border:1px solid var(--border)}
  .att.file{background:var(--panel-2);border:1px solid var(--border);border-radius:8px;padding:8px 12px;color:#7dd3fc;text-decoration:none;font-size:13px}
  footer{margin-top:26px;text-align:center;color:var(--muted);font-size:12px}
  @media print{body{background:#fff;color:#000}.msg:hover{background:none}}
</style>
</head>
<body>
<div class="wrap">
  <header>
    <h1>Ticket #${escapeHtml(String(ticket.number).padStart(4, '0'))} — ${escapeHtml(ticket.typeLabel || ticket.type)}</h1>
    <p>${escapeHtml(meta.brandName)} · Support Transcript</p>
  </header>

  <div class="meta">
    <div class="card"><div class="k">Customer</div><div class="v">${escapeHtml(ticket.username || ticket.userId)}</div></div>
    <div class="card"><div class="k">Service</div><div class="v">${escapeHtml(ticket.typeLabel || ticket.type)}</div></div>
    <div class="card"><div class="k">Priority</div><div class="v">${escapeHtml(ticket.priority)}</div></div>
    <div class="card"><div class="k">Assigned</div><div class="v">${escapeHtml(ticket.assignedName || 'Unassigned')}</div></div>
    <div class="card"><div class="k">Opened</div><div class="v">${formatDate(ticket.createdAt)}</div></div>
    <div class="card"><div class="k">Closed</div><div class="v">${ticket.closedAt ? formatDate(ticket.closedAt) : '—'}</div></div>
    <div class="card"><div class="k">Messages</div><div class="v">${messages.length}</div></div>
    <div class="card"><div class="k">Closed by</div><div class="v">${escapeHtml(ticket.closedByName || '—')}</div></div>
  </div>

  <div class="log">${rows || '<div class="msg"><div class="body"><div class="content">No messages were exchanged in this ticket.</div></div></div>'}</div>

  <footer>Generated ${formatDate(new Date())} · ${escapeHtml(meta.brandName)}</footer>
</div>
</body>
</html>`;
}

/**
 * Build the Markdown transcript.
 * @param {object} ticket
 * @param {import('discord.js').Message[]} messages
 */
function buildMarkdown(ticket, messages) {
  const header = [
    `# Ticket #${String(ticket.number).padStart(4, '0')} — ${ticket.typeLabel || ticket.type}`,
    '',
    `- **Customer:** ${ticket.username || ticket.userId}`,
    `- **Priority:** ${ticket.priority}`,
    `- **Assigned:** ${ticket.assignedName || 'Unassigned'}`,
    `- **Opened:** ${formatDate(ticket.createdAt)}`,
    `- **Closed:** ${ticket.closedAt ? formatDate(ticket.closedAt) : '—'}`,
    `- **Messages:** ${messages.length}`,
    '',
    '---',
    '',
  ].join('\n');

  const body = messages.map((message) => {
    const lines = [`**${message.author?.username ?? 'Unknown'}**${message.author?.bot ? ' `[BOT]`' : ''} — ${formatDate(message.createdAt)}`];
    if (message.content) lines.push('', message.content);
    for (const embed of message.embeds ?? []) {
      if (embed.title) lines.push('', `> **${embed.title}**`);
      if (embed.description) lines.push(`> ${embed.description.replace(/\n/g, '\n> ')}`);
      for (const field of embed.fields ?? []) lines.push(`> **${field.name}:** ${field.value.replace(/\n/g, ' ')}`);
    }
    for (const attachment of message.attachments?.values() ?? []) lines.push('', `📎 [${attachment.name}](${attachment.url})`);
    return lines.join('\n');
  }).join('\n\n---\n\n');

  return `${header}${body}\n`;
}

/**
 * Generate transcripts for a ticket.
 *
 * @param {import('discord.js').TextChannel} channel
 * @param {object} ticket ticket document (hydrated or lean)
 * @param {{ markdown?: boolean, brandName?: string, limit?: number }} [options]
 * @returns {Promise<{ htmlPath: string, markdownPath: string, messageCount: number, url: string, sizeBytes: number }>}
 */
async function generate(channel, ticket, { markdown = false, brandName = 'Studio', limit = 2000 } = {}) {
  const messages = await fetchMessages(channel, limit);

  const safeNumber = String(ticket.number).padStart(4, '0');
  const stamp = new Date().toISOString().slice(0, 10);
  const baseName = `ticket-${safeNumber}-${stamp}`;
  const guildDir = path.join(env.transcriptDir, String(ticket.guildId));
  await fs.mkdir(guildDir, { recursive: true });

  const html = buildHtml(ticket, messages, { brandName });
  const htmlPath = path.join(guildDir, `${baseName}.html`);
  await fs.writeFile(htmlPath, html, 'utf8');

  let markdownPath = '';
  if (markdown) {
    markdownPath = path.join(guildDir, `${baseName}.md`);
    await fs.writeFile(markdownPath, buildMarkdown(ticket, messages), 'utf8');
  }

  const url = env.transcriptBaseUrl ? `${env.transcriptBaseUrl}/${ticket.guildId}/${baseName}.html` : '';
  log.info(`Generated transcript for ticket #${safeNumber}`, { messages: messages.length });

  return {
    htmlPath,
    markdownPath,
    messageCount: messages.length,
    url,
    sizeBytes: Buffer.byteLength(html, 'utf8'),
  };
}

/**
 * Read a transcript back off disk as an attachment buffer.
 * @param {string} filePath
 * @returns {Promise<{ buffer: Buffer, name: string }|null>}
 */
async function read(filePath) {
  if (!filePath) return null;
  // Never serve a path outside the transcript directory.
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(path.resolve(env.transcriptDir))) {
    log.warn('Blocked transcript read outside the transcript directory', { filePath });
    return null;
  }
  try {
    const buffer = await fs.readFile(resolved);
    return { buffer, name: path.basename(resolved) };
  } catch {
    return null;
  }
}

module.exports = { generate, read, escapeHtml, renderMarkdown, buildHtml, buildMarkdown };

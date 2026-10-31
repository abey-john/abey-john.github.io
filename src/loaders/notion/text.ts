import { downloadRemoteImage } from './images';

export function escapeHtml(str: string): string {
  return (str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

/**
 * Ensure all external hyperlinks in rendered HTML have target="_blank" and rel="noopener noreferrer".
 */
export function makeExternalLinksOpenInNewTab(html: string): string {
  if (!html) return html;
  return html.replace(
    /<a\s+([^>]*?)href=["'](https?:\/\/[^"']+)["']([^>]*?)>/gi,
    (match, before, href, after) => {
      if (/target=/i.test(match)) return match;
      const combined = `${before} ${after}`.replace(/\s+/g, ' ').trim();
      return `<a href="${href}" target="_blank" rel="noopener noreferrer"${combined ? ' ' + combined : ''}>`;
    }
  );
}

/**
 * Convert Notion rich text array to Markdown formatting.
 */
export function richTextToMarkdown(richTexts: any[]): string {
  if (!Array.isArray(richTexts)) return '';

  return richTexts
    .map((t) => {
      let text = t.plain_text || '';
      if (!text) return '';
      if (t.annotations?.code) text = `\`${text}\``;
      if (t.annotations?.bold) text = `**${text}**`;
      if (t.annotations?.italic) text = `*${text}*`;
      if (t.annotations?.strikethrough) text = `~~${text}~~`;
      if (t.href) {
        if (/^https?:\/\//i.test(t.href)) {
          text = `<a href="${t.href}" target="_blank" rel="noopener noreferrer">${text}</a>`;
        } else {
          text = `[${text}](${t.href})`;
        }
      }
      return text;
    })
    .join('');
}

/**
 * Convert Notion rich text array to safe, formatted HTML.
 * Supports Notion hyperlinks, bold, italics, strikethrough, code, and raw typed Markdown.
 */
export function richTextToHtml(richTexts: any[]): string {
  if (!Array.isArray(richTexts) || richTexts.length === 0) return '';

  let html = richTexts
    .map((t) => {
      let text = escapeHtml(t.plain_text || '');
      if (!text) return '';

      // Support Notion's native formatting annotations
      if (t.annotations?.code) text = `<code>${text}</code>`;
      if (t.annotations?.bold) text = `<strong>${text}</strong>`;
      if (t.annotations?.italic) text = `<em>${text}</em>`;
      if (t.annotations?.strikethrough) text = `<s>${text}</s>`;
      if (t.annotations?.underline) text = `<u>${text}</u>`;
      if (t.href) {
        const safeHref = escapeHtml(t.href);
        text = `<a href="${safeHref}" target="_blank" rel="noopener noreferrer">${text}</a>`;
      }
      return text;
    })
    .join('');

  // 1. Fix [text](<a href="url"...>...</a>) (when Notion auto-hyperlinked the URL inside typed [text](url))
  html = html.replace(
    /\[([^\]]+)\]\(<a\s+href="([^"]+)"[^>]*>.*?<\/a>\)/g,
    '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>'
  );

  // 2. Fix accidentally nested [text]([url](url))
  html = html.replace(
    /\[([^\]]+)\]\(\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)\)/g,
    '<a href="$3" target="_blank" rel="noopener noreferrer">$1</a>'
  );

  // 3. Fix standard typed markdown links [text](url)
  html = html.replace(
    /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
    '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>'
  );

  // 4. Raw markdown bold, italic, code
  html = html
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, '<em>$1</em>')
    .replace(/`([^`]+)`/g, '<code>$1</code>');

  return html;
}

/**
 * Convert Notion page blocks to Markdown text.
 */
export async function blocksToMarkdown(blocks: any[]): Promise<string> {
  const lines: string[] = [];

  for (const b of blocks) {
    // Skip instructional callout blocks added during bootstrap
    if (b.type === 'callout') {
      const calloutText = richTextToMarkdown(b.callout?.rich_text || []);
      if (
        calloutText.startsWith('Edit your bio') ||
        calloutText.startsWith('👋')
      ) {
        continue;
      }
      lines.push(`> ${calloutText}\n`);
      continue;
    }

    switch (b.type) {
      case 'paragraph': {
        const text = richTextToMarkdown(b.paragraph?.rich_text);
        lines.push(text ? `${text}\n` : '');
        break;
      }
      case 'heading_1':
        lines.push(`# ${richTextToMarkdown(b.heading_1?.rich_text)}\n`);
        break;
      case 'heading_2':
        lines.push(`## ${richTextToMarkdown(b.heading_2?.rich_text)}\n`);
        break;
      case 'heading_3':
        lines.push(`### ${richTextToMarkdown(b.heading_3?.rich_text)}\n`);
        break;
      case 'bulleted_list_item':
        lines.push(`* ${richTextToMarkdown(b.bulleted_list_item?.rich_text)}`);
        break;
      case 'numbered_list_item':
        lines.push(`1. ${richTextToMarkdown(b.numbered_list_item?.rich_text)}`);
        break;
      case 'quote':
        lines.push(`> ${richTextToMarkdown(b.quote?.rich_text)}\n`);
        break;
      case 'divider':
        lines.push('---\n');
        break;
      case 'image': {
        const rawUrl = b.image?.file?.url || b.image?.external?.url;
        const caption = richTextToMarkdown(b.image?.caption || []);
        if (rawUrl) {
          const localUrl = await downloadRemoteImage(rawUrl);
          if (caption) {
            lines.push(`\n![${caption}](${localUrl})\n*${caption}*\n`);
          } else {
            lines.push(`\n![Image](${localUrl})\n`);
          }
        }
        break;
      }
      case 'code': {
        const code =
          b.code?.rich_text?.map((t: any) => t.plain_text || '').join('') || '';
        const lang = b.code?.language || '';
        lines.push(`\`\`\`${lang}\n${code}\n\`\`\`\n`);
        break;
      }
      case 'to_do': {
        const checked = b.to_do?.checked ? '[x]' : '[ ]';
        lines.push(
          `- ${checked} ${richTextToMarkdown(b.to_do?.rich_text || [])}`
        );
        break;
      }
      default:
        break;
    }
  }

  return lines.join('\n').trim();
}

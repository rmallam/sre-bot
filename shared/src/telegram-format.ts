/**
 * Convert internal chat markdown (**bold**, `code`, ``` blocks) to Telegram HTML.
 */

const TELEGRAM_MAX = 4096;

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Map compose-style markdown to Telegram HTML (parse_mode: HTML). */
export function markdownToTelegramHtml(text: string): string {
  const preBlocks: string[] = [];
  let s = text.replace(/```\n?([\s\S]*?)```/g, (_, code: string) => {
    preBlocks.push(`<pre>${escapeHtml(code.replace(/\n$/, ''))}</pre>`);
    return `\u0000P${preBlocks.length - 1}\u0000`;
  });

  const inlineCodes: string[] = [];
  s = s.replace(/`([^`\n]+)`/g, (_, code: string) => {
    inlineCodes.push(`<code>${escapeHtml(code)}</code>`);
    return `\u0000C${inlineCodes.length - 1}\u0000`;
  });

  const bolds: string[] = [];
  s = s.replace(/\*\*([^*\n]+)\*\*/g, (_, bold: string) => {
    bolds.push(`<b>${escapeHtml(bold)}</b>`);
    return `\u0000B${bolds.length - 1}\u0000`;
  });

  s = escapeHtml(s);
  s = s.replace(/\u0000P(\d+)\u0000/g, (_, i) => preBlocks[Number(i)]!);
  s = s.replace(/\u0000C(\d+)\u0000/g, (_, i) => inlineCodes[Number(i)]!);
  s = s.replace(/\u0000B(\d+)\u0000/g, (_, i) => bolds[Number(i)]!);
  return s;
}

export function splitTelegramMessage(text: string, max = TELEGRAM_MAX): string[] {
  if (text.length <= max) return [text];
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > max) {
    let cut = rest.lastIndexOf('\n', max);
    if (cut < Math.floor(max * 0.4)) cut = max;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut).trimStart();
  }
  if (rest.length) chunks.push(rest);
  return chunks;
}

export function plainTelegramFallback(text: string): string {
  return text
    .replace(/```\n?([\s\S]*?)```/g, (_, code: string) => code.trim())
    .replace(/\*\*([^*\n]+)\*\*/g, '$1')
    .replace(/`([^`\n]+)`/g, '$1');
}

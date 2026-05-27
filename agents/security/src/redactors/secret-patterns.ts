export const REDACTED = '[REDACTED]';

export const SECRET_PATTERNS: { name: string; pattern: RegExp; severity: 'HIGH' | 'MEDIUM' }[] = [
  { name: 'aws_key', pattern: /AKIA[0-9A-Z]{16}/g, severity: 'HIGH' },
  { name: 'bearer', pattern: /Bearer\s+[A-Za-z0-9\-._~+/]+=*/gi, severity: 'HIGH' },
  { name: 'jwt', pattern: /eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, severity: 'HIGH' },
  { name: 'password', pattern: /(?:password|passwd|pwd)\s*[:=]\s*[^\s'"]+/gi, severity: 'HIGH' },
  { name: 'pem', pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g, severity: 'HIGH' },
  { name: 'prompt_injection', pattern: /(?:ignore (?:all )?previous|system:\s|you are now)/gi, severity: 'MEDIUM' },
];

export function redactString(input: string): { text: string; hits: string[] } {
  let text = input;
  const hits: string[] = [];
  for (const { name, pattern } of SECRET_PATTERNS) {
    if (pattern.test(text)) {
      hits.push(name);
      text = text.replace(new RegExp(pattern.source, pattern.flags), REDACTED);
    }
    pattern.lastIndex = 0;
  }
  return { text, hits };
}

export function highEntropyBase64(input: string): boolean {
  const matches = input.match(/[A-Za-z0-9+/]{40,}={0,2}/g) ?? [];
  return matches.some((m) => {
    const unique = new Set(m).size;
    return m.length >= 40 && unique / m.length > 0.6;
  });
}

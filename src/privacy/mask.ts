import { stripUntrustedChars } from './untrusted';

const DIGIT_SEP = String.raw`\s\u00A0\u2011\u2013\u2014\u2212\-`;
const SEP_RUN = `[.${DIGIT_SEP}]{0,2}`;
const CPF_IN_TEXT = new RegExp(String.raw`(?<!\d)\d{3}(?:${SEP_RUN}\d{3}){2}${SEP_RUN}\d{2}(?!\d)`, 'g');
const ACCOUNT_IN_TEXT = /(?<!\d)\d{2,12}(?:[.\s]{1,2}\d{2,12}){0,4}[.\s]?-\d(?!\d)/g;
const CARD_CONTINUOUS = /(?<!\d)\d{13,19}(?!\d)/g;
const CARD_GROUPS = new RegExp(String.raw`(?<!\d)(?:\d{4}[${DIGIT_SEP}]){3}\d{4}(?!\d)`, 'g');
const CARD_GROUPED = new RegExp(String.raw`^(?:\d{4}[${DIGIT_SEP}]){3}\d{4}$`);
const DATE_OR_TIME = /\d{4}-\d{2}-\d{2}|\d{2}-\d{2}-\d{4}|\d{2}-\d{2}-\d{2}/;
const LONG_DIGITS = /(?<!\d)\d{8,12}(?!\d)/g;
const CARD_CONTEXT = /(?<![\p{L}\p{N}])(?:cart[aã]o|card|cc|cred|d[eé]bito|final|nº|n[uú]mero|pan)(?![\p{L}\p{N}])/iu;
const CARD_CONTEXT_WINDOW = 20;

export function onlyDigits(value: string): string {
  return value.replace(/\D/g, '');
}

export function isValidCpf(value: string): boolean {
  const digits = onlyDigits(value);
  if (!/^\d{11}$/.test(digits)) return false;
  if (/^(\d)\1{10}$/.test(digits)) return false;
  const numbers = digits.split('').map(Number);
  const digitAt = (length: number): number => {
    const sum = numbers.slice(0, length).reduce((total, digit, index) => total + digit * (length + 1 - index), 0);
    const mod = (sum * 10) % 11;
    return mod === 10 ? 0 : mod;
  };
  return digitAt(9) === numbers[9] && digitAt(10) === numbers[10];
}

export function maskCpf(value: string): string {
  const digits = onlyDigits(value);
  if (digits.length !== 11) return '***.***.***-**';
  return `***.***.***-${digits.slice(9)}`;
}

export function maskAccountNumber(value: string): string {
  const digits = onlyDigits(value);
  if (digits.length === 0) return '****';
  let kept = 0;
  const visible = Math.min(4, digits.length);
  const chars = [...value];
  const out = new Array<string>(chars.length);
  for (let index = chars.length - 1; index >= 0; index -= 1) {
    const char = chars[index] ?? '';
    if (/\d/.test(char)) {
      if (kept < visible) {
        out[index] = char;
        kept += 1;
      } else {
        out[index] = '*';
      }
    } else if (/[./\-\s\u00A0\u2011\u2013\u2014\u2212]/.test(char)) {
      out[index] = char;
    } else {
      out[index] = '*';
    }
  }
  return out.join('');
}

export function maskCpfInText(value: string): string {
  return value.replace(CPF_IN_TEXT, (match) => (isValidCpf(match) ? maskCpf(match) : match));
}

const MASK_INPUT_LIMIT = 500;

export function maskSensitiveFreeText(value: string): string {
  const clean = normalizeMaskSeparators(stripUntrustedChars(value.slice(0, MASK_INPUT_LIMIT)));
  return maskCpfInText(clean)
    .replace(ACCOUNT_IN_TEXT, (match) => (accountDigits(match) ? maskAccountNumber(match) : match))
    .replace(CARD_GROUPS, (match, offset: number, full: string) =>
      shouldMaskCard(match, full, offset) ? maskAccountNumber(match) : match,
    )
    .replace(CARD_CONTINUOUS, (match, offset: number, full: string) =>
      shouldMaskCard(match, full, offset) ? maskAccountNumber(match) : match,
    )
    .replace(LONG_DIGITS, (match) => maskAccountNumber(match));
}

function shouldMaskCard(value: string, full: string, offset: number): boolean {
  if (DATE_OR_TIME.test(value)) return false;
  const digits = onlyDigits(value);
  if (!cardDigits(digits)) return false;
  return CARD_GROUPED.test(value) || passesLuhn(digits) || cardContextBefore(full, offset);
}

function cardContextBefore(value: string, offset: number): boolean {
  const start = Math.max(0, offset - CARD_CONTEXT_WINDOW);
  return CARD_CONTEXT.test(value.slice(start, offset));
}

function passesLuhn(digits: string): boolean {
  let sum = 0;
  let doubleDigit = false;
  for (let index = digits.length - 1; index >= 0; index -= 1) {
    let digit = Number(digits[index]);
    if (doubleDigit) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    doubleDigit = !doubleDigit;
  }
  return sum % 10 === 0;
}

function normalizeMaskSeparators(value: string): string {
  return value
    .replace(/\u00A0/g, ' ')
    .replace(/[\u00AD\u2010\u2011\u2012\u2013\u2014\u2212]/g, '-')
    .replace(/ {2,}/g, ' ');
}

function accountDigits(value: string): boolean {
  const digits = onlyDigits(value);
  return digits.length >= 6 && digits.length <= 14;
}

function cardDigits(digits: string): boolean {
  return digits.length >= 13 && digits.length <= 19;
}

export function maskDocument(type: string | null | undefined, value: string | null | undefined): string | null {
  if (!value) return null;
  if ((type ?? '').toUpperCase() === 'CPF' || isValidCpf(value)) return maskCpf(value);
  return maskAccountNumber(value);
}

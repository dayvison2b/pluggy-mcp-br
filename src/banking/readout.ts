import type { NormalizedAccount, NormalizedBill, NormalizedTransaction } from './types';
import { isOutflow } from './types';
import { calendarDaysBetween, isCalendarDay, transactionDay } from './calendar';
import { formatReais, money } from '../privacy/untrusted';

const NOT_UTILITY = String.raw`(?!\s+de\s+(?:luz|energia|[aá]gua|g[aá]s|telefone|internet|boleto)\b)`;
const BILL_PAYMENT = new RegExp(
  [
    String.raw`p(?:ag(?:amento|to)|gto)\.?\s+(?:d[aeo]\s+)?fatura(?!\p{L})` + NOT_UTILITY,
    String.raw`p(?:ag(?:amento|to)|gto)\.?\s+(?:d[aeo]\s+)?cart[aã]o(?!\p{L})`,
    String.raw`fatura\s+(?:d[aeo]\s+)?cart[aã]o(?!\p{L})`,
    String.raw`fatura\s+paga(?!\p{L})`,
    String.raw`credit\s+card\s+payment(?!\p{L})`,
    String.raw`pagamento[\s_]+recebido(?!\p{L})`,
    String.raw`pagamento[\s_]+efetuado(?!\p{L})`,
    String.raw`pagamento[\s_]+fatura(?!\p{L})`,
  ].join('|'),
  'iu',
);
const REFUND_TEXT = /\b(?:estorno|cash\s*back|reembolso|devolu[cç][aã]o)\b/iu;
const MERCHANT_BILL = /\b(?:vivo|claro|tim|oi|net|sky|enel|cemig|copel|light|sabesp|comgas)\b/iu;
const OWN_TRANSFER = /\b(?:transfer[eê]ncia|transferencia|ted|tef|mesma\s+titularidade|resgate|aplica[cç][aã]o)\b/iu;
const TRANSFER_CATEGORY = /\b(?:transfers?|transfer[eê]ncia|ted|tef)\b/iu;
const GENERIC_WORDS = new Set([
  'pix', 'ted', 'tef', 'doc', 'transferencia', 'pagamento', 'para', 'de', 'da', 'do', 'das', 'dos',
  'conta', 'corrente', 'poupanca', 'resgate', 'aplicacao', 'mesma', 'titularidade', 'enviado',
  'enviada', 'recebido', 'recebida', 'envio', 'credito', 'debito', 'banco', 'salario', 'tarifa',
  'entre', 'contas', 'propria', 'proprias', 'automatico', 'automatica', 'interno', 'interna',
  'fatura', 'cartao',
]);
const PAIR_WINDOW_DAYS = 5;

export interface OpenBill {
  valueCents: number;
  dueDate: string;
  minimumPaymentCents: number | null;
  days: number;
}

export interface CardDue {
  label: 'open/next bill' | 'spent so far';
  valueCents: number;
  balanceCents: number;
  dueDate: string | null;
  minimumPaymentCents: number | null;
  days: number | null;
  nextBill: OpenBill | null;
  futureBills: OpenBill[];
  note: string;
}

export function isCheckingAccount(account: NormalizedAccount): boolean {
  return account.type === 'BANK' && account.subtype === 'CHECKING_ACCOUNT';
}

export function isCreditAccount(account: NormalizedAccount): boolean {
  return account.type === 'CREDIT';
}

export function amountCents(value: number): number {
  return Math.round(value * 100);
}

export function cardDue(account: NormalizedAccount, bills: readonly NormalizedBill[], today: string): CardDue {
  const upcoming = bills
    .filter((bill) => bill.dueDate !== null && isCalendarDay(bill.dueDate) && bill.dueDate >= today)
    .sort((left, right) => {
      const byDate = (left.dueDate ?? '').localeCompare(right.dueDate ?? '');
      if (byDate !== 0) return byDate;
      const byClose = (right.closingDate ?? '').localeCompare(left.closingDate ?? '');
      if (byClose !== 0) return byClose;
      const byAmount = amountCents(right.totalAmount) - amountCents(left.totalAmount);
      if (byAmount !== 0) return byAmount;
      return left.id.localeCompare(right.id);
    });
  const futureBills: OpenBill[] = upcoming.flatMap((bill) => {
    if (!bill.dueDate) return [];
    return [{
      valueCents: amountCents(bill.totalAmount),
      dueDate: bill.dueDate,
      minimumPaymentCents: bill.minimumPayment === null ? null : amountCents(bill.minimumPayment),
      days: calendarDaysBetween(today, bill.dueDate),
    }];
  });
  const billsTotalCents = futureBills.reduce((total, bill) => total + bill.valueCents, 0);
  const balanceCents = amountCents(account.balance);
  const debtBalanceCents = Math.max(balanceCents, 0);
  const valueCents = Math.max(billsTotalCents, debtBalanceCents);
  const next = futureBills[0] ?? null;
  if (next) {
    const extraBills = futureBills.length > 1
      ? ` The ${futureBills.length} future bills add up to ${formatReais(money(billsTotalCents / 100))}.`
      : '';
    return {
      label: 'open/next bill',
      valueCents,
      balanceCents,
      dueDate: next.dueDate,
      minimumPaymentCents: next.minimumPaymentCents,
      days: next.days,
      nextBill: next,
      futureBills,
      note:
        `Next bill of ${formatReais(money(next.valueCents / 100))} due on ${next.dueDate}.` +
        extraBills +
        ` Card balance: ${formatReais(money(balanceCents / 100))}.` +
        ` Amount to pay: ${formatReais(money(valueCents / 100))}, the larger of the sum of the future bills and the debt balance.` +
        ' Days until due use the America/Sao_Paulo calendar.' +
        ' Pluggy does not report whether the bill has already been paid.',
    };
  }
  const past = bills.some((bill) => bill.dueDate !== null && isCalendarDay(bill.dueDate) && bill.dueDate < today);
  return {
    label: 'spent so far',
    valueCents: debtBalanceCents,
    balanceCents,
    dueDate: null,
    minimumPaymentCents: null,
    days: null,
    nextBill: null,
    futureBills,
    note:
      'Pluggy did not bring the open bill. In Open Finance it only appears when it closes or is due, and that depends on the bank. ' +
      `The amount is the card balance (${formatReais(money(balanceCents / 100))}), labeled as spent so far. There is no due date because none was reported.` +
      (past ? ' The bills received are already overdue and were not used as a date.' : ''),
  };
}

export function sumAmountCents(transactions: readonly NormalizedTransaction[]): number {
  return transactions.reduce((total, transaction) => total + amountCents(Math.abs(transaction.amount)), 0);
}

export interface PaymentPair {
  debit: NormalizedTransaction;
  credit: NormalizedTransaction;
}

export interface MonthSplit {
  inflows: NormalizedTransaction[];
  outflows: NormalizedTransaction[];
  excludedPayments: NormalizedTransaction[];
  pairs: PaymentPair[];
  refunds: NormalizedTransaction[];
  unrecognizedCredits: NormalizedTransaction[];
  internalTransfers: PaymentPair[];
  possibleTransfers: PaymentPair[];
  appliedInvestments: NormalizedTransaction[];
  redeemedInvestments: NormalizedTransaction[];
  earnings: NormalizedTransaction[];
  earningsNotSeparated: boolean;
}

const INVESTMENT_CATEGORIES = new Set([
  'investments',
  'automatic investment',
  'fixed income',
  'mutual funds',
  'variable income',
]);

const INVESTMENT_PRODUCT = String.raw`\b(?:fundos?|cdb|rdb|lci|lca|tesouro|investimentos?|automatica|financeira|poupanca|caixinhas?|cofrinhos?)\b`;
const INVESTMENT_PRODUCT_RE = new RegExp(INVESTMENT_PRODUCT);
const STRICT_PRODUCT_RE = /\b(?:previdencia privada|fundo de investimento|tesouro(?:\s+(?:direto|selic|ipca|prefixado))?|fundos?|cdb|rdb|lci|lca|poupanca)\b/g;
const POT_RE = /\b(?:caixinhas?|cofrinhos?|fundos?|tesouro(?:\s+(?:direto|selic|ipca|prefixado))?)\b/g;
const THIRD_PARTY_RE = /\b(?:pix|ted|doc|ltda|eireli|mei|loja|pontos|milhas|livelo|smiles|tarifa|imposto|iof|pagto|pagamento)\b|\bcash\s*back\b|\bs\/a\b/;
const YIELD_TEXT = /\b(?:rendimentos?|juros|dividendos?|dividends?|interest|proceeds)\b/;
const YIELD_CATEGORY = 'proceeds interests and dividends';
const REDEMPTION_WORD = /\bresgates?\b|\bresgatad[oa]s?\b|\bres\s+aplic\b/;
const KNOWN_TOKENS = new Set([
  'de', 'do', 'da', 'dos', 'das', 'em', 'para', 'e', 'o', 'a', 'os', 'as',
  'automatico', 'automatica', 'juros', 'rendimento', 'rendimentos', 'dividendo', 'dividendos',
  'vencimento', 'venc', 'ipca', 'selic', 'prefixado', 'direto', 'aplicacao', 'aplicado', 'aplicar', 'aplic',
  'aut', 'financ', 'financeira', 'financeiro', 'renda', 'fixa', 'dinheiro', 'guardado', 'guardar', 'aporte',
  'resgate', 'resgates', 'resgatado', 'resgatada', 'resgatados', 'resgatadas', 'mais', 'contamax', 'investfacil',
  'nubank', 'bb', 'fic', 'previdencia', 'privada', 'compra', 'auto', 'investimento', 'investimentos',
]);

export function splitMonth(transactions: readonly NormalizedTransaction[], accounts: readonly NormalizedAccount[]): MonthSplit {
  const split = splitCashflow(transactions, accounts);
  const byId = new Map(accounts.map((account) => [account.id, account]));
  const appliedInvestments = split.outflows.filter((transaction) => isInvestmentApplication(transaction, byId.get(transaction.accountId)));
  const applied = new Set(appliedInvestments);
  const redeemedInvestments = split.inflows.filter((transaction) => isInvestmentRedemption(transaction, byId.get(transaction.accountId)));
  const redeemed = new Set(redeemedInvestments);
  const inflows = split.inflows.filter((transaction) => !redeemed.has(transaction));
  return {
    ...split,
    outflows: split.outflows.filter((transaction) => !applied.has(transaction)),
    inflows,
    appliedInvestments,
    redeemedInvestments,
    earnings: inflows.filter((transaction) => isYield(transaction)),
    earningsNotSeparated: redeemedInvestments.some((transaction) => isYield(transaction)),
  };
}

function splitCashflow(transactions: readonly NormalizedTransaction[], accounts: readonly NormalizedAccount[]): Omit<MonthSplit, 'appliedInvestments' | 'redeemedInvestments' | 'earnings' | 'earningsNotSeparated'> {
  const cardIds = new Set(accounts.filter(isCreditAccount).map((account) => account.id));
  const checkingIds = new Set(accounts.filter(isCheckingAccount).map((account) => account.id));
  const isCard = (transaction: NormalizedTransaction) => cardIds.has(transaction.accountId);
  const pairs = cardIds.size === 0
    ? []
    : pairMovements(
        transactions.filter((transaction) => checkingIds.has(transaction.accountId) && isOutflow(transaction) && isCardBillText(transaction)),
        transactions.filter((transaction) => isCard(transaction) && !isOutflow(transaction) && isCardBillText(transaction)),
      );
  const excluded = new Set(pairs.map((pair) => pair.debit));
  const bankIds = new Set(accounts.filter((account) => account.type === 'BANK' || account.type === 'INVESTMENT').map((account) => account.id));
  const bankDebits = transactions.filter((transaction) => bankIds.has(transaction.accountId) && isOutflow(transaction) && !excluded.has(transaction));
  const bankCredits = transactions.filter((transaction) => bankIds.has(transaction.accountId) && !isOutflow(transaction));
  const internalTransfers = pairMovements(bankDebits, bankCredits, confidentOwnTransfer);
  const pairedDebits = new Set(internalTransfers.map((pair) => pair.debit));
  const pairedCredits = new Set(internalTransfers.map((pair) => pair.credit));
  const possibleTransfers = pairMovements(
    bankDebits.filter((transaction) => !pairedDebits.has(transaction)),
    bankCredits.filter((transaction) => !pairedCredits.has(transaction)),
  );
  const inflows: NormalizedTransaction[] = [];
  const outflows: NormalizedTransaction[] = [];
  const excludedPayments: NormalizedTransaction[] = [];
  const refunds: NormalizedTransaction[] = [];
  const unrecognizedCredits: NormalizedTransaction[] = [];
  for (const transaction of transactions) {
    if (isOutflow(transaction)) {
      if (excluded.has(transaction)) excludedPayments.push(transaction);
      else if (pairedDebits.has(transaction)) continue;
      else outflows.push(transaction);
      continue;
    }
    if (isCard(transaction)) {
      if (isCardBillText(transaction)) continue;
      if (isRefundText(transaction)) refunds.push(transaction);
      else unrecognizedCredits.push(transaction);
      continue;
    }
    if (pairedCredits.has(transaction)) continue;
    inflows.push(transaction);
  }
  return {
    inflows,
    outflows,
    excludedPayments,
    pairs,
    refunds,
    unrecognizedCredits,
    internalTransfers,
    possibleTransfers,
  };
}

function isInvestmentApplication(transaction: NormalizedTransaction, account: NormalizedAccount | undefined): boolean {
  if (!isOutflow(transaction) || !isInvestmentAccount(account)) return false;
  const text = foldText(transaction.description);
  if (blocksThirdParty(text, transaction.description)) return false;
  if (explicitApplication(text)) return true;
  return isInvestmentCategory(transaction.category);
}

function isInvestmentRedemption(transaction: NormalizedTransaction, account: NormalizedAccount | undefined): boolean {
  if (isOutflow(transaction) || !isInvestmentAccount(account)) return false;
  const text = foldText(transaction.description);
  if (blocksThirdParty(text, transaction.description)) return false;
  return REDEMPTION_WORD.test(text);
}

function isYield(transaction: NormalizedTransaction): boolean {
  if (isOutflow(transaction)) return false;
  if (foldText(transaction.category ?? '') === YIELD_CATEGORY) return true;
  return YIELD_TEXT.test(foldText(movementText(transaction)));
}

function isInvestmentAccount(account: NormalizedAccount | undefined): boolean {
  return account?.type === 'BANK' || account?.type === 'INVESTMENT';
}

function isInvestmentCategory(category: string | null | undefined): boolean {
  const key = foldText(category ?? '');
  return key.length > 0 && INVESTMENT_CATEGORIES.has(key);
}

function blocksThirdParty(text: string, original: string): boolean {
  if (THIRD_PARTY_RE.test(text)) return true;
  if (/\bME\s*$/.test(original.trim()) && commercialTokens(text).length > 0) return true;
  return potFollowedByCommercialName(text);
}

function explicitApplication(text: string): boolean {
  if (/\b(?:aplicacao|aplicado|aplicar)\b/.test(text) || /\baplic\b/.test(text)) return true;
  if (text === 'dinheiro guardado') return true;
  if (/\b(?:aporte|guardado|guardar|investimentos?)\b/.test(text) && strictProductAtEnd(text)) return true;
  return /\bcompra\b/.test(text) && strictProductAtEnd(text);
}

function strictProductAtEnd(text: string): boolean {
  STRICT_PRODUCT_RE.lastIndex = 0;
  let last: RegExpMatchArray | null = null;
  for (const match of text.matchAll(STRICT_PRODUCT_RE)) last = match;
  if (!last || last.index === undefined) return false;
  return tailIsAllowed(text.slice(last.index + last[0].length));
}

function potFollowedByCommercialName(text: string): boolean {
  POT_RE.lastIndex = 0;
  for (const match of text.matchAll(POT_RE)) {
    if (!tailIsAllowed(text.slice(match.index + match[0].length))) return true;
  }
  return false;
}

function tailIsAllowed(tail: string): boolean {
  const tokens = tail.match(/[a-z0-9]+/g) ?? [];
  return tokens.every((token) => KNOWN_TOKENS.has(token) || /^\d+(?:[.,]\d+)?$/.test(token) || /^[a-z]{2,4}$/.test(token));
}

function commercialTokens(text: string): string[] {
  return (text.match(/[a-z]{3,}/g) ?? []).filter((word) => !KNOWN_TOKENS.has(word) && !INVESTMENT_PRODUCT_RE.test(word));
}

function movementText(transaction: NormalizedTransaction): string {
  return `${transaction.description} ${transaction.category ?? ''}`;
}

function foldText(value: string): string {
  return value.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/\s+/g, ' ').trim();
}

function isRefundText(transaction: NormalizedTransaction): boolean {
  return REFUND_TEXT.test(movementText(transaction));
}

function isCardBillText(transaction: NormalizedTransaction): boolean {
  const text = movementText(transaction);
  if (MERCHANT_BILL.test(text)) return false;
  return BILL_PAYMENT.test(text);
}

function confidentOwnTransfer(debit: NormalizedTransaction, credit: NormalizedTransaction): boolean {
  const bothText = ownTransferText(debit) && ownTransferText(credit);
  const bothCategory = transferCategory(debit) && transferCategory(credit);
  if (!bothText && !bothCategory) return false;
  return !conflictingNames(debit.description, credit.description);
}

function ownTransferText(transaction: NormalizedTransaction): boolean {
  return OWN_TRANSFER.test(movementText(transaction));
}

function transferCategory(transaction: NormalizedTransaction): boolean {
  return TRANSFER_CATEGORY.test(transaction.category ?? '');
}

function conflictingNames(left: string, right: string): boolean {
  const fromLeft = personTokens(left);
  const fromRight = personTokens(right);
  if (fromLeft.length === 0 && fromRight.length === 0) return false;
  if (fromLeft.length === 0 || fromRight.length === 0) return true;
  const rightSet = new Set(fromRight);
  const leftSet = new Set(fromLeft);
  return fromLeft.some((word) => !rightSet.has(word)) || fromRight.some((word) => !leftSet.has(word));
}

function personTokens(description: string): string[] {
  const folded = description.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
  return (folded.match(/[a-z]{3,}/g) ?? []).filter((word) => !GENERIC_WORDS.has(word));
}

function pairMovements(
  debits: readonly NormalizedTransaction[],
  credits: readonly NormalizedTransaction[],
  accept: (debit: NormalizedTransaction, credit: NormalizedTransaction) => boolean = () => true,
): PaymentPair[] {
  const used = new Set<string>();
  const pairs: PaymentPair[] = [];
  const ordered = [...debits].sort((left, right) => left.date.localeCompare(right.date) || left.id.localeCompare(right.id));
  for (const debit of ordered) {
    const cents = amountCents(Math.abs(debit.amount));
    let best: NormalizedTransaction | null = null;
    let bestDays = PAIR_WINDOW_DAYS + 1;
    for (const credit of credits) {
      if (used.has(credit.id) || credit.accountId === debit.accountId || !accept(debit, credit)) continue;
      if (amountCents(Math.abs(credit.amount)) !== cents) continue;
      const apart = daysApart(debit.date, credit.date);
      if (apart > PAIR_WINDOW_DAYS || apart > bestDays) continue;
      if (apart === bestDays && best && credit.id.localeCompare(best.id) > 0) continue;
      best = credit;
      bestDays = apart;
    }
    if (best) {
      used.add(best.id);
      pairs.push({ debit, credit: best });
    }
  }
  return pairs;
}

function daysApart(left: string, right: string): number {
  const start = transactionDay(left);
  const end = transactionDay(right);
  if (!isCalendarDay(start) || !isCalendarDay(end)) return PAIR_WINDOW_DAYS + 1;
  return Math.abs(calendarDaysBetween(start, end));
}

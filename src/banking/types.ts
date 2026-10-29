import { transactionDay } from './calendar';

export interface NormalizedAccount {
  id: string;
  itemId: string;
  type: string;
  subtype: string;
  name: string;
  institution: string | null;
  balance: number;
  currencyCode: string;
  number: string | null;
  taxNumber: string | null;
  owner: string | null;
  creditLimit: number | null;
  availableCreditLimit: number | null;
}

export interface NormalizedTransaction {
  id: string;
  accountId: string;
  date: string;
  amount: number;
  type: string;
  currencyCode: string;
  amountInAccountCurrency?: number | null;
  category: string | null;
  status: string | null;
  description: string;
  paymentMethod: string | null;
  payerName: string | null;
  receiverName: string | null;
  payerDocumentType: string | null;
  payerDocument: string | null;
  receiverDocumentType: string | null;
  receiverDocument: string | null;
  payerAccount: string | null;
  receiverAccount: string | null;
}

export interface NormalizedBill {
  id: string;
  accountId: string;
  dueDate: string | null;
  closingDate: string | null;
  totalAmount: number;
  minimumPayment: number | null;
  currencyCode: string;
}

export interface NormalizedItem {
  itemId: string;
  connectorName: string | null;
  status: string | null;
  consentExpiresAt: string | null;
  lastUpdatedAt: string | null;
  errorCode: string | null;
}

export interface NormalizedInvestmentTransaction {
  description: string;
}

export interface NormalizedInvestment {
  id: string;
  itemId: string;
  name: string;
  type: string;
  subtype: string;
  balance: number;
  currencyCode: string;
  amountOriginal: number | null;
  amountProfit: number | null;
  amountWithdrawal: number | null;
  rate: number | null;
  rateType: string | null;
  fixedAnnualRate: number | null;
  annualRate: number | null;
  lastMonthRate: number | null;
  lastTwelveMonthsRate: number | null;
  issuer: string | null;
  purchaseDate: string | null;
  dueDate: string | null;
  status: string | null;
  institution: string | null;
  transactions: NormalizedInvestmentTransaction[];
}

export interface Paged<T> {
  rows: T[];
  truncated: boolean;
}

export interface BankingSource {
  readonly mode: 'live';
  listAccounts(): Promise<Paged<NormalizedAccount>>;
  listTransactions(query: { from: string; to: string; accountId?: string }): Promise<Paged<NormalizedTransaction>>;
  listBills(accountId: string): Promise<Paged<NormalizedBill>>;
  listInvestments(): Promise<Paged<NormalizedInvestment>>;
  connectionStatus(): Promise<NormalizedItem[]>;
}

export function canonicalCurrency(code: string | null | undefined): string | null {
  if (typeof code !== 'string') return null;
  const trimmed = code.replace(/[\u200B-\u200D\uFEFF]/g, '').trim();
  if (!trimmed) return null;
  return trimmed.toUpperCase();
}

export function isOutflow(transaction: NormalizedTransaction): boolean {
  return transaction.type.toUpperCase() === 'DEBIT';
}

export function signedAmount(transaction: NormalizedTransaction): number {
  const absolute = Math.abs(transaction.amount);
  return isOutflow(transaction) ? -absolute : absolute;
}

export function calendarDay(value: string): string {
  return transactionDay(value);
}

export function inRange(date: string, from: string, to: string): boolean {
  const day = calendarDay(date);
  return day >= from && day <= to;
}

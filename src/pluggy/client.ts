import { PLUGGY_API_ORIGIN } from '../config';
import { TtlCache } from '../cache';
import { canonicalCurrency, type NormalizedAccount, type NormalizedBill, type NormalizedInvestment, type NormalizedItem, type NormalizedTransaction, type Paged } from '../banking/types';

const API_KEY_TTL_MS = 110 * 60 * 1000;
export const PAGE_CAP = 20;

export interface PluggyClientOptions {
  clientId: string;
  clientSecret: string;
  itemIds: string[];
  fetchImpl?: typeof fetch;
  now?: () => number;
  cache?: TtlCache;
  cacheTtlMs?: number;
}

interface ApiKeyState {
  apiKey: string;
  issuedAt: number;
}

export class PluggyClient {
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly cache: TtlCache;
  private readonly cacheTtlMs: number;
  private apiKeyState: ApiKeyState | null = null;
  private apiKeyInflight: Promise<string> | null = null;

  constructor(private readonly options: PluggyClientOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? Date.now;
    this.cache = options.cache ?? new TtlCache(this.now);
    this.cacheTtlMs = options.cacheTtlMs ?? 60_000;
  }

  async listAccounts(): Promise<Paged<NormalizedAccount>> {
    const accounts: NormalizedAccount[] = [];
    let truncated = false;
    for (const itemId of this.options.itemIds) {
      const page = await this.getPages<RawAccount>(`/accounts?itemId=${encodeURIComponent(itemId)}`);
      if (page.truncated) truncated = true;
      accounts.push(
        ...page.rows
          .map((account) => normalizeAccount(account, itemId))
          .filter((account) => account.id.length > 0 && account.itemId === itemId),
      );
    }
    return { rows: accounts, truncated };
  }

  async listTransactions(accountId: string, from: string, to: string): Promise<Paged<NormalizedTransaction>> {
    const params = new URLSearchParams({ accountId, dateFrom: from, dateTo: to });
    const page = await this.getCursor<RawTransaction>('/v2/transactions', params);
    return { rows: page.rows.map(normalizeTransaction), truncated: page.truncated };
  }

  async listBills(accountId: string): Promise<Paged<NormalizedBill>> {
    const page = await this.getPages<RawBill>(`/bills?accountId=${encodeURIComponent(accountId)}`);
    return { rows: page.rows.map((bill) => normalizeBill(bill, accountId)), truncated: page.truncated };
  }

  async listInvestments(): Promise<Paged<NormalizedInvestment>> {
    const investments: NormalizedInvestment[] = [];
    let truncated = false;
    for (const itemId of this.options.itemIds) {
      const page = await this.getPages<RawInvestment>(`/investments?itemId=${encodeURIComponent(itemId)}`);
      if (page.truncated) truncated = true;
      investments.push(
        ...page.rows
          .map((investment) => normalizeInvestment(investment, itemId))
          .filter((investment) => investment.id.length > 0 && investment.itemId === itemId),
      );
    }
    return { rows: investments, truncated };
  }

  async getItem(itemId: string): Promise<NormalizedItem> {
    const raw = await this.getJson<RawItem>(`/items/${encodeURIComponent(itemId)}`);
    return {
      itemId: raw.id ?? itemId,
      connectorName: raw.connector?.name ?? null,
      status: raw.status ?? null,
      consentExpiresAt: raw.consentExpiresAt ?? null,
      lastUpdatedAt: raw.lastUpdatedAt ?? raw.updatedAt ?? null,
      errorCode: raw.error?.code ?? null,
    };
  }

  private async getPages<T>(pathAndQuery: string): Promise<Paged<T>> {
    const rows: T[] = [];
    let page = 1;
    while (page <= PAGE_CAP) {
      const separator = pathAndQuery.includes('?') ? '&' : '?';
      const body = await this.getJson<Page<T>>(`${pathAndQuery}${separator}page=${page}&pageSize=500`);
      rows.push(...(body.results ?? []));
      const totalPages = body.totalPages ?? 1;
      if (page >= totalPages) return { rows, truncated: false };
      page += 1;
    }
    return { rows, truncated: true };
  }

  private async getCursor<T>(pathname: string, params: URLSearchParams): Promise<Paged<T>> {
    const rows: T[] = [];
    const accountId = params.get('accountId') ?? '';
    let cursor: string | null = `?${params.toString()}`;
    let page = 0;
    while (cursor && page < PAGE_CAP) {
      if (!cursor.startsWith('?')) break;
      const query = new URLSearchParams(cursor.slice(1));
      if ((query.get('accountId') ?? '') !== accountId) break;
      const body: CursorPage<T> = await this.getJson<CursorPage<T>>(`${pathname}?${query.toString()}`);
      rows.push(...(body.results ?? []));
      const following = body.next;
      cursor = typeof following === 'string' && following.startsWith('?') ? following : null;
      page += 1;
    }
    return { rows, truncated: page >= PAGE_CAP && cursor !== null };
  }

  private async getJson<T>(pathAndQuery: string): Promise<T> {
    const cacheKey = `GET ${pathAndQuery}`;
    const cached = this.cache.get<T>(cacheKey);
    if (cached) return cached;
    const response = await this.request('GET', pathAndQuery, undefined, true);
    const body = (await response.json()) as T;
    this.cache.set(cacheKey, body, this.cacheTtlMs);
    return body;
  }

  private async request(method: 'GET' | 'POST', pathAndQuery: string, body: unknown, withKey: boolean): Promise<Response> {
    const url = new URL(pathAndQuery, PLUGGY_API_ORIGIN);
    if (url.origin !== PLUGGY_API_ORIGIN) {
      throw new Error('Pluggy host refused.');
    }
    if (method !== 'GET' && !(method === 'POST' && url.pathname === '/auth')) {
      throw new Error('This connector only reads from Pluggy, plus POST /auth.');
    }
    const headers = new Headers({ Accept: 'application/json', 'User-Agent': 'pluggy-mcp-br/0.1.0' });
    if (body !== undefined) headers.set('Content-Type', 'application/json');
    if (withKey) headers.set('X-API-KEY', await this.getApiKey());
    const response = await this.callPluggy(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
      redirect: 'error',
    });
    if (response.status === 401 && withKey) {
      this.apiKeyState = null;
      headers.set('X-API-KEY', await this.getApiKey());
      const retry = await this.callPluggy(url, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(20_000),
        redirect: 'error',
      });
      if (!retry.ok) throw new Error(await readPluggyError(retry));
      return retry;
    }
    if (!response.ok) throw new Error(await readPluggyError(response));
    return response;
  }

  private async callPluggy(url: URL, init: RequestInit): Promise<Response> {
    try {
      return await this.fetchImpl(url, init);
    } catch (error) {
      if (refusedRedirect(error)) throw new Error(REDIRECT_REFUSED);
      throw error;
    }
  }

  private async getApiKey(): Promise<string> {
    const current = this.apiKeyState;
    if (current && this.now() - current.issuedAt < API_KEY_TTL_MS) return current.apiKey;
    this.apiKeyInflight ??= this.issueApiKey().finally(() => {
      this.apiKeyInflight = null;
    });
    return this.apiKeyInflight;
  }

  private async issueApiKey(): Promise<string> {
    const response = await this.request('POST', '/auth', {
      clientId: this.options.clientId,
      clientSecret: this.options.clientSecret,
    }, false);
    const body = (await response.json()) as { apiKey?: string };
    if (!body.apiKey) throw new Error('Pluggy did not return an API key.');
    this.apiKeyState = { apiKey: body.apiKey, issuedAt: this.now() };
    return body.apiKey;
  }
}

interface Page<T> {
  results?: T[];
  totalPages?: number;
}

interface CursorPage<T> {
  results?: T[];
  next?: string | null;
}

interface RawAccount {
  id?: string;
  type?: string;
  subtype?: string;
  name?: string;
  marketingName?: string;
  balance?: number;
  currencyCode?: string;
  number?: string;
  taxNumber?: string;
  owner?: string;
  itemId?: string;
  creditData?: { creditLimit?: number; availableCreditLimit?: number };
}

interface RawTransaction {
  id?: string;
  accountId?: string;
  date?: string;
  amount?: number;
  type?: string;
  currencyCode?: string | null;
  amountInAccountCurrency?: number | null;
  category?: string | null;
  status?: string;
  description?: string;
  paymentData?: {
    paymentMethod?: string;
    payer?: RawParty;
    receiver?: RawParty;
  };
}

interface RawParty {
  name?: string;
  accountNumber?: string;
  documentNumber?: { type?: string; value?: string };
}

interface RawBill {
  id?: string;
  dueDate?: string;
  billClosingDate?: string;
  totalAmount?: number;
  minimumPaymentAmount?: number;
  totalAmountCurrencyCode?: string;
}

interface RawInvestment {
  id?: string;
  itemId?: string;
  name?: string;
  type?: string;
  subtype?: string;
  balance?: number;
  currencyCode?: string;
  amountOriginal?: number | null;
  amountProfit?: number | null;
  amountWithdrawal?: number | null;
  rate?: number | null;
  rateType?: string | null;
  fixedAnnualRate?: number | null;
  annualRate?: number | null;
  lastMonthRate?: number | null;
  lastTwelveMonthsRate?: number | null;
  dueDate?: string | null;
  issuer?: string | null;
  purchaseDate?: string | null;
  status?: string | null;
  institution?: { name?: string | null } | null;
  transactions?: Array<{ description?: string | null }> | null;
}

interface RawItem {
  id?: string;
  status?: string;
  consentExpiresAt?: string;
  lastUpdatedAt?: string;
  updatedAt?: string;
  connector?: { name?: string };
  error?: { code?: string } | null;
}

function normalizeAccount(account: RawAccount, itemId: string): NormalizedAccount {
  return {
    id: account.id ?? '',
    itemId: account.itemId ?? itemId,
    type: account.type ?? 'UNKNOWN',
    subtype: account.subtype ?? 'UNKNOWN',
    name: account.name ?? 'Account',
    institution: account.marketingName ?? null,
    balance: numberOrZero(account.balance),
    currencyCode: canonicalCurrency(account.currencyCode) ?? 'BRL',
    number: account.number ?? null,
    taxNumber: account.taxNumber ?? null,
    owner: account.owner ?? null,
    creditLimit: account.creditData?.creditLimit ?? null,
    availableCreditLimit: account.creditData?.availableCreditLimit ?? null,
  };
}

function normalizeTransaction(transaction: RawTransaction): NormalizedTransaction {
  return {
    id: transaction.id ?? '',
    accountId: transaction.accountId ?? '',
    date: transaction.date ?? '',
    amount: numberOrZero(transaction.amount),
    type: transaction.type ?? 'DEBIT',
    currencyCode: canonicalCurrency(transaction.currencyCode) ?? '',
    amountInAccountCurrency: finiteOrNull(transaction.amountInAccountCurrency),
    category: transaction.category ?? null,
    status: transaction.status ?? null,
    description: transaction.description ?? '',
    paymentMethod: transaction.paymentData?.paymentMethod ?? null,
    payerName: transaction.paymentData?.payer?.name ?? null,
    receiverName: transaction.paymentData?.receiver?.name ?? null,
    payerDocumentType: transaction.paymentData?.payer?.documentNumber?.type ?? null,
    payerDocument: transaction.paymentData?.payer?.documentNumber?.value ?? null,
    receiverDocumentType: transaction.paymentData?.receiver?.documentNumber?.type ?? null,
    receiverDocument: transaction.paymentData?.receiver?.documentNumber?.value ?? null,
    payerAccount: transaction.paymentData?.payer?.accountNumber ?? null,
    receiverAccount: transaction.paymentData?.receiver?.accountNumber ?? null,
  };
}

function normalizeInvestment(investment: RawInvestment, itemId: string): NormalizedInvestment {
  return {
    id: investment.id ?? '',
    itemId: investment.itemId ?? itemId,
    name: investment.name ?? '',
    type: investment.type ?? 'OTHER',
    subtype: investment.subtype ?? '',
    balance: numberOrZero(investment.balance),
    currencyCode: canonicalCurrency(investment.currencyCode) ?? 'BRL',
    amountOriginal: finiteOrNull(investment.amountOriginal),
    amountProfit: finiteOrNull(investment.amountProfit),
    amountWithdrawal: finiteOrNull(investment.amountWithdrawal),
    rate: finiteOrNull(investment.rate),
    rateType: investment.rateType ?? null,
    fixedAnnualRate: finiteOrNull(investment.fixedAnnualRate),
    annualRate: finiteOrNull(investment.annualRate),
    lastMonthRate: finiteOrNull(investment.lastMonthRate),
    lastTwelveMonthsRate: finiteOrNull(investment.lastTwelveMonthsRate),
    issuer: investment.issuer ?? null,
    purchaseDate: calendarDate(investment.purchaseDate),
    dueDate: calendarDate(investment.dueDate),
    status: investment.status ?? null,
    institution: investment.institution?.name ?? null,
    transactions: (investment.transactions ?? [])
      .map((transaction) => ({ description: transaction.description ?? '' }))
      .filter((transaction) => transaction.description.length > 0),
  };
}

function calendarDate(value: string | null | undefined): string | null {
  if (!value) return null;
  const day = value.slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : null;
}

function normalizeBill(bill: RawBill, accountId: string): NormalizedBill {
  return {
    id: bill.id ?? '',
    accountId,
    dueDate: bill.dueDate ? bill.dueDate.slice(0, 10) : null,
    closingDate: bill.billClosingDate ? bill.billClosingDate.slice(0, 10) : null,
    totalAmount: numberOrZero(bill.totalAmount),
    minimumPayment: bill.minimumPaymentAmount ?? null,
    currencyCode: canonicalCurrency(bill.totalAmountCurrencyCode) ?? 'BRL',
  };
}

function numberOrZero(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function finiteOrNull(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export const REDIRECT_REFUSED = 'Pluggy answered with a redirect; refused.';

export function refusedRedirect(error: unknown): boolean {
  if (!(error instanceof TypeError)) return false;
  const cause = error.cause;
  const causeMessage = cause instanceof Error ? cause.message : '';
  return /redirect/i.test(`${error.message} ${causeMessage}`);
}

async function readPluggyError(response: Response): Promise<string> {
  const text = await response.text();
  try {
    const body = JSON.parse(text) as { codeDescription?: string; message?: string };
    const code = body.codeDescription ? ` (${body.codeDescription})` : '';
    const message = body.message ? `: ${body.message.slice(0, 180)}` : '';
    return `Pluggy answered ${response.status}${code}${message}`;
  } catch {
    return `Pluggy answered ${response.status}.`;
  }
}

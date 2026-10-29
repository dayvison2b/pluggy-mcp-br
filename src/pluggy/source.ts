import { canonicalCurrency, inRange, type BankingSource, type NormalizedAccount, type NormalizedTransaction, type Paged } from '../banking/types';
import { cacheTtlMs, readLiveConfig, type EnvLike, type LiveConfig } from '../config';
import { TtlCache } from '../cache';
import { PluggyClient } from './client';

export class PluggyBankingSource implements BankingSource {
  readonly mode = 'live' as const;

  constructor(private readonly client: PluggyClient, private readonly itemIds: string[]) {}

  async listAccounts() {
    return this.ownedAccounts();
  }

  async listTransactions(query: { from: string; to: string; accountId?: string }) {
    const accounts = await this.ownedAccounts(query.accountId);
    const rows = [];
    let truncated = query.accountId ? false : accounts.truncated;
    for (const account of accounts.rows) {
      const page = await this.client.listTransactions(account.id, query.from, query.to);
      if (page.truncated) truncated = true;
      const accountCurrency = canonicalCurrency(account.currencyCode) ?? 'BRL';
      rows.push(
        ...page.rows
          .filter(
            (transaction) =>
              inRange(transaction.date, query.from, query.to) &&
              (transaction.accountId.length === 0 || transaction.accountId === account.id),
          )
          .map((transaction) => withAccountCurrency(transaction, accountCurrency)),
      );
    }
    return { rows, truncated };
  }

  async listBills(accountId: string) {
    await this.ownedAccounts(accountId);
    const page = await this.client.listBills(accountId);
    return {
      rows: page.rows.filter((bill) => bill.accountId === accountId),
      truncated: page.truncated,
    };
  }

  private async ownedAccounts(accountId?: string): Promise<Paged<NormalizedAccount>> {
    const page = await this.client.listAccounts();
    const owned = page.rows.filter((account) => account.id.length > 0 && this.itemIds.includes(account.itemId));
    if (!accountId) return { rows: owned, truncated: page.truncated };
    const match = owned.filter((account) => account.id === accountId);
    if (match.length !== 1) throw new Error('Account not found.');
    return { rows: match, truncated: page.truncated };
  }

  async listInvestments() {
    const page = await this.client.listInvestments();
    return {
      rows: page.rows.filter((investment) => investment.id.length > 0 && this.itemIds.includes(investment.itemId)),
      truncated: page.truncated,
    };
  }

  async connectionStatus() {
    const items = [];
    for (const itemId of this.itemIds) {
      items.push(await this.client.getItem(itemId));
    }
    return items;
  }
}

export function createLiveSource(
  config: LiveConfig,
  fetchImpl?: typeof fetch,
  ttlMs: number = cacheTtlMs(),
): PluggyBankingSource {
  const client = new PluggyClient({
    ...config,
    fetchImpl,
    cache: new TtlCache(),
    cacheTtlMs: ttlMs,
  });
  return new PluggyBankingSource(client, config.itemIds);
}

const processSources = new Map<string, PluggyBankingSource>();

export function createLiveSourceFromEnv(env: EnvLike = process.env): PluggyBankingSource {
  const config = readLiveConfig(env);
  const ttlMs = cacheTtlMs(env);
  const key = [config.clientId, config.clientSecret, config.itemIds.join(','), String(ttlMs)].join('\0');
  const existing = processSources.get(key);
  if (existing) return existing;
  const source = createLiveSource(config, undefined, ttlMs);
  processSources.set(key, source);
  return source;
}

export function clearLiveSourceCache(): void {
  processSources.clear();
}

function withAccountCurrency(transaction: NormalizedTransaction, accountCurrency: string): NormalizedTransaction {
  const own = canonicalCurrency(transaction.currencyCode);
  if (own) return { ...transaction, currencyCode: own };
  return { ...transaction, currencyCode: accountCurrency };
}

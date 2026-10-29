import type { BankingSource, NormalizedAccount, NormalizedBill, NormalizedInvestment, NormalizedItem, NormalizedTransaction } from './types';
import { calendarDay, canonicalCurrency, isOutflow, signedAmount } from './types';
import { maskAccountNumber, maskCpf, maskDocument, maskSensitiveFreeText, isValidCpf } from '../privacy/mask';
import { DATA_WARNING, fenceUntrusted, formatReais, money, UNTRUSTED_FIELD } from '../privacy/untrusted';
import { PAGE_CAP } from '../pluggy/client';
import { amountCents, cardDue, isCheckingAccount, isCreditAccount, splitMonth, sumAmountCents, type CardDue, type MonthSplit } from './readout';

const CURRENCY_WARNING = 'There is more than one currency; the numbers were added without conversion.';

export function presentAccounts(source: BankingSource, accounts: NormalizedAccount[], truncated = false) {
  return envelope(source, {
    accounts: accounts.map(presentAccount),
  }, truncated);
}

export function presentBalances(source: BankingSource, accounts: NormalizedAccount[]) {
  const bank = accounts.filter((account) => account.type === 'BANK');
  const credit = accounts.filter((account) => account.type === 'CREDIT');
  return envelope(source, {
    bank_balances: money(bank.reduce((total, account) => total + account.balance, 0)),
    open_bills: money(credit.reduce((total, account) => total + account.balance, 0)),
    note:
      'A bank account balance is money available. A card balance is the open bill, not free limit. The two must not be added together.',
    accounts: accounts.map((account) => ({
      ...presentAccount(account),
      limit: account.creditLimit === null ? null : money(account.creditLimit),
      available_limit: account.availableCreditLimit === null ? null : money(account.availableCreditLimit),
    })),
  });
}

export function presentTransactions(
  source: BankingSource,
  transactions: NormalizedTransaction[],
  period: { from: string; to: string },
  truncated = false,
) {
  return envelope(source, {
    period,
    transactions: transactions.map(presentTransaction),
  }, truncated);
}

export function presentBills(source: BankingSource, accountId: string, bills: NormalizedBill[], truncated = false) {
  return envelope(source, {
    accountId,
    bills: bills.map((bill) => ({
      id: bill.id,
      due_date: bill.dueDate,
      closing_date: bill.closingDate,
      total_amount: money(bill.totalAmount),
      minimum_payment: bill.minimumPayment === null ? null : money(bill.minimumPayment),
      currency: bill.currencyCode,
    })),
  }, truncated);
}

export function categoryTotals(transactions: readonly NormalizedTransaction[]) {
  const groups = new Map<string, { totalCents: number; count: number }>();
  for (const transaction of transactions) {
    if (!isOutflow(transaction)) continue;
    const category = categoryGroupKey(transaction.category);
    const current = groups.get(category) ?? { totalCents: 0, count: 0 };
    current.totalCents += Math.round(Math.abs(transaction.amount) * 100);
    current.count += 1;
    groups.set(category, current);
  }
  return [...groups.entries()]
    .map(([key, group]) => ({
      category: categoryLabel(key),
      total: money(group.totalCents / 100),
      count: group.count,
    }))
    .sort((left, right) => right.total - left.total || left.category.localeCompare(right.category));
}

export function presentSpending(
  source: BankingSource,
  transactions: NormalizedTransaction[],
  accounts: readonly NormalizedAccount[],
  period: { from: string; to: string },
  truncated = false,
) {
  const settled = settleMonth(transactions, accounts);
  const debits = settled.rows.filter((transaction) => isOutflow(transaction));
  const ids = new Set(debits.map((transaction) => transaction.accountId));
  const currency = currencyLabel([
    ...accounts.filter((account) => ids.has(account.id)).map((account) => account.currencyCode),
    ...debits.map((transaction) => transaction.currencyCode),
  ]);
  const categories = categoryTotals(settled.rows);
  return envelope(source, {
    period,
    currency: currency.currency,
    total_outflows: money(categories.reduce((total, category) => total + category.total, 0)),
    categories,
    ...(currency.mixed
      ? { currency_warning: CURRENCY_WARNING }
      : {}),
    limitation:
      'The category comes from Pluggy when the institution or the plan sends it. On the free Meu Pluggy plan the field may come back empty, because the Pluggy categorizer is a Pro plan feature. Empty shows as "Uncategorized".',
  }, truncated);
}

export function presentCurrentBills(
  source: BankingSource,
  cards: NormalizedAccount[],
  billsByCard: ReadonlyMap<string, readonly NormalizedBill[]>,
  today: string,
  truncated = false,
) {
  const cardBills = cards.map((card) => presentCardBill(card, cardDue(card, billsByCard.get(card.id) ?? [], today)));
  return envelope(
    source,
    {
      cards: cardBills,
      ...(cardBills.length === 0 ? { note: 'There is no card (CREDIT account) to read the bill from.' } : {}),
    },
    truncated,
  );
}

export function presentSpendRoom(
  source: BankingSource,
  accounts: NormalizedAccount[],
  billsByCard: ReadonlyMap<string, readonly NormalizedBill[]>,
  period: { days: number; start: string; end: string },
  today: string,
  truncated = false,
) {
  const checking = accounts.filter(isCheckingAccount);
  const cards = accounts.filter(isCreditAccount);
  const dues = cards.map((card) => ({ card, due: cardDue(card, billsByCard.get(card.id) ?? [], today) }));
  const checkingCents = checking.reduce((total, account) => total + amountCents(account.balance), 0);
  const cardCents = dues.reduce((total, item) => total + item.due.valueCents, 0);
  const balance = money(checkingCents / 100);
  const cardPayments = money(cardCents / 100);
  const estimate = money((checkingCents - cardCents) / 100);
  const average = money(estimate / period.days);
  const { currency, mixed } = currencyLabel([...checking, ...cards].map((account) => account.currencyCode));
  const billAfterPeriod = dues.some((item) => item.due.futureBills.some((bill) => bill.dueDate > period.end));
  return envelope(
    source,
    {
      currency,
      checking_balance: balance,
      card_payments_due: cardPayments,
      estimate,
      days: period.days,
      start: period.start,
      end: period.end,
      daily_average: average,
      checking_accounts: checking.map((account) => ({
        id: account.id,
        name: presentBankText(account.name),
        balance: money(account.balance),
        masked_number: account.number ? maskAccountNumber(account.number) : null,
      })),
      cards: dues.map(({ card, due }) => ({
        id: card.id,
        name: presentBankText(card.name),
        label: due.label,
        amount: money(due.valueCents / 100),
        card_balance: money(due.balanceCents / 100),
        bill: presentOpenBill(due.nextBill),
        future_bills: due.futureBills.map(presentOpenBill),
        due_date: due.dueDate,
      })),
      how_calculated: explainSpend({
        checking: balance,
        cards: cardPayments,
        estimate,
        days: period.days,
        daily: average,
        start: period.start,
        end: period.end,
        hasChecking: checking.length > 0,
        billAfterPeriod,
        mixed,
        negativeChecking: checking.filter((account) => account.balance < 0).map((account) => money(account.balance)),
        negativeCards: cards.filter((account) => account.balance < 0).map((account) => money(account.balance)),
      }),
    },
    truncated,
  );
}

export function presentMonthlySummary(
  source: BankingSource,
  accounts: NormalizedAccount[],
  current: NormalizedTransaction[],
  previous: NormalizedTransaction[],
  month: { id: string; from: string; to: string; previousId: string },
  truncated = false,
) {
  const currentSettled = settleMonth(current, accounts);
  const previousSettled = settleMonth(previous, accounts);
  const currentSplit = splitMonth(currentSettled.rows, accounts);
  const previousSplit = splitMonth(previousSettled.rows, accounts);
  const inflowsCents = sumAmountCents(currentSplit.inflows);
  const outflowsCents = sumAmountCents(currentSplit.outflows) - sumAmountCents(currentSplit.refunds);
  const previousInflows = sumAmountCents(previousSplit.inflows);
  const previousOutflows = sumAmountCents(previousSplit.outflows) - sumAmountCents(previousSplit.refunds);
  const netCents = inflowsCents - outflowsCents;
  const previousNet = previousInflows - previousOutflows;
  const folded = currentSettled.folded + previousSettled.folded;
  const currency = currencyLabel([
    ...currenciesInSum(currentSplit, accounts),
    ...currenciesInSum(previousSplit, accounts),
  ]);
  return envelope(
    source,
    {
      month: month.id,
      period: { from: month.from, to: month.to },
      currency: currency.currency,
      inflows: money(inflowsCents / 100),
      outflows: money(outflowsCents / 100),
      net: money(netCents / 100),
      transaction_count: current.length,
      categories: netCategoryTotals(currentSplit.outflows, currentSplit.refunds).slice(0, 5),
      top_expenses: rankExpenses(currentSplit.outflows).slice(0, 5).map(presentTransaction),
      previous_month: {
        month: month.previousId,
        inflows: compared(inflowsCents, previousInflows),
        outflows: compared(outflowsCents, previousOutflows),
        net: compared(netCents, previousNet),
      },
      excluded_bill_payments: currentSplit.excludedPayments.length,
      excluded_bill_payments_amount: money(sumAmountCents(currentSplit.excludedPayments) / 100),
      card_refunds: money(sumAmountCents(currentSplit.refunds) / 100),
      unrecognized_card_credits: money(sumAmountCents(currentSplit.unrecognizedCredits) / 100),
      internal_transfers: currentSplit.internalTransfers.length,
      internal_transfers_amount: money(sumAmountCents(currentSplit.internalTransfers.map((pair) => pair.debit)) / 100),
      possible_transfers_amount: money(sumAmountCents(currentSplit.possibleTransfers.map((pair) => pair.debit)) / 100),
      investments_applied: investmentTotal(currentSplit.appliedInvestments),
      investments_redeemed: investmentTotal(currentSplit.redeemedInvestments),
      earnings: investmentTotal(currentSplit.earnings),
      matched_pairs: currentSplit.pairs.length,
      pairs: currentSplit.pairs.map((pair) => ({
        amount: money(Math.abs(pair.debit.amount)),
        account_date: calendarDay(pair.debit.date),
        card_date: calendarDay(pair.credit.date),
        account_id: pair.debit.accountId,
        card_id: pair.credit.accountId,
      })),
      note: 'Rules in how_calculated.',
      how_calculated: [
        explainMonth(currentSplit, {
          inflows: money(inflowsCents / 100),
          outflows: money(outflowsCents / 100),
          net: money(netCents / 100),
          previousMonth: month.previousId,
          mixed: currency.mixed,
          folded,
        }),
        monthlyNote(currentSplit, currency.mixed, folded),
      ].join(' '),
    },
    truncated,
  );
}

export function presentInvestments(source: BankingSource, investments: NormalizedInvestment[], truncated = false) {
  const totals = new Map<string, number>();
  let totalCents = 0;
  for (const investment of investments) {
    const cents = amountCents(investment.balance);
    totalCents += cents;
    totals.set(investment.type, (totals.get(investment.type) ?? 0) + cents);
  }
  const currency = currencyLabel(investments.map((investment) => investment.currencyCode));
  return envelope(source, {
    investments: investments.map(presentInvestment),
    totals_by_type: [...totals.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([type, cents]) => ({ type, balance: money(cents / 100) })),
    total_balance: money(totalCents / 100),
    ...(currency.mixed ? { currency_warning: CURRENCY_WARNING } : {}),
  }, truncated);
}

export function presentConnection(source: BankingSource, items: NormalizedItem[]) {
  const now = Date.now();
  return envelope(source, {
    update:
      'Meu Pluggy refreshes the data about once every 24 hours. This connector does not ask the bank for a refresh and does not renew consent.',
    authorization:
      'The authorization for the MeuPluggy connector lasts 1 year. The date is in consentExpiresAt. Each bank inside Meu Pluggy has its own consent, separate from this one.',
    items: items.map((item) => {
      const expires = item.consentExpiresAt ? Date.parse(item.consentExpiresAt) : Number.NaN;
      return {
        itemId: item.itemId,
        connector: item.connectorName,
        status: item.status,
        consentExpiresAt: item.consentExpiresAt,
        consent_expired: Number.isFinite(expires) ? expires <= now : null,
        last_update: item.lastUpdatedAt,
        error: item.errorCode,
      };
    }),
  });
}

function presentInvestment(investment: NormalizedInvestment) {
  const descriptions = investment.transactions.map((transaction) => transaction.description);
  const untrusted = [investment.name, ...descriptions].filter((part) => part.length > 0).join(' | ');
  return {
    id: investment.id,
    itemId: investment.itemId,
    type: investment.type,
    subtype: investment.subtype,
    balance: money(investment.balance),
    currency: investment.currencyCode,
    amount_original: investment.amountOriginal === null ? null : money(investment.amountOriginal),
    amount_profit: investment.amountProfit === null ? null : money(investment.amountProfit),
    amount_withdrawal: investment.amountWithdrawal === null ? null : money(investment.amountWithdrawal),
    rate: investment.rate,
    rate_type: investment.rateType,
    fixed_annual_rate: investment.fixedAnnualRate,
    annual_rate: investment.annualRate,
    last_month_rate: investment.lastMonthRate,
    last_twelve_months_rate: investment.lastTwelveMonthsRate,
    issuer: presentBankText(investment.issuer),
    purchase_date: investment.purchaseDate,
    due_date: investment.dueDate,
    status: investment.status,
    institution: presentBankText(investment.institution),
    [UNTRUSTED_FIELD]: maskedFence(untrusted),
  };
}

function presentAccount(account: NormalizedAccount) {
  return {
    id: account.id,
    itemId: account.itemId,
    name: presentBankText(account.name),
    institution: presentBankText(account.institution),
    type: account.type,
    subtype: account.subtype,
    currency: account.currencyCode,
    balance: money(account.balance),
    masked_number: account.number ? maskAccountNumber(account.number) : null,
    masked_document: maskTaxNumber(account.taxNumber),
    untrusted_holder: fenceUntrusted(account.owner),
  };
}

function presentTransaction(transaction: NormalizedTransaction) {
  const parties = [transaction.payerName, transaction.receiverName].filter(Boolean).join(' → ');
  const untrusted = [transaction.description, parties].filter(Boolean).join(' | ');
  return {
    id: transaction.id,
    accountId: transaction.accountId,
    date: calendarDay(transaction.date),
    amount: money(signedAmount(transaction)),
    type: transaction.type,
    currency: transaction.currencyCode,
    category: presentBankText(transaction.category),
    status: transaction.status,
    method: transaction.paymentMethod,
    masked_payer_document: maskDocument(transaction.payerDocumentType, transaction.payerDocument),
    masked_receiver_document: maskDocument(transaction.receiverDocumentType, transaction.receiverDocument),
    masked_payer_account: transaction.payerAccount ? maskAccountNumber(transaction.payerAccount) : null,
    masked_receiver_account: transaction.receiverAccount ? maskAccountNumber(transaction.receiverAccount) : null,
    [UNTRUSTED_FIELD]: maskedFence(untrusted),
  };
}

function presentCardBill(account: NormalizedAccount, due: CardDue) {
  const identity = presentAccount(account);
  return {
    id: identity.id,
    name: identity.name,
    institution: identity.institution,
    masked_number: identity.masked_number,
    masked_document: identity.masked_document,
    currency: identity.currency,
    label: due.label,
    amount: money(due.valueCents / 100),
    card_balance: money(due.balanceCents / 100),
    bill: presentOpenBill(due.nextBill),
    future_bills: due.futureBills.map(presentOpenBill),
    due_date: due.dueDate,
    minimum_payment: due.minimumPaymentCents === null ? null : money(due.minimumPaymentCents / 100),
    days_until_due: due.days,
    total_limit: account.creditLimit === null ? null : money(account.creditLimit),
    available_limit: account.availableCreditLimit === null ? null : money(account.availableCreditLimit),
    note: due.note,
  };
}

function presentOpenBill(bill: { valueCents: number; dueDate: string; minimumPaymentCents: number | null; days: number } | null) {
  if (!bill) return null;
  return {
    amount: money(bill.valueCents / 100),
    due_date: bill.dueDate,
    minimum_payment: bill.minimumPaymentCents === null ? null : money(bill.minimumPaymentCents / 100),
    days_until_due: bill.days,
  };
}

function explainSpend(input: {
  checking: number;
  cards: number;
  estimate: number;
  days: number;
  daily: number;
  start: string;
  end: string;
  hasChecking: boolean;
  billAfterPeriod: boolean;
  mixed: boolean;
  negativeChecking: number[];
  negativeCards: number[];
}): string {
  return [
    `estimate = ${formatReais(input.checking)} minus ${formatReais(input.cards)} = ${formatReais(input.estimate)}.`,
    `daily average = ${formatReais(input.estimate)} / ${input.days} = ${formatReais(input.daily)}.`,
    `Period ${input.start} to ${input.end}, inclusive (${input.days} days), on the America/Sao_Paulo calendar.`,
    input.hasChecking
      ? `Counted in: balance of the checking accounts (type BANK, subtype CHECKING_ACCOUNT) = ${formatReais(input.checking)}.`
      : 'There is no checking account. The balance considered is R$ 0,00.',
    `Counted in: on each card, the larger of the sum of the future bills and the debt balance, adding up to ${formatReais(input.cards)}. Bill and balance appear side by side.`,
    input.billAfterPeriod ? 'A bill due after the end of this period also counts.' : '',
    'Pluggy does not report whether the bill has already been paid, so the math may subtract too little or too much.',
    'The balance can be up to about 24 hours behind.',
    negativeBalanceNote(input.negativeChecking, input.negativeCards),
    'Left out: future income, bills to be paid that are not on the card, savings, investments and the card limit.',
    input.estimate < 0
      ? `Your balances do not cover what is due on the card. The estimate came out at ${formatReais(input.estimate)}.`
      : '',
    input.mixed ? CURRENCY_WARNING : '',
    'Only the math. No financial advice.',
  ]
    .filter((part) => part.length > 0)
    .join(' ');
}

function negativeBalanceNote(checking: readonly number[], cards: readonly number[]): string {
  if (checking.length === 0 && cards.length === 0) return '';
  const parts = [
    ...checking.map((value) => `checking account ${formatReais(value)}`),
    ...cards.map((value) => `card ${formatReais(value)}`),
  ];
  const effect = [
    checking.length > 0 ? 'The negative checking balance counts.' : '',
    cards.length > 0 ? 'The negative card balance does not increase what can be spent.' : '',
  ].filter((part) => part.length > 0);
  return `There is a negative balance: ${parts.join('; ')}. ${effect.join(' ')}`;
}

function monthlyNote(split: MonthSplit, mixed: boolean, folded: number): string {
  const excluded = money(sumAmountCents(split.excludedPayments) / 100);
  return [
    'Card purchases count as outflows.',
    'A bill payment only stays out of outflows when there is a pair: a debit on the checking account and a payment credit on the card, with the same amount in cents and dates within 5 days.',
    'Both sides must have card-payment text or category. With no CREDIT card connected, or without that pair, the entry stays in spending.',
    'A phone, electricity or Pix bill does not leave outflows just because the text mentions a bill or the amount matches.',
    'The credit side of that card payment does not count as inflows, because it is not income.',
    'A bill payment across the turn of the month, with the debit at the end of one month and the credit at the start of the next (for example day 31 and day 2), may not pair and stays in outflows.',
    'An empty category shows as Uncategorized.',
    'The comparison percentage is empty when the previous month is zero and this month is not.',
    'transaction_count counts every entry in the month, including bill payments and transfers that were left out of inflows and outflows.',
    `Matched bill payment pairs: ${split.pairs.length}.`,
    `Amount excluded from outflows: ${formatReais(excluded)}.`,
    `Card refunds and cashback subtracted from outflows: ${formatReais(money(sumAmountCents(split.refunds) / 100))}. Only refund, cashback, reimbursement or return counts.`,
    `A card payment credit, such as pagamento recebido or pagamento efetuado, does not reduce outflows on its own: it only pairs with the checking account debit.`,
    `Card credits with no recognizable text do not reduce outflows. Reported amount: ${formatReais(money(sumAmountCents(split.unrecognizedCredits) / 100))}.`,
    `Transfers between your own accounts only leave both ends when both sides have transfer, TED, TEF, same ownership, redemption or application text, or a transfer category, and the description carries no differing third-party names. Amount: ${formatReais(money(sumAmountCents(split.internalTransfers.map((pair) => pair.debit)) / 100))}.`,
    `Pairs with the same amount and close dates, without that evidence, stay in inflows and outflows. Amount: ${formatReais(money(sumAmountCents(split.possibleTransfers.map((pair) => pair.debit)) / 100))}.`,
    `An investment application is not spending. It leaves outflows, the net, the categories and the top expenses, and stays in investments_applied: ${formatReais(money(sumAmountCents(split.appliedInvestments) / 100))} in ${split.appliedInvestments.length} entries.`,
    'This counts a debit on a BANK or INVESTMENT account, never on the card, with aplicação, aplicado, aplicar or aplic, without requiring a product, when there is no third-party signal. Aporte, investimento, guardado or guardar only count with a strict product at the end of the text (cdb, rdb, lci, lca, tesouro, fundo de investimento, poupança, previdência privada) or, for guardado, when the whole text is dinheiro guardado. A purchase with that product at the end, or followed only by an acronym, date, due date or number, also counts. Caixinha, cofrinho, reserva de emergência and Tesouro Direto alone are not enough; with category Investments, Automatic investment, Fixed income, Mutual funds or Variable income, and no third party, they count. Pension and Margin do not count.',
    `Redemption is not income. On a BANK or INVESTMENT account, the credit with resgate, resgatado or res aplic (such as RES APLIC AUT) leaves inflows without requiring a product, and stays in investments_redeemed: ${formatReais(money(sumAmountCents(split.redeemedInvestments) / 100))} in ${split.redeemedInvestments.length} entries. The same third-party guard as for debits applies here: pix, ted, doc, ltda, s/a, eireli, mei, loja, pontos, milhas, cashback, livelo, smiles, tarifa, imposto, iof, pagto or pagamento, or a commercial name after caixinha, cofrinho, fundo or tesouro. An investment category alone is not enough. On the card, cashback and refunds reduce outflows before this rule.`,
    `Yield, dividend, interest, dividend or proceeds, without the word resgate, stays in inflows. The earnings field only highlights what is already summed there: ${formatReais(money(sumAmountCents(split.earnings) / 100))} in ${split.earnings.length} entries.`,
    'The comparison with the previous month uses the same rule.',
    'An empty or missing currency uses the account currency. It does not become a second currency.',
    'A purchase in another currency counts at its value in the account currency when Pluggy sends that value. Without it, the original currency stays in the sum.',
    folded > 0
      ? `Purchases summed by their value in the account currency in this calculation: ${folded}. This holds for the month and for the previous month.`
      : '',
    mixed ? CURRENCY_WARNING : '',
  ]
    .filter((part) => part.length > 0)
    .join(' ');
}

function investmentTotal(transactions: readonly NormalizedTransaction[]) {
  return {
    amount: money(sumAmountCents(transactions) / 100),
    count: transactions.length,
  };
}

function explainMonth(split: MonthSplit, input: {
  inflows: number;
  outflows: number;
  net: number;
  previousMonth: string;
  mixed: boolean;
  folded: number;
}): string {
  const applied = money(sumAmountCents(split.appliedInvestments) / 100);
  const redeemed = money(sumAmountCents(split.redeemedInvestments) / 100);
  return [
    `Net = inflows ${formatReais(input.inflows)} minus outflows ${formatReais(input.outflows)} = ${formatReais(input.net)}.`,
    'Outflows are the month debits, without paired bill payments, without transfers between your own accounts and without investment applications, minus card refunds.',
    'Inflows are the credits, without the bill payment credit and without investment redemption.',
    `Applications outside this math: ${formatReais(applied)} in ${split.appliedInvestments.length} entries. Redemptions outside this math: ${formatReais(redeemed)} in ${split.redeemedInvestments.length} entries. Earnings stay in inflows: ${formatReais(money(sumAmountCents(split.earnings) / 100))}.`,
    split.earningsNotSeparated ? 'Earnings not separated from the principal.' : '',
    `The comparison with ${input.previousMonth} repeats the same math.`,
    'A missing currency counts as the account currency.',
    input.folded > 0
      ? `Purchases in another currency summed by their value in the account currency: ${input.folded}.`
      : '',
    input.mixed ? CURRENCY_WARNING : '',
    'Only the math. No financial advice.',
  ]
    .filter((part) => part.length > 0)
    .join(' ');
}

function settleMonth(transactions: readonly NormalizedTransaction[], accounts: readonly NormalizedAccount[]): { rows: NormalizedTransaction[]; folded: number } {
  const byId = new Map(accounts.map((account) => [account.id, account]));
  let folded = 0;
  const rows = transactions.map((transaction) => {
    const settled = settleTransaction(transaction, byId.get(transaction.accountId));
    if (settled.folded) folded += 1;
    return settled.transaction;
  });
  return { rows, folded };
}

function currenciesInSum(split: MonthSplit, accounts: readonly NormalizedAccount[]): string[] {
  const summed = [
    ...split.inflows,
    ...split.outflows,
    ...split.refunds,
    ...split.appliedInvestments,
    ...split.redeemedInvestments,
  ];
  const ids = new Set(summed.map((transaction) => transaction.accountId));
  return [
    ...accounts.filter((account) => ids.has(account.id)).map((account) => account.currencyCode),
    ...summed.map((transaction) => transaction.currencyCode),
  ];
}

function settleTransaction(transaction: NormalizedTransaction, account: NormalizedAccount | undefined): { transaction: NormalizedTransaction; folded: boolean } {
  const accountCurrency = canonicalCurrency(account?.currencyCode) ?? 'BRL';
  const own = canonicalCurrency(transaction.currencyCode);
  const converted = transaction.amountInAccountCurrency;
  if (own && own !== accountCurrency && usableAccountAmount(transaction.amount, converted)) {
    return {
      transaction: { ...transaction, amount: converted as number, currencyCode: accountCurrency },
      folded: true,
    };
  }
  return { transaction: { ...transaction, currencyCode: own ?? accountCurrency }, folded: false };
}

function usableAccountAmount(amount: number, converted: number | null | undefined): converted is number {
  return typeof converted === 'number' && Number.isFinite(converted) && converted !== 0 && Number.isFinite(amount) && amount !== 0 && Math.sign(amount) === Math.sign(converted);
}

function netCategoryTotals(debits: readonly NormalizedTransaction[], refunds: readonly NormalizedTransaction[]) {
  const groups = new Map<string, { totalCents: number; count: number }>();
  for (const transaction of debits) {
    if (!isOutflow(transaction)) continue;
    const category = categoryGroupKey(transaction.category);
    const current = groups.get(category) ?? { totalCents: 0, count: 0 };
    current.totalCents += amountCents(Math.abs(transaction.amount));
    current.count += 1;
    groups.set(category, current);
  }
  for (const refund of refunds) {
    const category = categoryGroupKey(refund.category);
    const current = groups.get(category) ?? { totalCents: 0, count: 0 };
    current.totalCents -= amountCents(Math.abs(refund.amount));
    groups.set(category, current);
  }
  return [...groups.entries()]
    .map(([key, group]) => ({
      category: categoryLabel(key),
      total: money(group.totalCents / 100),
      count: group.count,
    }))
    .filter((category) => category.total > 0)
    .sort((left, right) => right.total - left.total || left.category.localeCompare(right.category));
}

function compared(currentCents: number, previousCents: number) {
  return {
    previous: money(previousCents / 100),
    difference: money((currentCents - previousCents) / 100),
    percent_change: percentChange(currentCents, previousCents),
  };
}

function percentChange(currentCents: number, previousCents: number): number | null {
  if (previousCents === 0) return currentCents === 0 ? 0 : null;
  return money(((currentCents - previousCents) / Math.abs(previousCents)) * 100);
}

function rankExpenses(transactions: readonly NormalizedTransaction[]): NormalizedTransaction[] {
  return [...transactions].sort((left, right) => {
    const byAmount = amountCents(Math.abs(right.amount)) - amountCents(Math.abs(left.amount));
    if (byAmount !== 0) return byAmount;
    const byDate = right.date.localeCompare(left.date);
    if (byDate !== 0) return byDate;
    return left.id.localeCompare(right.id);
  });
}

function maskedFence(value: string | null | undefined): string {
  if (!value) return '';
  return fenceUntrusted(maskSensitiveFreeText(value));
}

function presentBankText(value: string | null | undefined): string | null {
  if (value == null) return null;
  const cleaned = maskedFence(value);
  return cleaned || null;
}

function categoryGroupKey(value: string | null | undefined): string {
  const trimmed = value?.trim() ?? '';
  return trimmed || 'Uncategorized';
}

function categoryLabel(key: string): string {
  if (key === 'Uncategorized') return key;
  return presentBankText(key) ?? 'Uncategorized';
}

function currencyLabel(codes: readonly (string | null | undefined)[]): { currency: string; mixed: boolean } {
  const unique = [...new Set(codes.map((code) => canonicalCurrency(code)).filter((code): code is string => code !== null))];
  if (unique.length <= 1) return { currency: unique[0] ?? 'BRL', mixed: false };
  return { currency: 'mixed', mixed: true };
}

function maskTaxNumber(value: string | null): string | null {
  if (!value) return null;
  if (isValidCpf(value)) return maskCpf(value);
  return maskAccountNumber(value);
}

function envelope(_source: BankingSource, payload: Record<string, unknown>, truncated = false) {
  return {
    source: 'pluggy',
    warning: DATA_WARNING,
    ...payload,
    ...(truncated
      ? {
          truncated: true,
          warning: `${DATA_WARNING} the list was cut at ${PAGE_CAP} pages; the totals may be incomplete.`,
        }
      : {}),
  };
}

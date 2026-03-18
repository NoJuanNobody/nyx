import { useQuery, useMutation } from '@tanstack/react-query';
import {
  fetchCreditBalance,
  fetchCreditPacks,
  fetchCreditTransactions,
  purchaseCredits,
  type CreditPack,
  type CreditTransaction,
} from '../lib/api';

// ── Helpers ──────────────────────────────────────────────

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function Spinner() {
  return (
    <div className="flex items-center justify-center py-20">
      <div className="h-8 w-8 animate-spin rounded-full border-2 border-blue-600 border-t-transparent" />
    </div>
  );
}

// ── Credit Pack Card ─────────────────────────────────────

function PackCard({
  pack,
  onBuy,
  loading,
}: {
  pack: CreditPack;
  onBuy: (packId: string) => void;
  loading: boolean;
}) {
  return (
    <div
      className={`relative flex flex-col rounded-xl border p-6 ${
        pack.popular
          ? 'border-blue-400 bg-blue-50 ring-2 ring-blue-200'
          : 'border-slate-200 bg-white'
      }`}
    >
      {pack.popular && (
        <span className="absolute -top-3 left-1/2 -translate-x-1/2 rounded-full bg-blue-600 px-3 py-0.5 text-xs font-semibold text-white">
          Most Popular
        </span>
      )}
      <p className="text-lg font-bold text-slate-900">{pack.label}</p>
      <p className="mt-1 text-3xl font-extrabold text-slate-900">
        {pack.priceLabel}
      </p>
      <p className="mt-1 text-sm text-slate-500">
        {(pack.priceCents / pack.credits / 100).toFixed(3)} USD per credit
      </p>
      <ul className="mt-4 space-y-1.5 flex-1">
        <li className="flex items-center gap-2 text-sm text-slate-700">
          <svg className="h-4 w-4 text-green-500 shrink-0" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" d="m4.5 12.75 6 6 9-13.5" />
          </svg>
          {pack.credits.toLocaleString()} credits
        </li>
        <li className="flex items-center gap-2 text-sm text-slate-700">
          <svg className="h-4 w-4 text-green-500 shrink-0" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" d="m4.5 12.75 6 6 9-13.5" />
          </svg>
          Never expire
        </li>
      </ul>
      <button
        type="button"
        disabled={loading}
        onClick={() => onBuy(pack.id)}
        className={`mt-5 w-full rounded-lg px-4 py-2.5 text-sm font-semibold transition-colors ${
          pack.popular
            ? 'bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50'
            : 'bg-slate-900 text-white hover:bg-slate-700 disabled:opacity-50'
        }`}
      >
        {loading ? 'Redirecting...' : 'Buy Now'}
      </button>
    </div>
  );
}

// ── Transaction Row ──────────────────────────────────────

function TransactionRow({ tx }: { tx: CreditTransaction }) {
  const isCredit = tx.amount > 0;

  const typeLabel =
    tx.type === 'purchase'
      ? 'Purchase'
      : tx.type === 'refund'
        ? 'Refund'
        : tx.taskType
          ? tx.taskType.replace(/_/g, ' ')
          : 'Usage';

  return (
    <div className="flex items-center justify-between py-3 border-b border-slate-100 last:border-0">
      <div className="flex items-center gap-3">
        <div
          className={`flex h-8 w-8 items-center justify-center rounded-full text-xs font-bold ${
            isCredit
              ? 'bg-green-100 text-green-700'
              : 'bg-red-100 text-red-600'
          }`}
        >
          {isCredit ? '+' : '-'}
        </div>
        <div>
          <p className="text-sm font-medium text-slate-800">{tx.description}</p>
          <p className="text-xs text-slate-400 capitalize">{typeLabel} · {formatDate(tx.createdAt)}</p>
        </div>
      </div>
      <span
        className={`text-sm font-semibold tabular-nums ${
          isCredit ? 'text-green-600' : 'text-red-500'
        }`}
      >
        {isCredit ? '+' : ''}{tx.amount}
      </span>
    </div>
  );
}

// ── Main Page ────────────────────────────────────────────

export function Credits() {
  const { data: balanceData, isLoading: balanceLoading } = useQuery({
    queryKey: ['credits', 'balance'],
    queryFn: fetchCreditBalance,
  });

  const { data: packs, isLoading: packsLoading } = useQuery({
    queryKey: ['credits', 'packs'],
    queryFn: fetchCreditPacks,
  });

  const { data: historyData, isLoading: historyLoading } = useQuery({
    queryKey: ['credits', 'transactions'],
    queryFn: () => fetchCreditTransactions(20, 0),
  });

  const purchaseMutation = useMutation({
    mutationFn: (packId: string) =>
      purchaseCredits(
        packId,
        `${window.location.origin}/credits?success=1`,
        `${window.location.origin}/credits?canceled=1`,
      ),
    onSuccess: (data) => {
      if (data.url) {
        window.location.href = data.url;
      }
    },
  });

  const balance = balanceData?.balance ?? 0;

  return (
    <div className="max-w-4xl space-y-8">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-slate-900">Credits</h1>
        <p className="mt-1 text-sm text-slate-500">
          Purchase credits to power AI features like spec analysis, document generation, and drift detection.
        </p>
      </div>

      {/* Balance card */}
      <div className="flex items-center gap-6 rounded-xl border border-slate-200 bg-white p-6">
        <div className="flex h-14 w-14 items-center justify-center rounded-full bg-blue-100">
          <svg className="h-7 w-7 text-blue-600" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 6v12m-3-2.818.879.659c1.171.879 3.07.879 4.242 0 1.172-.879 1.172-2.303 0-3.182C13.536 12.219 12.768 12 12 12c-.725 0-1.45-.22-2.003-.659-1.106-.879-1.106-2.303 0-3.182s2.9-.879 4.006 0l.415.33M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z" />
          </svg>
        </div>
        <div>
          <p className="text-sm text-slate-500">Available balance</p>
          {balanceLoading ? (
            <div className="mt-1 h-8 w-24 animate-pulse rounded bg-slate-100" />
          ) : (
            <p className="text-3xl font-extrabold text-slate-900 tabular-nums">
              {balance.toLocaleString()}
            </p>
          )}
          <p className="text-xs text-slate-400">credits</p>
        </div>
      </div>

      {/* Credit packs */}
      <section>
        <h2 className="text-base font-semibold text-slate-800 mb-4">Buy Credits</h2>
        {packsLoading ? (
          <Spinner />
        ) : (
          <div className="grid gap-4 sm:grid-cols-3">
            {(packs ?? []).map((pack) => (
              <PackCard
                key={pack.id}
                pack={pack}
                onBuy={(id) => purchaseMutation.mutate(id)}
                loading={purchaseMutation.isPending && purchaseMutation.variables === pack.id}
              />
            ))}
          </div>
        )}
        {purchaseMutation.isError && (
          <p className="mt-3 text-sm text-red-600">
            Failed to start checkout. Please try again.
          </p>
        )}
      </section>

      {/* Credit cost reference */}
      <section>
        <h2 className="text-base font-semibold text-slate-800 mb-3">Credit Costs</h2>
        <div className="rounded-xl border border-slate-200 bg-white overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-100 bg-slate-50">
                <th className="px-4 py-2.5 text-left font-medium text-slate-600">AI Task</th>
                <th className="px-4 py-2.5 text-right font-medium text-slate-600">Credits</th>
              </tr>
            </thead>
            <tbody>
              {[
                { label: 'Spec Analysis', cost: 1 },
                { label: 'Context Matching', cost: 1 },
                { label: 'Drift Detection', cost: 2 },
                { label: 'Ticket Generation', cost: 2 },
                { label: 'Intake Processing', cost: 2 },
                { label: 'Document Generation', cost: 3 },
                { label: 'Bulk Ticket Review', cost: 3 },
                { label: 'Agent Workflow', cost: 4 },
                { label: 'Voice Agent (per minute)', cost: 5 },
                { label: 'Onboarding Scan', cost: 5 },
              ].map((row) => (
                <tr key={row.label} className="border-b border-slate-100 last:border-0">
                  <td className="px-4 py-2.5 text-slate-700">{row.label}</td>
                  <td className="px-4 py-2.5 text-right font-medium text-slate-900 tabular-nums">{row.cost}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* Transaction history */}
      <section>
        <h2 className="text-base font-semibold text-slate-800 mb-3">Recent Activity</h2>
        <div className="rounded-xl border border-slate-200 bg-white px-4">
          {historyLoading ? (
            <Spinner />
          ) : !historyData?.transactions.length ? (
            <div className="py-12 text-center">
              <p className="text-sm text-slate-500">No transactions yet.</p>
              <p className="mt-1 text-xs text-slate-400">Your credit history will appear here.</p>
            </div>
          ) : (
            historyData.transactions.map((tx) => (
              <TransactionRow key={tx.id} tx={tx} />
            ))
          )}
        </div>
      </section>
    </div>
  );
}

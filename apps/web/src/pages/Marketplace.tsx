import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  fetchMarketplaceListings,
  createMarketplaceListing,
  fetchFeatureRequests,
  createFeatureRequest,
  toggleFeatureRequestUpvote,
  fetchProjectShowcases,
  createProjectShowcase,
  fetchLifecycles,
  type MarketplaceListing,
  type FeatureRequest,
  type ProjectShowcase,
  type LifecycleResponse,
} from '../lib/api';
import { useUIStore } from '../stores/ui.store';

// ── Types ────────────────────────────────────────────────────────────

type MarketplaceTab = 'pipelines' | 'templates' | 'workflows' | 'prompts' | 'feature-requests' | 'showcase';

const TABS: { key: MarketplaceTab; label: string; icon: string }[] = [
  { key: 'pipelines', label: 'Pipelines', icon: '\u25CB' },
  { key: 'templates', label: 'Templates', icon: '\u25C8' },
  { key: 'workflows', label: 'Workflows', icon: '\u27F3' },
  { key: 'prompts', label: 'Prompts', icon: '\u2726' },
  { key: 'feature-requests', label: 'Feature Requests', icon: '\u25CE' },
  { key: 'showcase', label: 'Showcase', icon: '\u25C9' },
];

const TAB_TO_TYPE: Record<string, string> = {
  templates: 'template',
  workflows: 'workflow',
  prompts: 'prompt',
};

// ── Shared Components ────────────────────────────────────────────────

function Spinner() {
  return (
    <div className="flex items-center justify-center py-20">
      <div className="h-8 w-8 animate-spin rounded-full border-2 border-blue-600 border-t-transparent" />
    </div>
  );
}

function ErrorBanner({ message }: { message: string }) {
  return (
    <div className="rounded-xl border border-red-200 bg-red-50 p-5 text-center">
      <p className="text-sm font-medium text-red-700">Something went wrong</p>
      <p className="mt-1 text-xs text-red-500">{message}</p>
    </div>
  );
}

function EmptyState({ icon, title, subtitle }: { icon: string; title: string; subtitle: string }) {
  return (
    <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-slate-300 bg-slate-50/50 py-16 px-6 text-center">
      <span className="text-3xl mb-3">{icon}</span>
      <p className="text-sm font-medium text-slate-700">{title}</p>
      <p className="mt-1 text-xs text-slate-400">{subtitle}</p>
    </div>
  );
}

function StarRating({ rating }: { rating: number }) {
  return (
    <div className="flex items-center gap-0.5">
      {[1, 2, 3, 4, 5].map((star) => (
        <svg
          key={star}
          className={`h-3.5 w-3.5 ${star <= Math.round(rating) ? 'text-amber-400' : 'text-slate-200'}`}
          fill="currentColor"
          viewBox="0 0 20 20"
        >
          <path d="M9.049 2.927c.3-.921 1.603-.921 1.902 0l1.07 3.292a1 1 0 00.95.69h3.462c.969 0 1.371 1.24.588 1.81l-2.8 2.034a1 1 0 00-.364 1.118l1.07 3.292c.3.921-.755 1.688-1.54 1.118l-2.8-2.034a1 1 0 00-1.175 0l-2.8 2.034c-.784.57-1.838-.197-1.539-1.118l1.07-3.292a1 1 0 00-.364-1.118L2.98 8.72c-.783-.57-.38-1.81.588-1.81h3.461a1 1 0 00.951-.69l1.07-3.292z" />
        </svg>
      ))}
    </div>
  );
}

function PriceBadge({ priceType, priceAmountCents }: { priceType: string; priceAmountCents: number | null }) {
  if (priceType === 'free') {
    return (
      <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] font-semibold text-emerald-700 ring-1 ring-emerald-200">
        Free
      </span>
    );
  }
  const dollars = priceAmountCents ? (priceAmountCents / 100).toFixed(2) : '0.00';
  return (
    <span className="rounded-full bg-blue-50 px-2 py-0.5 text-[10px] font-semibold text-blue-700 ring-1 ring-blue-200">
      ${dollars}
    </span>
  );
}

function SearchInput({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder: string }) {
  return (
    <div className="relative">
      <svg
        className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400"
        fill="none"
        viewBox="0 0 24 24"
        strokeWidth={1.5}
        stroke="currentColor"
      >
        <path strokeLinecap="round" strokeLinejoin="round" d="m21 21-5.197-5.197m0 0A7.5 7.5 0 1 0 5.196 5.196a7.5 7.5 0 0 0 10.607 10.607Z" />
      </svg>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-full rounded-lg border border-slate-200 bg-white py-2 pl-9 pr-3 text-sm text-slate-700 placeholder:text-slate-400 outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-100 transition-colors"
      />
    </div>
  );
}

// ── Publish Modal ────────────────────────────────────────────────────

function PublishModal({
  type,
  onClose,
}: {
  type: 'template' | 'workflow' | 'prompt';
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [content, setContent] = useState('');
  const [category, setCategory] = useState('');
  const [tagsStr, setTagsStr] = useState('');
  const [priceType, setPriceType] = useState<'free' | 'paid'>('free');

  const mutation = useMutation({
    mutationFn: () =>
      createMarketplaceListing({
        type,
        title,
        description,
        content,
        priceType,
        category: category || undefined,
        tags: tagsStr ? tagsStr.split(',').map((t) => t.trim()).filter(Boolean) : undefined,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['marketplace', type] });
      onClose();
    },
  });

  const typeLabel = type.charAt(0).toUpperCase() + type.slice(1);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={onClose}>
      <div
        className="w-full max-w-lg rounded-xl border border-slate-200 bg-white p-6 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-lg font-semibold text-slate-900">Publish {typeLabel}</h2>
        <p className="mt-1 text-sm text-slate-500">Share your {type} with the community.</p>

        <div className="mt-5 space-y-4">
          <div>
            <label className="block text-xs font-medium text-slate-600 mb-1">Title</label>
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-100"
              placeholder={`My awesome ${type}...`}
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-600 mb-1">Description</label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={2}
              className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-100 resize-none"
              placeholder="A short description..."
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-600 mb-1">Content</label>
            <textarea
              value={content}
              onChange={(e) => setContent(e.target.value)}
              rows={5}
              className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm font-mono outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-100 resize-none"
              placeholder={`Paste your ${type} content here...`}
            />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1">Category</label>
              <input
                type="text"
                value={category}
                onChange={(e) => setCategory(e.target.value)}
                className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-100"
                placeholder="e.g., Frontend"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1">Tags (comma-separated)</label>
              <input
                type="text"
                value={tagsStr}
                onChange={(e) => setTagsStr(e.target.value)}
                className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-100"
                placeholder="react, api, docs"
              />
            </div>
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-600 mb-1">Price</label>
            <div className="flex gap-3">
              <label className="flex items-center gap-1.5 text-sm text-slate-600">
                <input
                  type="radio"
                  name="priceType"
                  checked={priceType === 'free'}
                  onChange={() => setPriceType('free')}
                  className="accent-blue-600"
                />
                Free
              </label>
              <label className="flex items-center gap-1.5 text-sm text-slate-600">
                <input
                  type="radio"
                  name="priceType"
                  checked={priceType === 'paid'}
                  onChange={() => setPriceType('paid')}
                  className="accent-blue-600"
                />
                Paid
              </label>
            </div>
          </div>
        </div>

        {mutation.isError && (
          <p className="mt-3 text-xs text-red-600">
            {mutation.error instanceof Error ? mutation.error.message : 'Failed to publish. Please try again.'}
          </p>
        )}

        <div className="mt-6 flex items-center justify-end gap-3">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg px-4 py-2 text-sm font-medium text-slate-600 hover:bg-slate-100 transition-colors"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => mutation.mutate()}
            disabled={!title.trim() || !content.trim() || mutation.isPending}
            className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-blue-700 disabled:opacity-50 transition-colors"
          >
            {mutation.isPending ? 'Publishing...' : 'Publish'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Feature Request Modal ────────────────────────────────────────────

function FeatureRequestModal({ onClose }: { onClose: () => void }) {
  const queryClient = useQueryClient();
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');

  const mutation = useMutation({
    mutationFn: () => createFeatureRequest({ title, description }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['feature-requests'] });
      onClose();
    },
  });

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={onClose}>
      <div
        className="w-full max-w-lg rounded-xl border border-slate-200 bg-white p-6 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-lg font-semibold text-slate-900">Submit Feature Request</h2>
        <p className="mt-1 text-sm text-slate-500">Tell us what you'd like to see in Nyx.</p>

        <div className="mt-5 space-y-4">
          <div>
            <label className="block text-xs font-medium text-slate-600 mb-1">Title</label>
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-100"
              placeholder="A concise feature title..."
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-600 mb-1">Description</label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={4}
              className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-100 resize-none"
              placeholder="Describe the feature and why it would be useful..."
            />
          </div>
        </div>

        {mutation.isError && (
          <p className="mt-3 text-xs text-red-600">
            {mutation.error instanceof Error ? mutation.error.message : 'Failed to submit. Please try again.'}
          </p>
        )}

        <div className="mt-6 flex items-center justify-end gap-3">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg px-4 py-2 text-sm font-medium text-slate-600 hover:bg-slate-100 transition-colors"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => mutation.mutate()}
            disabled={!title.trim() || !description.trim() || mutation.isPending}
            className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-blue-700 disabled:opacity-50 transition-colors"
          >
            {mutation.isPending ? 'Submitting...' : 'Submit Request'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Showcase Modal ───────────────────────────────────────────────────

function ShowcaseModal({ onClose }: { onClose: () => void }) {
  const queryClient = useQueryClient();
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [techStackStr, setTechStackStr] = useState('');
  const [teamSize, setTeamSize] = useState('');
  const [nuxFeaturesStr, setNuxFeaturesStr] = useState('');
  const [url, setUrl] = useState('');

  const mutation = useMutation({
    mutationFn: () =>
      createProjectShowcase({
        title,
        description,
        techStack: techStackStr ? techStackStr.split(',').map((t) => t.trim()).filter(Boolean) : undefined,
        teamSize: teamSize ? parseInt(teamSize, 10) : undefined,
        nuxFeatures: nuxFeaturesStr ? nuxFeaturesStr.split(',').map((t) => t.trim()).filter(Boolean) : undefined,
        url: url || undefined,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['project-showcases'] });
      onClose();
    },
  });

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={onClose}>
      <div
        className="w-full max-w-lg rounded-xl border border-slate-200 bg-white p-6 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-lg font-semibold text-slate-900">Share Your Project</h2>
        <p className="mt-1 text-sm text-slate-500">Showcase what you've built with Nyx.</p>

        <div className="mt-5 space-y-4">
          <div>
            <label className="block text-xs font-medium text-slate-600 mb-1">Project Name</label>
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-100"
              placeholder="My Project"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-600 mb-1">Description</label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={3}
              className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-100 resize-none"
              placeholder="What does your project do?"
            />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1">Tech Stack (comma-separated)</label>
              <input
                type="text"
                value={techStackStr}
                onChange={(e) => setTechStackStr(e.target.value)}
                className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-100"
                placeholder="React, Node.js, PostgreSQL"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1">Team Size</label>
              <input
                type="number"
                value={teamSize}
                onChange={(e) => setTeamSize(e.target.value)}
                min={1}
                className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-100"
                placeholder="3"
              />
            </div>
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-600 mb-1">Nyx Features Used (comma-separated)</label>
            <input
              type="text"
              value={nuxFeaturesStr}
              onChange={(e) => setNuxFeaturesStr(e.target.value)}
              className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-100"
              placeholder="Lifecycle, Intake, Sprint"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-600 mb-1">Project URL</label>
            <input
              type="url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-100"
              placeholder="https://myproject.com"
            />
          </div>
        </div>

        {mutation.isError && (
          <p className="mt-3 text-xs text-red-600">
            {mutation.error instanceof Error ? mutation.error.message : 'Failed to share. Please try again.'}
          </p>
        )}

        <div className="mt-6 flex items-center justify-end gap-3">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg px-4 py-2 text-sm font-medium text-slate-600 hover:bg-slate-100 transition-colors"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => mutation.mutate()}
            disabled={!title.trim() || !description.trim() || mutation.isPending}
            className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-blue-700 disabled:opacity-50 transition-colors"
          >
            {mutation.isPending ? 'Sharing...' : 'Share Project'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Listing Card ─────────────────────────────────────────────────────

function ListingCard({ listing }: { listing: MarketplaceListing }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm hover:shadow-md transition-shadow">
      <div className="flex items-start justify-between gap-3">
        <h3 className="text-sm font-semibold text-slate-900 leading-snug line-clamp-1">{listing.title}</h3>
        <PriceBadge priceType={listing.priceType} priceAmountCents={listing.priceAmountCents} />
      </div>
      <p className="mt-2 text-xs text-slate-500 leading-relaxed line-clamp-2">{listing.description}</p>
      <div className="mt-3 flex flex-wrap gap-1.5">
        {listing.tags.slice(0, 3).map((tag) => (
          <span key={tag} className="rounded-md bg-slate-100 px-1.5 py-0.5 text-[10px] font-medium text-slate-500">
            {tag}
          </span>
        ))}
        {listing.stage && (
          <span className="rounded-md bg-violet-50 px-1.5 py-0.5 text-[10px] font-medium text-violet-600">
            {listing.stage}
          </span>
        )}
      </div>
      <div className="mt-4 flex items-center justify-between">
        <div className="flex items-center gap-3">
          {listing.avgRating != null && <StarRating rating={listing.avgRating} />}
          <span className="flex items-center gap-1 text-[10px] text-slate-400">
            <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 0 0 5.25 21h13.5A2.25 2.25 0 0 0 21 18.75V16.5M16.5 12 12 16.5m0 0L7.5 12m4.5 4.5V3" />
            </svg>
            {listing.downloadCount}
          </span>
        </div>
        {listing.category && (
          <span className="text-[10px] text-slate-400">{listing.category}</span>
        )}
      </div>
    </div>
  );
}

// ── Listings Tab (Templates / Workflows / Prompts) ───────────────────

function ListingsTab({ type }: { type: 'template' | 'workflow' | 'prompt' }) {
  const [search, setSearch] = useState('');
  const [showPublish, setShowPublish] = useState(false);

  const { data: listings = [], isLoading, isError, error } = useQuery({
    queryKey: ['marketplace', type, search],
    queryFn: () => fetchMarketplaceListings(type, search || undefined),
  });

  const typeLabel = type.charAt(0).toUpperCase() + type.slice(1);
  const pluralLabel = typeLabel + 's';

  return (
    <div>
      <div className="mb-5 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex-1 max-w-md">
          <SearchInput value={search} onChange={setSearch} placeholder={`Search ${pluralLabel.toLowerCase()}...`} />
        </div>
        <button
          type="button"
          onClick={() => setShowPublish(true)}
          className="flex items-center gap-1.5 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-blue-700 transition-colors"
        >
          <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
          </svg>
          Publish
        </button>
      </div>

      {isLoading ? (
        <Spinner />
      ) : isError ? (
        <ErrorBanner message={error instanceof Error ? error.message : 'Failed to load listings.'} />
      ) : listings.length === 0 ? (
        <EmptyState
          icon={type === 'template' ? '\u25C8' : type === 'workflow' ? '\u27F3' : '\u2726'}
          title={`No ${pluralLabel.toLowerCase()} yet`}
          subtitle={`Be the first to publish a ${type}!`}
        />
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {listings.map((listing) => (
            <ListingCard key={listing.id} listing={listing} />
          ))}
        </div>
      )}

      {showPublish && <PublishModal type={type} onClose={() => setShowPublish(false)} />}
    </div>
  );
}

// ── Feature Request Card ─────────────────────────────────────────────

function FeatureRequestCard({ request: fr }: { request: FeatureRequest }) {
  const queryClient = useQueryClient();

  const upvoteMutation = useMutation({
    mutationFn: () => toggleFeatureRequestUpvote(fr.id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['feature-requests'] });
    },
  });

  const statusColors: Record<string, string> = {
    open: 'bg-blue-50 text-blue-700 ring-blue-200',
    'in-progress': 'bg-amber-50 text-amber-700 ring-amber-200',
    planned: 'bg-violet-50 text-violet-700 ring-violet-200',
    completed: 'bg-emerald-50 text-emerald-700 ring-emerald-200',
    declined: 'bg-slate-100 text-slate-500 ring-slate-200',
  };

  const statusClass = statusColors[fr.status] ?? 'bg-slate-100 text-slate-500 ring-slate-200';

  return (
    <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm hover:shadow-md transition-shadow">
      <div className="flex gap-4">
        <button
          type="button"
          onClick={() => upvoteMutation.mutate()}
          disabled={upvoteMutation.isPending}
          className={`flex flex-col items-center gap-0.5 rounded-lg px-3 py-2 text-sm font-semibold transition-colors ${
            fr.userUpvoted
              ? 'bg-blue-50 text-blue-700'
              : 'bg-slate-50 text-slate-500 hover:bg-blue-50 hover:text-blue-600'
          }`}
        >
          <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 15.75l7.5-7.5 7.5 7.5" />
          </svg>
          {fr.upvoteCount}
        </button>
        <div className="flex-1 min-w-0">
          <div className="flex items-start justify-between gap-2">
            <h3 className="text-sm font-semibold text-slate-900 leading-snug">{fr.title}</h3>
            <span className={`flex-shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold ring-1 ${statusClass}`}>
              {fr.status}
            </span>
          </div>
          <p className="mt-1.5 text-xs text-slate-500 leading-relaxed line-clamp-2">{fr.description}</p>
          <div className="mt-3 flex items-center gap-4 text-[10px] text-slate-400">
            <span>
              {new Date(fr.createdAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
            </span>
            {fr.comments && (
              <span className="flex items-center gap-1">
                <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M7.5 8.25h9m-9 3H12m-9.75 1.51c0 1.6 1.123 2.994 2.707 3.227 1.087.16 2.185.283 3.293.369V21l4.076-4.076a1.526 1.526 0 0 1 1.037-.443 48.282 48.282 0 0 0 5.68-.494c1.584-.233 2.707-1.626 2.707-3.228V6.741c0-1.602-1.123-2.995-2.707-3.228A48.394 48.394 0 0 0 12 3c-2.392 0-4.744.175-7.043.513C3.373 3.746 2.25 5.14 2.25 6.741v6.018Z" />
                </svg>
                {fr.comments.length}
              </span>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Feature Requests Tab ─────────────────────────────────────────────

function FeatureRequestsTab() {
  const [sort, setSort] = useState<'votes' | 'newest'>('votes');
  const [showModal, setShowModal] = useState(false);

  const { data: requests = [], isLoading, isError, error } = useQuery({
    queryKey: ['feature-requests', sort],
    queryFn: () => fetchFeatureRequests(sort),
  });

  return (
    <div>
      <div className="mb-5 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setSort('votes')}
            className={`rounded-lg px-3 py-1.5 text-xs font-medium transition-colors ${
              sort === 'votes' ? 'bg-blue-50 text-blue-700' : 'text-slate-500 hover:bg-slate-100'
            }`}
          >
            Most Voted
          </button>
          <button
            type="button"
            onClick={() => setSort('newest')}
            className={`rounded-lg px-3 py-1.5 text-xs font-medium transition-colors ${
              sort === 'newest' ? 'bg-blue-50 text-blue-700' : 'text-slate-500 hover:bg-slate-100'
            }`}
          >
            Newest
          </button>
        </div>
        <button
          type="button"
          onClick={() => setShowModal(true)}
          className="flex items-center gap-1.5 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-blue-700 transition-colors"
        >
          <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
          </svg>
          Submit Request
        </button>
      </div>

      {isLoading ? (
        <Spinner />
      ) : isError ? (
        <ErrorBanner message={error instanceof Error ? error.message : 'Failed to load feature requests.'} />
      ) : requests.length === 0 ? (
        <EmptyState
          icon="\u25CE"
          title="No feature requests yet"
          subtitle="Submit the first request and let the community vote!"
        />
      ) : (
        <div className="space-y-3">
          {requests.map((fr) => (
            <FeatureRequestCard key={fr.id} request={fr} />
          ))}
        </div>
      )}

      {showModal && <FeatureRequestModal onClose={() => setShowModal(false)} />}
    </div>
  );
}

// ── Showcase Card ────────────────────────────────────────────────────

function ShowcaseCard({ project }: { project: ProjectShowcase }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm hover:shadow-md transition-shadow">
      <div className="flex items-start justify-between gap-3">
        <h3 className="text-sm font-semibold text-slate-900 leading-snug">{project.title}</h3>
        {project.url && (
          <a
            href={project.url}
            target="_blank"
            rel="noopener noreferrer"
            className="flex-shrink-0 rounded-md p-1 text-slate-400 hover:bg-slate-100 hover:text-blue-600 transition-colors"
            title="Visit project"
          >
            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" d="M13.5 6H5.25A2.25 2.25 0 0 0 3 8.25v10.5A2.25 2.25 0 0 0 5.25 21h10.5A2.25 2.25 0 0 0 18 18.75V10.5m-10.5 6L21 3m0 0h-5.25M21 3v5.25" />
            </svg>
          </a>
        )}
      </div>
      <p className="mt-2 text-xs text-slate-500 leading-relaxed line-clamp-3">{project.description}</p>

      {project.techStack.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-1.5">
          {project.techStack.map((tech) => (
            <span key={tech} className="rounded-md bg-slate-100 px-1.5 py-0.5 text-[10px] font-medium text-slate-600">
              {tech}
            </span>
          ))}
        </div>
      )}

      {project.nuxFeatures.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {project.nuxFeatures.map((feat) => (
            <span key={feat} className="rounded-md bg-blue-50 px-1.5 py-0.5 text-[10px] font-medium text-blue-600">
              {feat}
            </span>
          ))}
        </div>
      )}

      <div className="mt-4 flex items-center gap-3 text-[10px] text-slate-400">
        {project.teamSize != null && (
          <span className="flex items-center gap-1">
            <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" d="M15 19.128a9.38 9.38 0 0 0 2.625.372 9.337 9.337 0 0 0 4.121-.952 4.125 4.125 0 0 0-7.533-2.493M15 19.128v-.003c0-1.113-.285-2.16-.786-3.07M15 19.128v.106A12.318 12.318 0 0 1 8.624 21c-2.331 0-4.512-.645-6.374-1.766l-.001-.109a6.375 6.375 0 0 1 11.964-3.07M12 6.375a3.375 3.375 0 1 1-6.75 0 3.375 3.375 0 0 1 6.75 0Zm8.25 2.25a2.625 2.625 0 1 1-5.25 0 2.625 2.625 0 0 1 5.25 0Z" />
            </svg>
            {project.teamSize} {project.teamSize === 1 ? 'person' : 'people'}
          </span>
        )}
        <span>
          {new Date(project.createdAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
        </span>
      </div>
    </div>
  );
}

// ── Showcase Tab ─────────────────────────────────────────────────────

function ShowcaseTab() {
  const [showModal, setShowModal] = useState(false);

  const { data: projects = [], isLoading, isError, error } = useQuery({
    queryKey: ['project-showcases'],
    queryFn: () => fetchProjectShowcases(),
  });

  return (
    <div>
      <div className="mb-5 flex items-center justify-end">
        <button
          type="button"
          onClick={() => setShowModal(true)}
          className="flex items-center gap-1.5 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-blue-700 transition-colors"
        >
          <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
          </svg>
          Share Project
        </button>
      </div>

      {isLoading ? (
        <Spinner />
      ) : isError ? (
        <ErrorBanner message={error instanceof Error ? error.message : 'Failed to load showcases.'} />
      ) : projects.length === 0 ? (
        <EmptyState
          icon="\u25C9"
          title="No projects shared yet"
          subtitle="Be the first to showcase what you've built with Nyx!"
        />
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          {projects.map((project) => (
            <ShowcaseCard key={project.id} project={project} />
          ))}
        </div>
      )}

      {showModal && <ShowcaseModal onClose={() => setShowModal(false)} />}
    </div>
  );
}

// ── Pipeline Card ────────────────────────────────────────────────────

function PipelineCard({ lifecycle }: { lifecycle: LifecycleResponse }) {
  const [expanded, setExpanded] = useState(false);
  const { activeLifecycleSlug, setActiveLifecycleSlug } = useUIStore();
  const isActive = activeLifecycleSlug === lifecycle.slug;

  return (
    <div className={`rounded-xl border bg-white shadow-sm hover:shadow-md transition-shadow ${isActive ? 'border-blue-400 ring-1 ring-blue-200' : 'border-slate-200'}`}>
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="w-full p-5 text-left"
      >
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-3 min-w-0">
            <span className="text-2xl flex-shrink-0">{lifecycle.icon}</span>
            <div className="min-w-0">
              <h3 className="text-sm font-semibold text-slate-900 leading-snug">{lifecycle.label}</h3>
              <p className="mt-0.5 text-xs text-slate-500 line-clamp-1">{lifecycle.description}</p>
            </div>
          </div>
          <div className="flex items-center gap-2 flex-shrink-0">
            <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-semibold text-slate-600">
              {lifecycle.stages.length} stages
            </span>
            {lifecycle.isDefault && (
              <span className="rounded-full bg-blue-50 px-2 py-0.5 text-[10px] font-semibold text-blue-600 ring-1 ring-blue-200">
                Default
              </span>
            )}
            <svg
              className={`h-4 w-4 text-slate-400 transition-transform ${expanded ? 'rotate-180' : ''}`}
              fill="none"
              viewBox="0 0 24 24"
              strokeWidth={1.5}
              stroke="currentColor"
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="m19.5 8.25-7.5 7.5-7.5-7.5" />
            </svg>
          </div>
        </div>

        {/* Stage flow preview */}
        <div className="mt-3 flex items-center gap-1 overflow-hidden">
          {lifecycle.stages.map((stage, i) => (
            <div key={stage.id} className="flex items-center gap-1 min-w-0">
              <span
                className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] font-medium whitespace-nowrap"
                style={{ backgroundColor: stage.hex + '18', color: stage.hex }}
              >
                <span
                  className="inline-block h-1.5 w-1.5 rounded-full flex-shrink-0"
                  style={{ backgroundColor: stage.hex }}
                />
                {stage.abbreviation}
              </span>
              {i < lifecycle.stages.length - 1 && (
                <svg className="h-3 w-3 flex-shrink-0 text-slate-300" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M8.25 4.5l7.5 7.5-7.5 7.5" />
                </svg>
              )}
            </div>
          ))}
        </div>
      </button>

      {/* Use Pipeline action bar */}
      <div className="flex items-center justify-end gap-2 px-5 pb-3">
        {isActive ? (
          <span className="flex items-center gap-1.5 rounded-lg bg-blue-50 px-3 py-1.5 text-xs font-semibold text-blue-700 ring-1 ring-blue-200">
            <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" d="m4.5 12.75 6 6 9-13.5" />
            </svg>
            Active Pipeline
          </span>
        ) : (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              setActiveLifecycleSlug(lifecycle.slug);
            }}
            className="rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-medium text-white shadow-sm hover:bg-blue-700 transition-colors"
          >
            Use Pipeline
          </button>
        )}
      </div>

      {expanded && (
        <div className="border-t border-slate-100 px-5 pb-5 pt-4">
          <div className="space-y-3">
            {lifecycle.stages.map((stage, i) => (
              <div key={stage.id} className="flex gap-3">
                <div className="flex flex-col items-center">
                  <span
                    className="flex h-6 w-6 items-center justify-center rounded-full text-[10px] font-bold text-white flex-shrink-0"
                    style={{ backgroundColor: stage.hex }}
                  >
                    {i + 1}
                  </span>
                  {i < lifecycle.stages.length - 1 && (
                    <div className="w-px flex-1 bg-slate-200 mt-1" />
                  )}
                </div>
                <div className="pb-3 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm">{stage.icon}</span>
                    <span className="text-sm font-semibold text-slate-800">{stage.label}</span>
                    <span className="text-[10px] text-slate-400">{stage.subtitle}</span>
                  </div>
                  <p className="mt-0.5 text-xs text-slate-500">{stage.description}</p>
                  <div className="mt-1.5 flex items-center gap-3 text-[10px] text-slate-400">
                    <span>Who: {stage.who}</span>
                  </div>
                  {stage.docs && stage.docs.length > 0 && (
                    <div className="mt-1.5 flex flex-wrap gap-1">
                      {stage.docs.map((doc) => (
                        <span
                          key={doc}
                          className="rounded px-1.5 py-0.5 text-[10px] font-medium"
                          style={{ backgroundColor: stage.hex + '12', color: stage.hex }}
                        >
                          {doc}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Pipelines Tab ────────────────────────────────────────────────────

function PipelinesTab() {
  const [search, setSearch] = useState('');

  const { data: lifecycles = [], isLoading, isError, error } = useQuery({
    queryKey: ['lifecycles'],
    queryFn: fetchLifecycles,
  });

  const filtered = search
    ? lifecycles.filter(
        (lc) =>
          lc.label.toLowerCase().includes(search.toLowerCase()) ||
          lc.description.toLowerCase().includes(search.toLowerCase()),
      )
    : lifecycles;

  return (
    <div>
      <div className="mb-5 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex-1 max-w-md">
          <SearchInput value={search} onChange={setSearch} placeholder="Search pipelines..." />
        </div>
        <span className="text-xs text-slate-400">
          {filtered.length} pipeline{filtered.length !== 1 ? 's' : ''} available
        </span>
      </div>

      {isLoading ? (
        <Spinner />
      ) : isError ? (
        <ErrorBanner message={error instanceof Error ? error.message : 'Failed to load pipelines.'} />
      ) : filtered.length === 0 ? (
        <EmptyState
          icon="\u25CB"
          title="No pipelines found"
          subtitle={search ? 'Try a different search term.' : 'No lifecycle pipelines are configured yet.'}
        />
      ) : (
        <div className="space-y-3">
          {filtered.map((lc) => (
            <PipelineCard key={lc.id} lifecycle={lc} />
          ))}
        </div>
      )}
    </div>
  );
}

// ── Marketplace Page ─────────────────────────────────────────────────

export function Marketplace() {
  const [activeTab, setActiveTab] = useState<MarketplaceTab>('pipelines');

  return (
    <>
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-slate-900">Community Marketplace</h1>
        <p className="mt-1 text-sm text-slate-500">
          Discover and share templates, workflows, prompts, and projects
        </p>
      </div>

      {/* Tab bar */}
      <div className="mb-6 border-b border-slate-200">
        <nav className="-mb-px flex gap-1 overflow-x-auto">
          {TABS.map((tab) => (
            <button
              key={tab.key}
              type="button"
              onClick={() => setActiveTab(tab.key)}
              className={`flex items-center gap-2 whitespace-nowrap border-b-2 px-4 py-2.5 text-sm font-medium transition-colors ${
                activeTab === tab.key
                  ? 'border-blue-600 text-blue-700'
                  : 'border-transparent text-slate-500 hover:border-slate-300 hover:text-slate-700'
              }`}
            >
              <span className="text-base">{tab.icon}</span>
              {tab.label}
            </button>
          ))}
        </nav>
      </div>

      {/* Tab content */}
      <div>
        {activeTab === 'pipelines' && <PipelinesTab />}
        {activeTab === 'templates' && <ListingsTab type="template" />}
        {activeTab === 'workflows' && <ListingsTab type="workflow" />}
        {activeTab === 'prompts' && <ListingsTab type="prompt" />}
        {activeTab === 'feature-requests' && <FeatureRequestsTab />}
        {activeTab === 'showcase' && <ShowcaseTab />}
      </div>
    </>
  );
}

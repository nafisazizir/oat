'use client';

import { cn } from '@oat/ui';
import { Button } from '@oat/ui/components/button';
import { Input } from '@oat/ui/components/input';
import { Label } from '@oat/ui/components/label';
import { Textarea } from '@oat/ui/components/textarea';
import { Loader2Icon } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { toast } from 'sonner';

import type { ApiErrorBody } from '@/lib/api-types';
import { formatDay } from '@/lib/format';
import { parseVocabulary, PROFILE_LIMITS, type ProfileDto, type ProfileInput } from '@/lib/profile';

function Field({
  id,
  label,
  hint,
  count,
  children,
}: {
  id: string;
  label: string;
  hint?: string;
  /** `[used, max]`: shown once the field is past half its limit. */
  count?: [number, number];
  children: React.ReactNode;
}) {
  const [used, max] = count ?? [0, 0];
  return (
    <div className="grid gap-2 py-4 first:pt-0 last:pb-0 sm:grid-cols-[11rem_1fr] sm:gap-6">
      <div className="flex flex-col gap-0.5 sm:pt-1.5">
        <Label htmlFor={id} className="font-medium">
          {label}
        </Label>
        {hint && (
          <p id={`${id}-hint`} className="text-xs text-muted-foreground">
            {hint}
          </p>
        )}
      </div>
      <div className="flex min-w-0 flex-col gap-1">
        {children}
        {count && used > max / 2 && (
          <p
            className={cn(
              'text-right text-xs tabular-nums',
              used > max ? 'text-destructive' : 'text-muted-foreground',
            )}
            aria-live="polite"
          >
            {used} / {max}
          </p>
        )}
      </div>
    </div>
  );
}

async function saveProfile(input: ProfileInput): Promise<ProfileDto> {
  const res = await fetch('/api/profile', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
    credentials: 'same-origin',
    cache: 'no-store',
  }).catch(() => null);
  if (!res) throw new Error('You’re offline or the server can’t be reached.');
  const json = (await res.json().catch(() => undefined)) as unknown;
  if (!res.ok) {
    throw new Error((json as ApiErrorBody | undefined)?.error?.message ?? 'Couldn’t save.');
  }
  return json as ProfileDto;
}

const toForm = (p: ProfileDto) => ({
  name: p.name,
  role: p.role,
  team: p.team,
  about: p.about,
  vocabulary: p.vocabulary.join('\n'),
});

/** "About me" (4.6): name, role, team, what I care about, names and terms to spell right. */
export function ProfileForm({ profile }: { profile: ProfileDto }) {
  const router = useRouter();
  const [saved, setSaved] = useState(profile);
  const [form, setForm] = useState(() => toForm(profile));
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const terms = parseVocabulary(form.vocabulary);
  const tooLong = terms.some((t) => t.length > PROFILE_LIMITS.vocabularyTermLength);
  const dirty = JSON.stringify(form) !== JSON.stringify(toForm(saved));
  const nameMissing = !form.name.trim();
  const set =
    (key: keyof typeof form) =>
    (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
      setForm((f) => ({ ...f, [key]: event.target.value }));

  return (
    <form
      className="flex flex-col"
      data-testid="profile-form"
      onSubmit={(event) => {
        event.preventDefault();
        startTransition(async () => {
          try {
            const next = await saveProfile({ ...form, vocabulary: terms });
            setSaved(next);
            setForm(toForm(next));
            setError(null);
            toast.success('Profile saved', {
              description: 'New enhancements and chats will use it.',
            });
            // The sidebar shows the name.
            router.refresh();
          } catch (err) {
            setError(err instanceof Error ? err.message : 'Couldn’t save.');
          }
        });
      }}
    >
      <div className="flex flex-col divide-y">
        <Field id="profile-name" label="Name" hint="How notes refer to you.">
          <Input
            id="profile-name"
            value={form.name}
            onChange={set('name')}
            maxLength={PROFILE_LIMITS.name}
            autoComplete="name"
            required
            placeholder={saved.email.split('@')[0]}
            aria-describedby="profile-name-hint"
            disabled={pending}
            className="sm:max-w-80"
          />
        </Field>
        <Field id="profile-role" label="Role" hint="For example Account executive or Designer.">
          <Input
            id="profile-role"
            value={form.role}
            onChange={set('role')}
            maxLength={PROFILE_LIMITS.role}
            autoComplete="organization-title"
            aria-describedby="profile-role-hint"
            disabled={pending}
            className="sm:max-w-80"
          />
        </Field>
        <Field id="profile-team" label="Team or company">
          <Input
            id="profile-team"
            value={form.team}
            onChange={set('team')}
            maxLength={PROFILE_LIMITS.team}
            autoComplete="organization"
            disabled={pending}
            className="sm:max-w-80"
          />
        </Field>
        <Field
          id="profile-about"
          label="What I care about"
          hint="What your notes should pay attention to: goals, customers, projects."
          count={[form.about.length, PROFILE_LIMITS.about]}
        >
          <Textarea
            id="profile-about"
            value={form.about}
            onChange={set('about')}
            maxLength={PROFILE_LIMITS.about}
            rows={4}
            aria-describedby="profile-about-hint"
            disabled={pending}
            className="min-h-24"
          />
        </Field>
        <Field
          id="profile-vocabulary"
          label="Names and terms"
          hint="One per line. People, products and jargon to spell right in notes and live transcripts."
          count={[terms.length, PROFILE_LIMITS.vocabularyTerms]}
        >
          <Textarea
            id="profile-vocabulary"
            value={form.vocabulary}
            onChange={set('vocabulary')}
            rows={4}
            aria-describedby="profile-vocabulary-hint"
            aria-invalid={tooLong || undefined}
            disabled={pending}
            placeholder={'Brightsmile\nDentaCore\nMei Lin'}
            className="min-h-24 font-mono md:text-sm"
          />
          {tooLong && (
            <p className="text-xs text-destructive">
              Keep each term under {PROFILE_LIMITS.vocabularyTermLength} characters.
            </p>
          )}
        </Field>
      </div>
      {error && (
        <p role="alert" className="pt-4 text-sm text-destructive" data-testid="profile-error">
          {error}
        </p>
      )}
      <div className="flex flex-wrap items-center justify-end gap-3 pt-6">
        {saved.updatedAt && (
          <span className="mr-auto text-xs text-muted-foreground" data-testid="profile-saved-at">
            Last saved {formatDay(saved.updatedAt)}
          </span>
        )}
        <Button
          type="submit"
          disabled={!dirty || nameMissing || pending}
          data-testid="profile-save"
        >
          {pending && <Loader2Icon data-icon="inline-start" className="animate-spin" />}
          Save
        </Button>
      </div>
    </form>
  );
}

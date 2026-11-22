'use client';

import { errorMessage, useSettings } from './services';
import { cn } from '@oat/ui';
import { Alert, AlertDescription } from '@oat/ui/components/alert';
import { Button } from '@oat/ui/components/button';
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from '@oat/ui/components/field';
import { Input } from '@oat/ui/components/input';
import { Spinner } from '@oat/ui/components/spinner';
import { Textarea } from '@oat/ui/components/textarea';
import { IconAlertCircle } from '@tabler/icons-react';
import { useState, useTransition } from 'react';
import { toast } from 'sonner';

import {
  parseVocabulary,
  PROFILE_LIMITS,
  type ProfileDto,
  type ProfileInput,
} from '@oat/services/dto/profile';

function Row({
  id,
  label,
  hint,
  count,
  invalid,
  children,
}: {
  id: string;
  label: string;
  hint?: string;
  /** `[used, max]`: shown once the field is past half its limit. */
  count?: [number, number];
  invalid?: boolean;
  children: React.ReactNode;
}) {
  const [used, max] = count ?? [0, 0];
  return (
    <Field
      data-invalid={invalid || undefined}
      className="gap-2 sm:grid sm:grid-cols-[11rem_minmax(0,1fr)] sm:items-start sm:gap-6"
    >
      <FieldContent className="sm:pt-1.5">
        <FieldLabel htmlFor={id}>{label}</FieldLabel>
        {hint && <FieldDescription id={`${id}-hint`}>{hint}</FieldDescription>}
      </FieldContent>
      <div className="flex min-w-0 flex-col gap-1">
        {children}
        {count && used > max / 2 && (
          <p
            className={cn(
              'text-end text-label-12 tabular-nums',
              used > max ? 'text-red-900' : 'text-gray-900',
            )}
            aria-live="polite"
          >
            {used} / {max}
          </p>
        )}
      </div>
    </Field>
  );
}

const formatDay = (date: string | Date) =>
  new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(new Date(date));

const toForm = (p: ProfileDto) => ({
  name: p.name,
  role: p.role,
  team: p.team,
  about: p.about,
  vocabulary: p.vocabulary.join('\n'),
});

/** "About me" (4.6): name, role, team, what I care about, names and terms to spell right. */
export function ProfileForm({ profile }: { profile: ProfileDto }) {
  const { client, onProfileChanged } = useSettings();
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
      className="flex flex-col gap-6"
      data-testid="profile-form"
      onSubmit={(event) => {
        event.preventDefault();
        if (!dirty || nameMissing || pending) return;
        startTransition(async () => {
          try {
            const next = await client.profile.update({
              ...form,
              vocabulary: terms,
            } satisfies ProfileInput);
            setSaved(next);
            setForm(toForm(next));
            setError(null);
            toast.success('Profile saved', {
              description: 'New enhancements and chats will use it.',
            });
            // The sidebar shows the name.
            onProfileChanged?.();
          } catch (err) {
            setError(errorMessage(err, 'Couldn’t save.'));
          }
        });
      }}
    >
      <FieldGroup className="gap-5">
        <Row id="profile-name" label="Name" hint="How notes refer to you.">
          <Input
            size="sm"
            id="profile-name"
            value={form.name}
            onChange={set('name')}
            maxLength={PROFILE_LIMITS.name}
            autoComplete="name"
            required
            placeholder={saved.email.split('@')[0]}
            aria-describedby="profile-name-hint"
            disabled={pending}
          />
        </Row>
        <Row id="profile-role" label="Role" hint="For example Account executive or Designer.">
          <Input
            size="sm"
            id="profile-role"
            value={form.role}
            onChange={set('role')}
            maxLength={PROFILE_LIMITS.role}
            autoComplete="organization-title"
            aria-describedby="profile-role-hint"
            disabled={pending}
          />
        </Row>
        <Row id="profile-team" label="Team or company">
          <Input
            size="sm"
            id="profile-team"
            value={form.team}
            onChange={set('team')}
            maxLength={PROFILE_LIMITS.team}
            autoComplete="organization"
            disabled={pending}
          />
        </Row>
        <Row
          id="profile-about"
          label="What I care about"
          hint="Goals, customers and projects your notes should pay attention to."
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
        </Row>
        <Row
          id="profile-vocabulary"
          label="Names and terms"
          hint="One per line. Spelled right in notes and live transcripts."
          count={[terms.length, PROFILE_LIMITS.vocabularyTerms]}
          invalid={tooLong}
        >
          <Textarea
            id="profile-vocabulary"
            value={form.vocabulary}
            onChange={set('vocabulary')}
            rows={4}
            aria-describedby={
              tooLong
                ? 'profile-vocabulary-hint profile-vocabulary-error'
                : 'profile-vocabulary-hint'
            }
            aria-invalid={tooLong || undefined}
            disabled={pending}
            placeholder={'Brightsmile\nDentaCore\nMei Lin'}
            className="min-h-24 text-copy-14-mono"
          />
          {tooLong && (
            <FieldError id="profile-vocabulary-error">
              Keep each term under {PROFILE_LIMITS.vocabularyTermLength} characters.
            </FieldError>
          )}
        </Row>
      </FieldGroup>
      {error && (
        <Alert variant="destructive">
          <IconAlertCircle />
          <AlertDescription data-testid="profile-error">{error}</AlertDescription>
        </Alert>
      )}
      <div className="flex flex-wrap items-center justify-end gap-3">
        {saved.updatedAt && (
          <span className="me-auto text-copy-13 text-gray-900" data-testid="profile-saved-at">
            Last saved {formatDay(saved.updatedAt)}
          </span>
        )}
        <Button
          type="submit"
          disabled={!dirty || nameMissing || pending}
          data-testid="profile-save"
        >
          {pending && <Spinner data-icon="inline-start" />}
          Save
        </Button>
      </div>
    </form>
  );
}

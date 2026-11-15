/**
 * The first-meeting guide (9.2): after setup, the home view explains how a meeting note works — record, jot,
 * stop and let Oat write it up — until dismissed ("Got it"; per account, `onboarding:dismiss-guide`).
 */
import { Button } from '@oat/ui/components/button';
import { MicIcon, NotebookPenIcon, SparklesIcon, XIcon, type LucideIcon } from 'lucide-react';

const STEPS: { icon: LucideIcon; title: string; body: string }[] = [
  {
    icon: MicIcon,
    title: 'Start recording when the call begins',
    body: 'Press Start recording, pick the meeting under Upcoming, or say yes when Oat notices a call and asks “Start notes?”.',
  },
  {
    icon: NotebookPenIcon,
    title: 'Jot down what matters',
    body: 'Type rough notes as you go. The transcript fills in beside them: you as Me, everyone else as Them.',
  },
  {
    icon: SparklesIcon,
    title: 'Stop — Oat writes it up',
    body: 'When the meeting ends, Oat turns your notes and the transcript into clean notes. They sync to the web, ready to share.',
  },
];

export function FirstMeetingGuide({ onDismiss }: { onDismiss: () => void }) {
  return (
    <div className="flex h-full items-start justify-center overflow-y-auto px-8 py-10">
      <section
        aria-labelledby="first-meeting-title"
        className="relative flex w-full max-w-lg flex-col gap-5 rounded-xl bg-card p-6 text-card-foreground ring-1 ring-foreground/10"
        data-testid="first-meeting-guide"
      >
        <Button
          variant="ghost"
          size="icon-sm"
          className="absolute top-3 right-3"
          aria-label="Dismiss the guide"
          onClick={onDismiss}
        >
          <XIcon />
        </Button>
        <div className="flex flex-col gap-1 pr-8">
          <p className="text-xs font-medium text-muted-foreground">You’re all set</p>
          <h2 id="first-meeting-title" className="font-heading text-xl font-semibold">
            Your first meeting
          </h2>
        </div>
        <ol className="flex flex-col gap-4">
          {STEPS.map(({ icon: Icon, title, body }, i) => (
            <li key={title} className="flex gap-3">
              <div className="flex size-9 shrink-0 items-center justify-center rounded-full bg-accent text-accent-foreground">
                <Icon aria-hidden className="size-4" />
              </div>
              <div className="flex flex-col gap-0.5">
                <h3 className="text-sm font-medium">
                  <span className="sr-only">Step {i + 1}: </span>
                  {title}
                </h3>
                <p className="text-sm text-muted-foreground">{body}</p>
              </div>
            </li>
          ))}
        </ol>
        <Button className="self-end" onClick={onDismiss} data-testid="guide-dismiss">
          Got it
        </Button>
      </section>
    </div>
  );
}

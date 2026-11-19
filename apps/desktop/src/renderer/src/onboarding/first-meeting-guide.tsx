/**
 * The first-meeting guide (9.2): after setup, the home view explains how a meeting note works — record, jot,
 * stop and let Oat write it up — until dismissed ("Got it"; per account, `onboarding:dismiss-guide`).
 */
import { Button } from '@oat/ui/components/button';
import { type Icon, IconMicrophone, IconNotes, IconSparkles, IconX } from '@tabler/icons-react';

const STEPS: { icon: Icon; title: string; body: string }[] = [
  {
    icon: IconMicrophone,
    title: 'Start recording when the call begins',
    body: 'Press Start recording, pick the meeting under Upcoming, or say yes when Oat notices a call and asks “Start notes?”.',
  },
  {
    icon: IconNotes,
    title: 'Jot down what matters',
    body: 'Type rough notes as you go. The transcript fills in beside them: you as Me, everyone else as Them.',
  },
  {
    icon: IconSparkles,
    title: 'Stop — Oat writes it up',
    body: 'When the meeting ends, Oat turns your notes and the transcript into clean notes. They sync to the web, ready to share.',
  },
];

export function FirstMeetingGuide({ onDismiss }: { onDismiss: () => void }) {
  return (
    <div className="flex h-full items-start justify-center overflow-y-auto px-8 py-12">
      <section
        aria-labelledby="first-meeting-title"
        className="relative flex w-full max-w-lg flex-col gap-6 rounded-xl border border-gray-alpha-400 bg-background-100 p-6"
        data-testid="first-meeting-guide"
      >
        <Button
          variant="ghost"
          size="icon-sm"
          className="absolute end-3 top-3"
          aria-label="Dismiss the guide"
          onClick={onDismiss}
        >
          <IconX />
        </Button>
        <div className="flex flex-col gap-1 pe-8">
          <p className="text-label-13 text-brand-900">You’re all set</p>
          <h2 id="first-meeting-title" className="text-heading-20 text-gray-1000">
            Your first meeting
          </h2>
        </div>
        <ol className="flex flex-col gap-5">
          {STEPS.map(({ icon: StepIcon, title, body }, i) => (
            <li key={title} className="flex gap-3">
              <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-brand-100 text-brand-900">
                <StepIcon aria-hidden className="size-4" />
              </div>
              <div className="flex flex-col gap-1 pt-1.5">
                <h3 className="text-label-14 text-gray-1000">
                  <span className="sr-only">Step {i + 1}: </span>
                  {title}
                </h3>
                <p className="text-copy-14 text-gray-900">{body}</p>
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

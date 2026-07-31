import { useEffect, useRef, useState, type ReactNode } from "react";
import { useFormStatus } from "react-dom";
import { Button } from "@/components/ui/button";

interface SubmitButtonProps {
  pendingText: string;
  icon: ReactNode;
  children: ReactNode;
}

/**
 * Submit button that actually disables while the form is in flight.
 *
 * `useFormStatus` alone never fires here: every form in this app uses a *string* action
 * (`action="/api/..."`), and React only enters a host transition — the thing that sets
 * `pending` — for function actions or prevented-default submits. So the hook reported `false`
 * forever, the button never disabled, and a double-click on the create form produced two
 * tournaments and two burned join codes.
 *
 * The listener below is what works. It is attached to the button's own owning form (via
 * `HTMLButtonElement.form`, not a document query, so multiple forms on a page cannot cross
 * wires), which also catches Enter-key submission. It fires only when the submit was not
 * prevented — otherwise a validation rejection would disable the button permanently and
 * strand the user on a form they can no longer send.
 */
export function SubmitButton({ pendingText, icon, children }: SubmitButtonProps) {
  const { pending: transitionPending } = useFormStatus();
  const [submitted, setSubmitted] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const form = buttonRef.current?.form;
    if (!form) return;

    const onSubmit = (event: SubmitEvent) => {
      if (!event.defaultPrevented) setSubmitted(true);
    };
    form.addEventListener("submit", onSubmit);
    return () => {
      form.removeEventListener("submit", onSubmit);
    };
  }, []);

  const pending = transitionPending || submitted;

  return (
    <Button
      ref={buttonRef}
      type="submit"
      disabled={pending}
      className="w-full rounded-lg bg-purple-600 px-4 py-2 font-medium text-white transition-colors hover:bg-purple-500"
    >
      {pending ? (
        <span className="flex items-center gap-2">
          <span className="size-4 animate-spin rounded-full border-2 border-white/30 border-t-white" />
          {pendingText}
        </span>
      ) : (
        <span className="flex items-center gap-2">
          {icon}
          {children}
        </span>
      )}
    </Button>
  );
}

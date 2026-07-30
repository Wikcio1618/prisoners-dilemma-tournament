import React, { useState } from "react";
import { KeyRound, LogIn } from "lucide-react";
import { FormField } from "@/components/auth/FormField";
import { SubmitButton } from "@/components/auth/SubmitButton";
import { ServerError } from "@/components/auth/ServerError";
import { JOIN_CODE_LENGTH, JOIN_CODE_PATTERN } from "@/lib/tournament";

interface Props {
  serverError?: string | null;
  /** Pre-filled when arriving from a shared /join/<code> link. */
  initialCode?: string;
}

export default function JoinTournamentForm({ serverError, initialCode = "" }: Props) {
  const [code, setCode] = useState(initialCode);
  const [error, setError] = useState<string | undefined>();

  function handleSubmit(e: React.SubmitEvent<HTMLFormElement>) {
    if (!JOIN_CODE_PATTERN.test(code.trim())) {
      setError(`Kod musi składać się z ${String(JOIN_CODE_LENGTH)} cyfr.`);
      e.preventDefault();
    }
  }

  return (
    <form method="POST" action="/api/tournaments/join" className="space-y-4" onSubmit={handleSubmit} noValidate>
      <FormField
        id="join_code"
        // inputMode numeric brings up the digit keypad on phones, which is how a code read
        // aloud at a camp actually gets entered.
        type="text"
        label="Kod turnieju"
        value={code}
        onChange={(v) => {
          // Digits only, capped at the code length — stops a pasted "kod: 004821" from
          // failing validation for a reason the player cannot see.
          setCode(v.replace(/\D/g, "").slice(0, JOIN_CODE_LENGTH));
          if (error) setError(undefined);
        }}
        placeholder="000000"
        error={error}
        icon={<KeyRound className="size-4" />}
      />

      <ServerError message={serverError} />

      <SubmitButton pendingText="Dołączanie..." icon={<LogIn className="size-4" />}>
        Dołącz
      </SubmitButton>
    </form>
  );
}

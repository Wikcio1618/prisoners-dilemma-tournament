import React, { useState } from "react";
import { Hash, Trophy } from "lucide-react";
import { FormField } from "@/components/auth/FormField";
import { SubmitButton } from "@/components/auth/SubmitButton";
import { ServerError } from "@/components/auth/ServerError";
import { DEFAULT_ROUNDS_PER_MATCH, MAX_ROUNDS_PER_MATCH, MIN_ROUNDS_PER_MATCH } from "@/lib/tournament";

interface Props {
  serverError?: string | null;
}

/**
 * Polish per the PRD's UI-language requirement — this is the first product screen, so it sets
 * the vocabulary later slices inherit. The existing auth screens stay English.
 *
 * Client-side validation mirrors `createTournamentSchema` for immediate feedback only; the
 * server re-validates, because `rounds_per_match` has no database constraint behind it.
 */
export default function CreateTournamentForm({ serverError }: Props) {
  const [rounds, setRounds] = useState(String(DEFAULT_ROUNDS_PER_MATCH));
  const [error, setError] = useState<string | undefined>();

  function validate() {
    const value = Number(rounds);
    if (!rounds.trim() || !Number.isInteger(value)) {
      setError("Podaj liczbę całkowitą.");
      return false;
    }
    if (value < MIN_ROUNDS_PER_MATCH || value > MAX_ROUNDS_PER_MATCH) {
      setError(`Liczba rund musi być od ${String(MIN_ROUNDS_PER_MATCH)} do ${String(MAX_ROUNDS_PER_MATCH)}.`);
      return false;
    }
    setError(undefined);
    return true;
  }

  function handleSubmit(e: React.SubmitEvent<HTMLFormElement>) {
    if (!validate()) {
      e.preventDefault();
    }
  }

  return (
    <form method="POST" action="/api/tournaments" className="space-y-4" onSubmit={handleSubmit} noValidate>
      <FormField
        id="rounds_per_match"
        type="number"
        label="Liczba rund w meczu"
        value={rounds}
        onChange={(v) => {
          setRounds(v);
          if (error) setError(undefined);
        }}
        placeholder={String(DEFAULT_ROUNDS_PER_MATCH)}
        error={error}
        icon={<Hash className="size-4" />}
        hint={
          <p className="mt-1 text-xs text-blue-100/50">
            Od {MIN_ROUNDS_PER_MATCH} do {MAX_ROUNDS_PER_MATCH}. Tej wartości nie można później zmienić.
          </p>
        }
      />

      <ServerError message={serverError} />

      <SubmitButton pendingText="Tworzenie..." icon={<Trophy className="size-4" />}>
        Utwórz turniej
      </SubmitButton>
    </form>
  );
}

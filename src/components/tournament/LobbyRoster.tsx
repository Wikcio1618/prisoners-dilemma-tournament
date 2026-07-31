import { useEffect, useRef, useState } from "react";
import { Users } from "lucide-react";
import { MAX_PLAYERS_PER_TOURNAMENT } from "@/lib/tournament";

interface Player {
  user_id: string;
  joined_at: string;
  /** Null only if the profile row is missing, which the trigger should make impossible. */
  display_name: string | null;
}

interface Props {
  tournamentId: string;
  currentUserId: string;
  initialPlayers: Player[];
  initialStatus: string;
}

/** How often to re-fetch the roster while the tournament is still in lobby. */
const POLL_MS = 4000;

/** Consecutive transient failures tolerated before the poll gives up and says so. */
const MAX_FAILURES = 3;

/**
 * Roster that fills as players join.
 *
 * Polling rather than Supabase Realtime: this project already has one realtime mechanism
 * (F-02's Durable Objects) and a second would need its own policy-aware channel setup for a
 * list of at most 50 rows.
 *
 * The interval stops once the tournament leaves lobby, and on unmount — otherwise a tab left
 * open on a finished tournament polls forever.
 */
export default function LobbyRoster({ tournamentId, currentUserId, initialPlayers, initialStatus }: Props) {
  const [players, setPlayers] = useState<Player[]>(initialPlayers);
  const [status, setStatus] = useState(initialStatus);
  const [lost, setLost] = useState(false);
  const failures = useRef(0);

  useEffect(() => {
    if (status !== "lobby" || lost) return;

    // AbortController rather than a cancelled flag: unmounting aborts the request in flight,
    // so no response can arrive after cleanup and there is no state update to guard against.
    const controller = new AbortController();

    const timer = setInterval(() => {
      void (async () => {
        try {
          const res = await fetch(`/api/tournaments/${tournamentId}/players`, {
            headers: { Accept: "application/json" },
            signal: controller.signal,
          });
          if (res.status === 401 || res.status === 403 || res.status === 404) {
            // Terminal: the session expired, or this caller is no longer a member (they left
            // in another tab). Retrying cannot recover either, and an unattended tab would
            // otherwise poll a dead endpoint every few seconds indefinitely.
            setLost(true);
            return;
          }
          if (!res.ok) {
            failures.current += 1;
            if (failures.current >= MAX_FAILURES) setLost(true);
            return;
          }
          failures.current = 0;
          const body: { status: string; players: Player[] } = await res.json();
          setPlayers(body.players);
          setStatus(body.status);
        } catch {
          // Includes the AbortError from cleanup. A dropped poll is not worth surfacing —
          // the next tick retries, and the roster on screen is still the last known good one.
        }
      })();
    }, POLL_MS);

    return () => {
      controller.abort();
      clearInterval(timer);
    };
  }, [tournamentId, status, lost]);

  return (
    <div>
      <h2 className="flex items-center gap-2 text-sm text-blue-100/80">
        <Users className="size-4" />
        Gracze ({players.length}/{MAX_PLAYERS_PER_TOURNAMENT})
      </h2>
      <ul className="mt-3 space-y-1">
        {players.map((p) => (
          <li
            key={p.user_id}
            className="flex items-center justify-between rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm"
          >
            <span className="text-blue-100/90">{p.display_name ?? p.user_id.slice(0, 8)}</span>
            {p.user_id === currentUserId ? <span className="text-xs text-purple-300">to Ty</span> : null}
          </li>
        ))}
      </ul>
      {lost ? <p className="mt-3 text-xs text-amber-300">Utracono połączenie z poczekalnią. Odśwież stronę.</p> : null}
      {players.length < 2 ? (
        <p className="mt-3 text-xs text-blue-100/50">Potrzeba co najmniej dwóch graczy, aby turniej miał sens.</p>
      ) : null}
    </div>
  );
}

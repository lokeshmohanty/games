-- worker/migrations/0008_match_teams.sql — who played for whom in a team
-- match (branch `standings`, 2026-11-25). worker/api/match.js is the
-- contract; docs/accounts.md "Head-to-head" the design.
--
-- Head-to-head counts a place ahead as a win, but a leaver from the winning
-- side of a team game is booked in a last place of their own: without the
-- team, their teammates would be recorded as beating them. `team` is the
-- team's label (from the report's `teams`, else "#<slot>" from the game's
-- ranking); NULL for every other kind of match and for matches before this.
--
-- Additive only: a Worker from before it never reads the column. Apply it
-- before deploying the Worker that writes it (docs/accounts.md
-- "Migrations"): that Worker's match commits fail without it.

ALTER TABLE match_players ADD COLUMN team TEXT;

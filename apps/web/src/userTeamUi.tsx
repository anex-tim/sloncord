export type TeamFlags = {
  isPlatformRoot?: boolean;
  isPlatformModerator?: boolean;
  isSloncordTeam?: boolean;
};

export function teamFlagsFromProfile(profile: TeamFlags | null | undefined): TeamFlags {
  if (!profile) return {};
  return {
    isPlatformRoot: !!profile.isPlatformRoot,
    isPlatformModerator: !!profile.isPlatformModerator,
    isSloncordTeam: !!(profile.isSloncordTeam || profile.isPlatformRoot || profile.isPlatformModerator),
  };
}

export function isSloncordTeamUser(flags: TeamFlags | null | undefined): boolean {
  return !!(flags?.isSloncordTeam || flags?.isPlatformRoot || flags?.isPlatformModerator);
}

export function slonTeamNickClass(flags: TeamFlags | null | undefined): string {
  if (!flags) return "";
  if (flags.isPlatformRoot) return "slon-team-nick slon-team-nick--root";
  if (flags.isPlatformModerator) return "slon-team-nick slon-team-nick--mod";
  return "";
}

export function SlonTeamBadge({ flags }: { flags?: TeamFlags | null }) {
  if (!isSloncordTeamUser(flags)) return null;
  return <div className="slon-team-badge">Команда Sloncord</div>;
}

export function teamFlagsFromRealtimePayload(payload: unknown): { userId: string; flags: TeamFlags } | null {
  const p = payload as Record<string, unknown> | null | undefined;
  const userId = String(p?.userId || "");
  if (!userId) return null;
  return { userId, flags: teamFlagsFromProfile(p as TeamFlags) };
}

/** Голосовой канал в боковой панели сервера (строка + ростер). */
import { useEffect, useState } from "react";
import { SlonIcon } from "./icons/SlonIcon";

export function VoiceChannelSidebarItem({
  channel,
  dragCategoryId,
  showPrivateIcon,
  activeVoiceChannelId,
  voiceConnected,
  voiceJoining,
  voiceState,
  voicePresenceByChannelId,
  profile,
  userAvatarUrlByUserId,
  voicePeerNames,
  canManage,
  canModerate,
  canDragUsers,
  channelDropLine,
  voiceUserDropTarget,
  onBeginDrag,
  onDragEnd,
  onDragOver,
  onDrop,
  dropChannel,
  onBeginUserDrag,
  onUserDragOver,
  onUserDrop,
  onRowClick,
  voiceChannelTimerVisible,
  formatCallDuration,
  mergeScreenShareUserIds,
  isUserSpeakingInVoice,
  openUserCard,
  openScreenView,
  setChannelMenu,
  channelMenuOpenForId,
}) {
  const channelId = String(channel.id);
  const channelKey = channelId.toLowerCase();
  const isConnectedHere =
    String(activeVoiceChannelId || "").toLowerCase() === channelKey && (voiceConnected || voiceJoining);
  const presence = voicePresenceByChannelId[channelId] || voicePresenceByChannelId[channelKey] || null;
  const meId = String(profile?.id || "");
  const timerVisible = voiceChannelTimerVisible(presence, profile?.id, isConnectedHere);
  const [timerTick, setTimerTick] = useState(() => Date.now());
  useEffect(() => {
    if (!timerVisible) return undefined;
    setTimerTick(Date.now());
    const t = setInterval(() => setTimerTick(Date.now()), 1000);
    return () => clearInterval(t);
  }, [timerVisible, presence?.startedAtUtc]);
  const presenceIds = (presence?.userIds || [])
    .map((x) => String(x))
    .filter((id) => id && id.toLowerCase() !== meId.toLowerCase());
  const presenceSharers = new Set(
    (presence?.screenShareUserIds || []).map((x) => String(x)).filter((id) => id && id !== meId)
  );
  const isUserDropTarget =
    voiceUserDropTarget?.channelId != null && String(voiceUserDropTarget.channelId) === channelId;

  let roster = null;
  if (isConnectedHere) {
    const seen = new Set();
    const rosterRaw = [];
    for (const list of [presence?.userIds, isConnectedHere ? voiceState.rosterUserIds : null]) {
      for (const x of list || []) {
        const id = String(x || "").trim();
        if (!id) continue;
        const k = id.toLowerCase();
        if (seen.has(k) || k === meId.toLowerCase()) continue;
        seen.add(k);
        rosterRaw.push(id);
      }
    }
    const sharers = new Set(
      (Array.isArray(presence?.screenShareUserIds)
        ? presence.screenShareUserIds
        : (voiceState.screenShareUserIds || [])
      ).map((x) => String(x)).filter(Boolean)
    );
    const meSpeaking = isUserSpeakingInVoice(profile?.id, channelId);
    const meSharing = sharers.has(meId) || !!voiceState?.sharingScreen;
    roster = (
      <ul className="voice-members-inline">
        <li className={`voice-members-inline__me ${meSpeaking ? "is-speaking" : ""}`}>
          <span className={`voice-member-avatar ${meSpeaking ? "is-speaking" : ""}`}>
            {userAvatarUrlByUserId[meId] ? (
              <img alt="" src={userAvatarUrlByUserId[meId]} />
            ) : (
              <span className="avatar-fallback">
                {(profile?.nickname || "?").trim().slice(0, 1).toUpperCase()}
              </span>
            )}
          </span>
          <span className="voice-member-name">{profile?.nickname}</span>
          {meSharing && <span className="live-pill">в эфире</span>}
          {voiceState.muted && <span className="voice-flag" title="Микрофон выключен"><SlonIcon name="mic-off" size={14} /></span>}
          {voiceState.deafened && <span className="voice-flag" title="Наушники выключены"><SlonIcon name="headphones-off" size={14} /></span>}
        </li>
        {(rosterRaw || [])
          .map((id) => {
            const sid = String(id);
            const isSp = isUserSpeakingInVoice(sid, channelId);
            const isSharing = sharers.has(sid);
            const mutedRaw = Array.isArray(presence?.mutedUserIds)
              ? presence.mutedUserIds
              : (voiceState.mutedUserIds || []);
            const deafRaw = Array.isArray(presence?.deafenedUserIds)
              ? presence.deafenedUserIds
              : (voiceState.deafenedUserIds || []);
            const isMuted = mutedRaw.some((x) => String(x) === sid);
            const isDeaf = deafRaw.some((x) => String(x) === sid);
            const draggable = !!canDragUsers;
            return (
              <li
                key={`vm-${sid}`}
                className={`${isSp ? "is-speaking" : ""}${draggable ? " voice-member-draggable" : ""}`}
                draggable={draggable}
                onDragStart={draggable ? (e) => onBeginUserDrag(sid, channelId, e) : undefined}
                onDragEnd={draggable ? () => {} : undefined}
              >
                <span className={`voice-member-avatar ${isSp ? "is-speaking" : ""}`}>
                  {userAvatarUrlByUserId[sid] ? (
                    <img alt="" src={userAvatarUrlByUserId[sid]} />
                  ) : (
                    <span className="avatar-fallback">
                      {(voicePeerNames[sid] || "?").trim().slice(0, 1).toUpperCase()}
                    </span>
                  )}
                </span>
                <span
                  className="voice-member-name"
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    openUserCard(sid, e, { showVolume: true });
                  }}
                  style={{ cursor: "pointer" }}
                  title="Настроить громкость пользователя"
                >
                  {voicePeerNames[sid] || "…"}
                </span>
                {isSharing && <span className="live-pill">в эфире</span>}
                {isMuted && <span className="voice-flag" title="Микрофон выключен"><SlonIcon name="mic-off" size={14} /></span>}
                {isDeaf && <span className="voice-flag" title="Наушники выключены"><SlonIcon name="headphones-off" size={14} /></span>}
                {isSharing && (
                  <button
                    type="button"
                    className="icon-btn screen-join-btn"
                    onClick={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      openScreenView(sid);
                    }}
                    title="Подключиться к демонстрации"
                  >
                  <SlonIcon name="expand" size={16} />
                  </button>
                )}
              </li>
            );
          })}
      </ul>
    );
  } else if (presenceIds.length > 0) {
    roster = (
      <ul className="voice-members-inline voice-members-inline--presence">
        {presenceIds.map((id) => {
          const isSharing = presenceSharers.has(id);
          const isMuted = (presence?.mutedUserIds || []).some((x) => String(x) === id);
          const isDeaf = (presence?.deafenedUserIds || []).some((x) => String(x) === id);
          const isSp = isUserSpeakingInVoice(id, channelId);
          const draggable = !!canDragUsers;
          return (
            <li
              key={`vp-${channelId}-${id}`}
              className={`${isSp ? "is-speaking" : ""}${draggable ? " voice-member-draggable" : ""}`}
              draggable={draggable}
              onDragStart={draggable ? (e) => onBeginUserDrag(id, channelId, e) : undefined}
            >
              <span className={`voice-member-avatar ${isSp ? "is-speaking" : ""}`}>
                {userAvatarUrlByUserId[id] ? (
                  <img alt="" src={userAvatarUrlByUserId[id]} />
                ) : (
                  <span className="avatar-fallback">
                    {(voicePeerNames[id] || "?").trim().slice(0, 1).toUpperCase()}
                  </span>
                )}
              </span>
              <span
                className="voice-member-name"
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  openUserCard(id, e, { showVolume: true });
                }}
                style={{ cursor: "pointer" }}
                title="Настроить громкость пользователя"
              >
                {voicePeerNames[id] || "…"}
              </span>
              {isSharing && <span className="live-pill">в эфире</span>}
              {isMuted && <span className="voice-flag" title="Микрофон выключен"><SlonIcon name="mic-off" size={14} /></span>}
              {isDeaf && <span className="voice-flag" title="Наушники выключены"><SlonIcon name="headphones-off" size={14} /></span>}
              {isSharing && (
                <button
                  type="button"
                  className="icon-btn screen-join-btn"
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    openScreenView(id);
                  }}
                  title="Подключиться к демонстрации"
                >
                  ⛶
                </button>
              )}
            </li>
          );
        })}
      </ul>
    );
  }

  const dragId = dragCategoryId != null ? String(dragCategoryId) : "";
  const showDropBefore =
    channelDropLine?.type === "channel" &&
    String(channelDropLine.id) === channelId &&
    channelDropLine.pos === "before";
  const showDropAfter =
    channelDropLine?.type === "channel" &&
    String(channelDropLine.id) === channelId &&
    channelDropLine.pos === "after";
  const dropTarget = { type: "channel", id: channelId, categoryId: dragId, pos: "before" };
  const commitDrop = dropChannel || onDrop;

  return (
    <div key={channelId} className="channel-voice-group">
      {showDropBefore && <div className="channel-drop-line" />}
      <div
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onRowClick(channelId);
          }
        }}
        className={`channel-item channel-item--voice channel-item--with-icon ${isConnectedHere ? "active" : ""}${isUserDropTarget ? " channel-item--voice-user-drop" : ""}`}
        draggable={canModerate}
        onDragStart={(e) => onBeginDrag({ type: "channel", id: channelId, categoryId: dragId }, e)}
        onDragEnd={onDragEnd}
        onDragOver={(e) => {
          // Prevent parent .channels-list handler from overriding nearest channel target.
          try { e.stopPropagation(); } catch { /* ignore */ }
          onUserDragOver(channelId, e);
          onDragOver(dropTarget, e);
        }}
        onDrop={(e) => {
          e.preventDefault();
          e.stopPropagation();
          onUserDrop(channelId);
          commitDrop(dropTarget);
        }}
        onClick={() => onRowClick(channelId)}
      >
        <span className="channel-item__kind-icon" aria-hidden>
          <SlonIcon name={(showPrivateIcon || channel.isPrivate) ? "lock" : "speaker"} size={16} />
        </span>
        <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {channel.name}
        </span>
        <span className="channel-item-spacer" />
        {(() => {
          if (!timerVisible) return null;
          const txt = formatCallDuration(presence?.startedAtUtc, timerTick);
          if (!txt) return null;
          return (
            <span className="call-timer-pill" title="Длительность звонка">
              {txt}
            </span>
          );
        })()}
        {canManage && (
          <button
            type="button"
            className="icon-btn channel-actions__more"
            title="Действия"
            aria-label="Действия"
            onMouseDown={(e) => {
              try {
                e.stopPropagation();
              } catch {
                /* ignore */
              }
            }}
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              const rect = e.currentTarget?.getBoundingClientRect?.();
              const nextOpen = String(channelMenuOpenForId || "") === channelId ? "" : channelId;
              setChannelMenu({
                openForId: nextOpen,
                x: Math.round(Number(rect?.left ?? rect?.right ?? 0)),
                y: Math.round(Number(rect?.bottom ?? 0)),
              });
            }}
          >
            <SlonIcon name="dots" size={18} />
          </button>
        )}
      </div>
      {showDropAfter && <div className="channel-drop-line" />}
      {roster}
    </div>
  );
}

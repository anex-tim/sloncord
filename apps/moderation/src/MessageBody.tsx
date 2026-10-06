import {
  fileContentUrl,
  fileKindByName,
  isImageAttachment,
  type PlatformFileAttachment,
  type PlatformMessageHit,
} from "./api";

export function messageAttachments(m: PlatformMessageHit): PlatformFileAttachment[] {
  if (Array.isArray(m.attachments) && m.attachments.length > 0) return m.attachments;
  if (m.file?.id) {
    return [{ id: m.file.id, originalName: m.file.originalName }];
  }
  return [];
}

function isVideoAttachment(file: PlatformFileAttachment): boolean {
  const ct = (file.contentType || "").toLowerCase();
  if (ct.startsWith("video/")) return true;
  return fileKindByName(file.originalName) === "video";
}

export function MessageBody({ m }: { m: PlatformMessageHit }) {
  const attachments = messageAttachments(m);
  const images = attachments.filter(isImageAttachment);
  const videos = attachments.filter(isVideoAttachment);
  const files = attachments.filter((f) => !isImageAttachment(f) && !isVideoAttachment(f));
  const hasText = Boolean(m.text?.trim());

  if (!hasText && images.length === 0 && videos.length === 0 && files.length === 0) {
    return <div className="muted">—</div>;
  }

  return (
    <>
      {hasText ? <div className="chat-msg-text">{m.text}</div> : null}
      {images.length > 0 ? (
        <div className="chat-msg-attachments">
          {images.map((f) => (
            <a
              key={f.id}
              className="chat-msg-image"
              href={fileContentUrl(f.id)}
              target="_blank"
              rel="noopener noreferrer"
              title={f.originalName || "Изображение"}
            >
              <img src={fileContentUrl(f.id)} alt={f.originalName || ""} loading="lazy" />
            </a>
          ))}
        </div>
      ) : null}
      {videos.length > 0 ? (
        <div className="chat-msg-attachments">
          {videos.map((f) => (
            <div key={f.id} className="chat-msg-video">
              <video src={fileContentUrl(f.id)} controls preload="metadata" title={f.originalName || "Видео"} />
            </div>
          ))}
        </div>
      ) : null}
      {files.length > 0 ? (
        <ul className="chat-msg-files">
          {files.map((f) => (
            <li key={f.id}>
              <a
                href={fileContentUrl(f.id)}
                target="_blank"
                rel="noopener noreferrer"
                download={f.originalName || undefined}
              >
                {f.originalName || f.id}
              </a>
            </li>
          ))}
        </ul>
      ) : null}
    </>
  );
}

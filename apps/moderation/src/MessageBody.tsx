import { useEffect, useState } from "react";
import {
  fileContentUrl,
  fileKindByName,
  isImageAttachment,
  type PlatformFileAttachment,
  type PlatformMessageHit,
} from "./api";

function useFileUrl(fileId: string): string {
  const [url, setUrl] = useState("");
  useEffect(() => {
    let cancel = false;
    setUrl("");
    fileContentUrl(fileId)
      .then((next) => {
        if (!cancel) setUrl(next);
      })
      .catch(() => {
        if (!cancel) setUrl("");
      });
    return () => {
      cancel = true;
    };
  }, [fileId]);
  return url;
}

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
            <AuthedImage key={f.id} file={f} />
          ))}
        </div>
      ) : null}
      {videos.length > 0 ? (
        <div className="chat-msg-attachments">
          {videos.map((f) => (
            <AuthedVideo key={f.id} file={f} />
          ))}
        </div>
      ) : null}
      {files.length > 0 ? (
        <ul className="chat-msg-files">
          {files.map((f) => (
            <li key={f.id}>
              <AuthedFileLink file={f} />
            </li>
          ))}
        </ul>
      ) : null}
    </>
  );
}

function AuthedImage({ file }: { file: PlatformFileAttachment }) {
  const url = useFileUrl(file.id);
  if (!url) return null;
  return (
    <a className="chat-msg-image" href={url} target="_blank" rel="noopener noreferrer" title={file.originalName || "Изображение"}>
      <img src={url} alt={file.originalName || ""} loading="lazy" />
    </a>
  );
}

function AuthedVideo({ file }: { file: PlatformFileAttachment }) {
  const url = useFileUrl(file.id);
  if (!url) return null;
  return (
    <div className="chat-msg-video">
      <video src={url} controls preload="metadata" title={file.originalName || "Видео"} />
    </div>
  );
}

function AuthedFileLink({ file }: { file: PlatformFileAttachment }) {
  const url = useFileUrl(file.id);
  if (!url) return <span>{file.originalName || file.id}</span>;
  return (
    <a href={url} target="_blank" rel="noopener noreferrer" download={file.originalName || undefined}>
      {file.originalName || file.id}
    </a>
  );
}

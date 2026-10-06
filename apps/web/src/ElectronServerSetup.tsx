import { useState } from "react";

export function ElectronServerSetup() {
  const [url, setUrl] = useState("");
  const [error, setError] = useState<string | null>(null);

  function normalize(raw: string): string | null {
    const t = raw.trim();
    if (!t) return null;
    try {
      const u = new URL(t.includes("://") ? t : `https://${t}`);
      if (u.protocol !== "http:" && u.protocol !== "https:") return null;
      u.pathname = u.pathname.replace(/\/$/, "") || "";
      return u.origin + u.pathname.replace(/\/$/, "");
    } catch {
      return null;
    }
  }

  function save() {
    const n = normalize(url);
    if (!n) {
      setError("Введите базовый URL API (как адрес сайта без пути к чату), например https://sloncord.example.com");
      return;
    }
    try {
      window.sloncord?.setApiBase?.(n);
      window.location.reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Не удалось сохранить");
    }
  }

  return (
    <div className="electron-setup">
      <div className="electron-setup__card">
        <h1 className="electron-setup__title">Подключение к серверу</h1>
        <p className="electron-setup__hint">
          Укажите адрес вашего сервера Sloncord (как в браузере, без пути к чату).
        </p>
        <input
          className="electron-setup__input"
          type="text"
          placeholder="https://ваш-сервер.ru"
          value={url}
          onChange={(e) => {
            setUrl(e.target.value);
            setError(null);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") save();
          }}
          autoFocus
        />
        {error ? <p className="electron-setup__error">{error}</p> : null}
        <button type="button" className="electron-setup__btn" onClick={save}>
          Сохранить и продолжить
        </button>
      </div>
    </div>
  );
}

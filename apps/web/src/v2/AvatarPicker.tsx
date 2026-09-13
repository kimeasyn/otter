import { useState } from "react";
import { Avatar } from "./Office";

export const avatars = [
  ["default", "기본", "블루 셔츠"],
  ["glasses", "안경", "네이비 정장"],
  ["bob", "단발", "코랄 카디건"],
  ["curly", "곱슬머리", "데님 멜빵"],
  ["cap", "모자", "레드 야구 재킷"],
  ["headset", "헤드셋", "라벤더 후드"],
] as const;

export function AvatarPicker({
  avatar = "default",
  color,
  disabled = false,
}: {
  avatar?: string;
  color?: string;
  disabled?: boolean;
}) {
  const [index, setIndex] = useState(() =>
    Math.max(
      0,
      avatars.findIndex(([id]) => id === avatar),
    ),
  );
  const [id, label, outfit] = avatars[index];
  const move = (step: number) => {
    if (!disabled)
      setIndex((current) => (current + step + avatars.length) % avatars.length);
  };
  return (
    <fieldset className="avatar-picker" disabled={disabled}>
      <legend>아바타</legend>
      <input type="hidden" name="avatar" value={id} />
      <div
        className="avatar-carousel"
        onKeyDown={(event) => {
          if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
            event.preventDefault();
            move(event.key === "ArrowLeft" ? -1 : 1);
          }
        }}
      >
        <button type="button" aria-label="이전 아바타" onClick={() => move(-1)}>
          〈
        </button>
        <div
          className="avatar-preview"
          role="status"
          aria-live="polite"
          aria-atomic="true"
        >
          <Avatar avatar={id} color={color} />
          <strong>{label}</strong>
          <small>
            {outfit} · {index + 1} / {avatars.length}
          </small>
        </div>
        <button type="button" aria-label="다음 아바타" onClick={() => move(1)}>
          〉
        </button>
      </div>
    </fieldset>
  );
}

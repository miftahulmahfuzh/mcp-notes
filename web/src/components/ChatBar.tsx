import type { FormEvent } from 'react';
import { ArrowRight } from '@phosphor-icons/react';

export interface ChatBarProps {
  left: number;
  value: string;
  onChange: (v: string) => void;
  onSubmit: (e: FormEvent<HTMLFormElement>) => void;
}

export function ChatBar({ left, value, onChange, onSubmit }: ChatBarProps) {
  return (
    <form className="chatbar" style={{ left }} onSubmit={onSubmit}>
      <input value={value} onChange={(e) => onChange(e.target.value)} placeholder="Ask about your notes" aria-label="Ask about your notes" />
      <button type="submit" className="sendbtn" data-tip="Send" aria-label="Send">
        <ArrowRight weight="duotone" />
      </button>
    </form>
  );
}

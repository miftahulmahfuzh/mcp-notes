import { createContext, useContext, useMemo, type MouseEvent, type ReactNode } from 'react';
import { segmentChat } from '../lib/chatSegments';
import { noteHref } from '../lib/deepLink';

/** What chat text needs from the page to link note ids (App provides it, phase 11). */
export interface NoteLinks {
  /** Canonical id -> the page's store holds that note (known ids link in any case). */
  isKnown: (id: string) => boolean;
  /** Open the big note editor on `id` over the current page, without navigating. */
  open: (id: string) => void;
}

export const NoteLinkContext = createContext<NoteLinks | null>(null);

/** Opens the picture named by an `img:ID` (a note image) or `upload:ID` (a pasted image) written in chat text. */
export interface ImageLinks {
  open: (source: 'img' | 'upload', id: string) => void;
}

export const ImageLinkContext = createContext<ImageLinks | null>(null);

/** `img:9-TD6`, `upload:G-0NC`: how an image is named in chat, so it is never mistaken for a note id. */
const IMAGE_TOKEN = /(?<![0-9A-Za-z_:-])(img|upload):([0-9A-Za-z]-[0-9A-Za-z]{3})(?![0-9A-Za-z_-])/gi;

const NOBODY = (): boolean => false;

export interface ChatInlineProps {
  /** One paragraph of chat text (callers split on blank lines). */
  text: string;
  /** The last paragraph of a reply that is still streaming. */
  streaming?: boolean;
}

/** One paragraph of chat text: plain text, http(s) links (new tab) and note links (open in place). */
export function ChatInline({ text, streaming = false }: ChatInlineProps) {
  const links = useContext(NoteLinkContext);
  const isKnown = links?.isKnown ?? NOBODY;
  const segs = useMemo(() => segmentChat(text, { streaming, isKnown }), [text, streaming, isKnown]);
  return (
    <>
      {segs.map((s, j) => {
        if (s.kind === 'link') {
          return (
            <a key={j} className="answer-link" href={s.href} target="_blank" rel="noreferrer noopener">
              {s.text}
            </a>
          );
        }
        if (s.kind === 'note') return <NoteLink key={j} id={s.id} text={s.text} open={links?.open ?? null} />;
        return <PlainText key={j} text={s.text} streaming={streaming && j === segs.length - 1} />;
      })}
    </>
  );
}

interface NoteLinkProps {
  id: string;
  text: string;
  open: ((id: string) => void) | null;
}

/**
 * A real link to `/?note=ID`. A plain primary click is the page's own: it opens the editor in
 * place. Ctrl/cmd/shift/alt or a non-primary button is left to the browser (new tab or window).
 * `data-note-link`, never `data-note`: flash and scroll look up the first `[data-note]`, the card.
 */
function NoteLink({ id, text, open }: NoteLinkProps) {
  const onClick = (e: MouseEvent<HTMLAnchorElement>) => {
    if (open === null) return;
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    e.stopPropagation();
    open(id);
  };
  return (
    <a className="answer-link note-link" href={noteHref(id)} data-note-link={id} data-tip="Open note" onClick={onClick}>
      {text}
    </a>
  );
}

/** Plain text, with `img:ID` / `upload:ID` tokens turned into buttons that open the picture. */
function PlainText({ text, streaming }: { text: string; streaming: boolean }) {
  const images = useContext(ImageLinkContext);
  if (images === null) return <>{text}</>;
  const out: ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(IMAGE_TOKEN)) {
    const at = m.index ?? 0;
    if (streaming && at + m[0].length === text.length) continue;
    if (at > last) out.push(text.slice(last, at));
    const source = m[1].toLowerCase() as 'img' | 'upload';
    const id = m[2].toUpperCase();
    out.push(
      <button key={at} type="button" className="img-token" data-img-token={`${source}:${id}`} onClick={() => images.open(source, id)}>
        {source}:{id}
      </button>,
    );
    last = at + m[0].length;
  }
  if (out.length === 0) return <>{text}</>;
  if (last < text.length) out.push(text.slice(last));
  return <>{out}</>;
}

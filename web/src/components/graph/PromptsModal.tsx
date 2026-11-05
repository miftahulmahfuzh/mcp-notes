import { useEffect, useRef, useState, type MouseEvent } from 'react';
import { createPortal } from 'react-dom';
import { Check, Copy, X } from '@phosphor-icons/react';
import { useCopied } from '../../hooks/useCopied';
import { chatTime, chatTimeTitle } from '../../lib/chatTime';
import { hostsLabel } from '../../lib/remote';
import { fetchSessionPrompts, type SessionPromptImage, type SessionPromptItem, type SessionPrompts } from '../../sessionDetailApi';
import { isLightboxOpen, Lightbox, type LightboxItem } from '../Lightbox';
import './PromptsModal.css';

/** The modal root carries `data-modal="prompts"`; its presence in the DOM means "the prompts modal is open". */
export const PROMPTS_SELECTOR = '[data-modal="prompts"]';

/**
 * True while the prompts modal is mounted. A window capture Esc listener registered before it
 * (NodeModal's) must return early when this is true: the modal's stopPropagation cannot stop a
 * listener on the same target that already ran.
 */
export function isPromptsOpen(doc: Document = document): boolean {
  return doc.querySelector(PROMPTS_SELECTOR) !== null;
}

/** "Copy all prompts": `1. <text>\n\n2. <text>…`, each text exactly as shown. */
export function promptsCopyText(prompts: readonly SessionPromptItem[]): string {
  return prompts.map((p) => `${p.n}. ${p.text}`).join('\n\n');
}

export interface PromptsModalProps {
  /** Canonical node id (the panel's loaded detail). */
  nodeId: string;
  /** The panel's clock, for prompt times. */
  now: Date;
  onClose: () => void;
}

type Load =
  | { state: 'loading' }
  | { state: 'ready'; data: SessionPrompts }
  | { state: 'missing' }
  | { state: 'error'; message: string };

const stop = (e: MouseEvent) => e.stopPropagation();
const ALL_KEY = 'all';
const promptKey = (n: number): string => `prompt-${n}`;

/** A prompt's pasted images as lightbox items, in paste order. */
function promptImageItems(images: readonly SessionPromptImage[]): LightboxItem[] {
  return images.map((img) => ({ id: img.id, src: img.urls.display, label: img.id, width: img.width, height: img.height }));
}

/**
 * Expand prompts (R2): every stored prompt of a node over the page, numbered, timed, in full with
 * whitespace kept, each with its own copy button and "Copy all prompts" at the top right. Loads
 * from the DB (`GET /api/sessions/:nodeId/prompts`), never the transcript. Esc, the X and the
 * backdrop close only this modal; the node panel (and the chat pop-up) stay.
 */
export function PromptsModal({ nodeId, now, onClose }: PromptsModalProps) {
  const { copied, copy } = useCopied();
  const [load, setLoad] = useState<Load>({ state: 'loading' });
  const [viewing, setViewing] = useState<{ n: number; index: number } | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const live = useRef(onClose);
  live.current = onClose;

  useEffect(() => {
    const ac = new AbortController();
    setLoad({ state: 'loading' });
    fetchSessionPrompts(nodeId, ac.signal).then(
      (d) => {
        if (!ac.signal.aborted) setLoad(d ? { state: 'ready', data: d } : { state: 'missing' });
      },
      (e: unknown) => {
        if (!ac.signal.aborted) setLoad({ state: 'error', message: e instanceof Error ? e.message : String(e) });
      },
    );
    return () => ac.abort();
  }, [nodeId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      // A lightbox over an image carried by a prompt owns Esc while it is open: it registers its own
      // window capture listener after this one, so its stopPropagation cannot stop this one from
      // running first. Yield so Esc closes only the lightbox, not the whole prompts modal.
      if (isLightboxOpen()) return;
      // Capture phase + preventDefault + stopPropagation (the Lightbox seam): the page's document
      // listeners (ProjectsPage clears the node, App closes the chat) never see this Esc, and
      // stopImmediatePropagation stops window capture listeners registered after this one.
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      live.current();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  useEffect(() => {
    // Keyboard users land in the modal; focus goes back to the expand button on close.
    const opener = document.activeElement;
    panelRef.current?.focus();
    return () => {
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
    };
  }, []);

  const data = load.state === 'ready' ? load.data : null;
  const prompts = data?.prompts ?? [];
  const allDone = copied === ALL_KEY;

  return createPortal(
    <div
      className="prm"
      data-modal="prompts"
      onClick={(e) => {
        e.stopPropagation();
        onClose();
      }}
    >
      <div
        ref={panelRef}
        className="prm-panel"
        role="dialog"
        aria-modal="true"
        aria-label={`Prompts of ${nodeId}`}
        tabIndex={-1}
        onClick={stop}
      >
        <header className="prm-head">
          <span className="prm-id">{nodeId}</span>
          <h2 className="prm-title">Prompts</h2>
          {data && <span className="prm-count">{prompts.length}</span>}
          <span className="prm-spacer" />
          <button
            type="button"
            className="ibtn hov"
            data-tip={allDone ? 'Copied' : 'Copy all prompts'}
            data-tip-side="below"
            aria-label="Copy all prompts"
            disabled={prompts.length === 0}
            onClick={() => copy(ALL_KEY, promptsCopyText(prompts))}
          >
            {allDone ? <Check weight="duotone" /> : <Copy weight="duotone" />}
          </button>
          <button type="button" className="ibtn hov" data-tip="Close" data-tip-side="below" aria-label="Close prompts" onClick={onClose}>
            <X weight="duotone" />
          </button>
        </header>

        {load.state === 'loading' && <p className="prm-dim">Loading prompts</p>}
        {load.state === 'missing' && <p className="prm-dim">No session {nodeId}</p>}
        {load.state === 'error' && <p className="prm-dim">Could not load prompts: {load.message}</p>}
        {data && data.incomplete_reason === 'not_backfilled' && (
          <p className="prm-dim">Full prompts arrive once {hostsLabel(data.host ? [data.host] : [])} backfills</p>
        )}
        {data && data.incomplete_reason === 'transcript_pruned' && (
          <p className="prm-dim">Older prompts were cut; the full text is no longer on {hostsLabel(data.host ? [data.host] : [])}</p>
        )}
        {data && prompts.length === 0 && <p className="prm-dim">None</p>}

        {prompts.length > 0 && (
          <ol className="prm-list">
            {prompts.map((p) => {
              const key = promptKey(p.n);
              const done = copied === key;
              return (
                <li key={p.n} className="prm-item" data-n={p.n}>
                  <div className="prm-item-head">
                    <span className="prm-n">{p.n}</span>
                    {p.at && (
                      <time dateTime={p.at} title={chatTimeTitle(p.at)}>
                        {chatTime(p.at, now)}
                      </time>
                    )}
                    {p.truncated && (
                      <span className="prm-cut" data-tip={data?.complete ? 'Cut at the storage limit' : 'Only an excerpt was kept'}>
                        truncated
                      </span>
                    )}
                    <button
                      type="button"
                      className="ibtn hov"
                      data-tip={done ? 'Copied' : `Copy prompt ${p.n}`}
                      aria-label={`Copy prompt ${p.n}`}
                      onClick={() => copy(key, p.text)}
                    >
                      {done ? <Check weight="duotone" /> : <Copy weight="duotone" />}
                    </button>
                  </div>
                  <div className="prm-text">{p.text}</div>
                  {p.images.length > 0 && (
                    <div className="prm-images">
                      {p.images.map((img, i) => (
                        <button
                          key={img.id}
                          type="button"
                          className={img.available ? 'prm-thumb' : 'prm-thumb prm-thumb-unavailable'}
                          data-tip={img.available ? undefined : 'Not on this machine'}
                          data-tip-side="below"
                          aria-label={`Open pasted image ${i + 1} of ${p.images.length} of prompt ${p.n}`}
                          onClick={() => setViewing({ n: p.n, index: i })}
                        >
                          <img src={img.urls.thumb} alt="" draggable={false} />
                        </button>
                      ))}
                    </div>
                  )}
                </li>
              );
            })}
          </ol>
        )}
      </div>
      {viewing &&
        (() => {
          const p = prompts.find((x) => x.n === viewing.n);
          if (!p) return null;
          return (
            <Lightbox
              items={promptImageItems(p.images)}
              index={viewing.index}
              onIndex={(index) => setViewing({ n: viewing.n, index })}
              onClose={() => setViewing(null)}
            />
          );
        })()}
    </div>,
    document.body,
  );
}

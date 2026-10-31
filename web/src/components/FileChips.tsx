import type { MouseEvent } from 'react';
import {
  DownloadSimple,
  FileAudio,
  FileCode,
  FileDoc,
  FileIcon,
  FileImage,
  FilePdf,
  FilePpt,
  FileText,
  FileVideo,
  FileXls,
  FileZip,
  FolderOpen,
  X,
  type Icon,
} from '@phosphor-icons/react';
import type { NoteFile } from '../types';
import { fileDownloadUrl, revealFile } from '../api';
import { useCapabilities } from '../hooks/useCapabilities';
import { fileKind, formatBytes, typeLabel, type FileKind } from '../lib/files';
import './FileChips.css';

const KIND_ICON: Record<FileKind, Icon> = {
  pdf: FilePdf,
  image: FileImage,
  audio: FileAudio,
  video: FileVideo,
  archive: FileZip,
  sheet: FileXls,
  slides: FilePpt,
  doc: FileDoc,
  code: FileCode,
  text: FileText,
  other: FileIcon,
};

export interface FileChipsProps {
  /** The note's live files, ascending `position`. */
  files: NoteFile[];
  /** The chip's remove icon (soft remove; App offers a 6 s undo). Absent = no remove icon. */
  onRemove?: (file: NoteFile) => void;
}

/** Per-file "Show in Explorer": only when notesd can reveal and this file's bytes are on this machine. */
function FileRevealButton({ file }: { file: Pick<NoteFile, 'id' | 'available'> }) {
  const caps = useCapabilities();
  if (!caps.reveal || !file.available) return null;
  const onClick = (e: MouseEvent<HTMLButtonElement>) => {
    e.stopPropagation();
    revealFile(file.id).catch((err: unknown) => {
      console.warn(`reveal file ${file.id} failed:`, err instanceof Error ? err.message : err);
    });
  };
  return (
    <button type="button" className="fchip-btn" data-tip="Show in Explorer" aria-label="Show in Explorer" data-reveal-file={file.id} onClick={onClick}>
      <FolderOpen weight="duotone" />
    </button>
  );
}

/**
 * A note's files as chips under the editor text (R2): type icon, name, "size · TYPE", then download,
 * reveal and remove. A file whose bytes live on the other laptop is dimmed and says where it is.
 * It cannot be downloaded or revealed from here.
 */
export function FileChips({ files, onRemove }: FileChipsProps) {
  if (files.length === 0) return null;
  return (
    <ul className="fchips" data-files="" aria-label="Files">
      {files.map((f) => {
        const Kind = KIND_ICON[fileKind(f.mime, f.name)];
        const meta = [formatBytes(f.bytes), typeLabel(f.mime, f.name), f.available ? '' : `on ${f.host ?? 'another machine'}`]
          .filter(Boolean)
          .join(' · ');
        return (
          <li key={f.id} className={f.available ? 'fchip' : 'fchip away'} data-file={f.id}>
            <span className="fchip-icon" aria-hidden="true">
              <Kind weight="duotone" />
            </span>
            <span className="fchip-name" data-tip={f.name}>
              {f.name}
            </span>
            <span className="fchip-meta" data-meta="">
              {meta}
            </span>
            {f.available && (
              <a
                className="fchip-btn"
                href={f.urls.download || fileDownloadUrl(f.id)}
                download={f.name}
                data-tip="Download"
                aria-label="Download file"
                data-download={f.id}
              >
                <DownloadSimple weight="duotone" />
              </a>
            )}
            <FileRevealButton file={f} />
            {onRemove && (
              <button
                type="button"
                className="fchip-btn"
                data-tip="Remove file"
                aria-label="Remove file"
                onClick={(e) => {
                  e.stopPropagation();
                  onRemove(f);
                }}
              >
                <X weight="duotone" />
              </button>
            )}
          </li>
        );
      })}
    </ul>
  );
}

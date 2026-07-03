import type { KeyboardEvent, MouseEvent } from 'react';
import './markdown.css';

type MarkdownContentProps = {
  content: string;
  isStreaming?: boolean;
  referenceLinks?: Record<number, ReferenceLinkTarget>;
  onReferenceLinkClick?: (referenceNumber: number) => void;
};

export type ReferenceLinkTarget =
  | string
  | {
      url?: string;
      title?: string;
    };

const referencePattern = /(?:참고|참조(?:\s+문서)?|출처)\s+(\d+)/g;

function getReferenceLinkUrl(target?: ReferenceLinkTarget) {
  if (!target) {
    return undefined;
  }

  return typeof target === 'string' ? target : target.url;
}

function getReferenceLinkTitle(target?: ReferenceLinkTarget) {
  if (!target || typeof target === 'string') {
    return undefined;
  }

  return target.title;
}

function renderSegments(
  content: string,
  referenceLinks?: Record<number, ReferenceLinkTarget>,
  onReferenceLinkClick?: (referenceNumber: number) => void,
) {
  const segments: Array<string | JSX.Element> = [];
  let lastIndex = 0;

  for (const match of content.matchAll(referencePattern)) {
    const referenceNumber = Number(match[1]);
    const referenceTarget = referenceLinks?.[referenceNumber];

    if (!referenceTarget) {
      continue;
    }

    if (match.index > lastIndex) {
      segments.push(content.slice(lastIndex, match.index));
    }

    const label = match[0];
    const title = getReferenceLinkTitle(referenceTarget);
    const url = getReferenceLinkUrl(referenceTarget);

    segments.push(
      <button
        key={`${match.index}-${referenceNumber}`}
        type="button"
        className="markdown-reference-link"
        title={title}
        data-reference-number={referenceNumber}
        onClick={(event) => {
          event.preventDefault();

          if (onReferenceLinkClick) {
            onReferenceLinkClick(referenceNumber);
            return;
          }

          if (url) {
            window.open(url, '_blank', 'noopener,noreferrer');
          }
        }}
      >
        {title ? `${label} - ${title}` : label}
      </button>,
    );

    lastIndex = match.index + label.length;
  }

  if (lastIndex < content.length) {
    segments.push(content.slice(lastIndex));
  }

  return segments.length ? segments : content;
}

export const MarkdownContent = ({
  content,
  isStreaming = false,
  referenceLinks,
  onReferenceLinkClick,
}: MarkdownContentProps) => {
  const handleClick = (_event: MouseEvent<HTMLDivElement>) => {};
  const handleKeyDown = (_event: KeyboardEvent<HTMLDivElement>) => {};

  return (
    <div
      className="markdown-surface"
      data-streaming={isStreaming ? 'true' : 'false'}
      onClick={handleClick}
      onKeyDown={handleKeyDown}
    >
      {renderSegments(content, referenceLinks, onReferenceLinkClick)}
    </div>
  );
};

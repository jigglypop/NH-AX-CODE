import { cjk } from '@streamdown/cjk';
import { createCodePlugin } from '@streamdown/code';
import { mermaid } from '@streamdown/mermaid';
import { Fragment, isValidElement } from 'react';
import type { KeyboardEvent, MouseEvent, ReactNode } from 'react';
import { Streamdown, type Components, type ControlsConfig, type StreamdownTranslations } from 'streamdown';
import 'streamdown/styles.css';
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

const codeThemes: ['github-dark-default', 'github-dark-default'] = [
  'github-dark-default',
  'github-dark-default',
];

const streamdownPlugins = {
  cjk,
  code: createCodePlugin({
    themes: codeThemes,
  }),
  mermaid,
};

const streamdownControls: ControlsConfig = {
  code: {
    copy: true,
    download: false,
  },
  mermaid: {
    copy: true,
    download: true,
    fullscreen: true,
    panZoom: true,
  },
  table: false,
};

const streamdownLinkSafety = {
  enabled: false,
};

const streamdownTranslations: Partial<StreamdownTranslations> = {
  copied: '\uBCF5\uC0AC\uB428',
  copyCode: '\uCF54\uB4DC \uBCF5\uC0AC',
  downloadDiagram: '\uB2E4\uC774\uC5B4\uADF8\uB7A8 \uB2E4\uC6B4\uB85C\uB4DC',
  viewFullscreen: '\uC804\uCCB4 \uD654\uBA74',
  exitFullscreen: '\uC804\uCCB4 \uD654\uBA74 \uB2EB\uAE30',
  close: '\uB2EB\uAE30',
};

const REFERENCE_LINK_TITLE_MAX_LENGTH = 18;

type ProtectedMarkdownSegment = {
  token: string;
  value: string;
};

type ReferenceCitationItem = {
  label: string;
  linked: boolean;
  referenceNumber: number;
};

const REFERENCE_LABEL_PATTERN = '(?:\\uCC38\\uACE0|\\uCC38\\uC870(?:\\s+\\uBB38\\uC11C)?|\\uCD9C\\uCC98)';
const REFERENCE_NUMBER_GROUP_PATTERN = '\\d+(?:\\s*[,\\uFF0C\\u3001]\\s*\\d+)*';
const referenceOnlyCitationPattern = new RegExp(
  `^\\s*(${REFERENCE_LABEL_PATTERN})\\s*(${REFERENCE_NUMBER_GROUP_PATTERN})\\s*$`,
  'u',
);

const getReferenceLinkUrl = (target?: ReferenceLinkTarget) => {
  if (!target) {
    return undefined;
  }

  return typeof target === 'string' ? target : target.url;
};

const getReferenceLinkTitle = (target?: ReferenceLinkTarget) => {
  if (!target || typeof target === 'string') {
    return undefined;
  }

  return target.title;
};

const truncateReferenceLinkTitle = (title: string) =>
  title.length > REFERENCE_LINK_TITLE_MAX_LENGTH
    ? `${title.slice(0, REFERENCE_LINK_TITLE_MAX_LENGTH)}...`
    : title;

const getReactNodeText = (children: ReactNode): string => {
  if (typeof children === 'string' || typeof children === 'number') {
    return String(children);
  }

  if (Array.isArray(children)) {
    return children.map(getReactNodeText).join('');
  }

  if (isValidElement<{ children?: ReactNode }>(children)) {
    return getReactNodeText(children.props.children);
  }

  return '';
};

const decodeReferenceText = (value: string) =>
  value
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .trim();

const createReferenceCitationItems = (
  label: string,
  numberGroup: string,
  referenceLinks: Record<number, ReferenceLinkTarget>,
  canOpenReferenceWithoutUrl: boolean,
) => {
  let hasLinkedReference = false;
  const items = Array.from(numberGroup.matchAll(/\d+/g), (match): ReferenceCitationItem => {
    const referenceNumber = Number(match[0]);
    const target = referenceLinks[referenceNumber];
    const hasReferenceTarget = Boolean(
      target && (getReferenceLinkUrl(target) || canOpenReferenceWithoutUrl),
    );
    const visibleLabel = `${label} ${match[0]}`;

    if (!hasReferenceTarget) {
      return {
        label: visibleLabel,
        linked: false,
        referenceNumber,
      };
    }

    hasLinkedReference = true;
    return {
      label: visibleLabel,
      linked: true,
      referenceNumber,
    };
  });

  return hasLinkedReference ? items : null;
};

const renderReferenceCodeChip = (
  referenceNumber: number,
  children: ReactNode,
  referenceLinks?: Record<number, ReferenceLinkTarget>,
) => {
  const referenceTitle = getReferenceLinkTitle(referenceLinks?.[referenceNumber]);
  const displayReferenceTitle = referenceTitle ? truncateReferenceLinkTitle(referenceTitle) : undefined;
  const label = displayReferenceTitle
    ? `${getReactNodeText(children)} · ${displayReferenceTitle}`
    : children;

  return (
    <code
      className="markdown-reference-link"
      data-reference-link="true"
      data-reference-number={referenceNumber}
      role="link"
      tabIndex={0}
      title={referenceTitle}
    >
      {label}
    </code>
  );
};

const renderReferenceCode = (
  children: ReactNode,
  referenceLinks?: Record<number, ReferenceLinkTarget>,
  canOpenReferenceWithoutUrl = false,
) => {
  if (!referenceLinks || !Object.keys(referenceLinks).length) {
    return null;
  }

  const match = decodeReferenceText(getReactNodeText(children)).match(referenceOnlyCitationPattern);

  if (!match) {
    return null;
  }

  const citationItems = createReferenceCitationItems(
    match[1],
    match[2],
    referenceLinks,
    canOpenReferenceWithoutUrl,
  );

  if (!citationItems) {
    return null;
  }

  return citationItems.map((item, index) => (
    <Fragment key={`${item.referenceNumber}-${index}`}>
      {index > 0 ? ' ' : null}
      {item.linked
        ? renderReferenceCodeChip(item.referenceNumber, item.label, referenceLinks)
        : item.label}
    </Fragment>
  ));
};

const createStreamdownComponents = (
  referenceLinks?: Record<number, ReferenceLinkTarget>,
  canOpenReferenceWithoutUrl = false,
): Components => ({
  inlineCode: ({ children, className, node: _node, ...props }) => {
    void _node;

    const referenceCode = renderReferenceCode(
      children,
      referenceLinks,
      canOpenReferenceWithoutUrl,
    );

    if (referenceCode) {
      return <>{referenceCode}</>;
    }

    return (
      <code className={className} {...props}>
        {children}
      </code>
    );
  },
});

const languageAliases: Record<string, string> = {
  bash: 'bash',
  css: 'css',
  html: 'html',
  java: 'java',
  javascript: 'javascript',
  js: 'javascript',
  json: 'json',
  jsx: 'jsx',
  mermaid: 'mermaid',
  powershell: 'powershell',
  python: 'python',
  py: 'python',
  shell: 'bash',
  sql: 'sql',
  ts: 'typescript',
  tsx: 'tsx',
  typescript: 'typescript',
  xml: 'xml',
  yaml: 'yaml',
};

const codeSignals = [
  /^\s*(async\s+)?function\s+\w+\s*\(/m,
  /^\s*(const|let|var)\s+\w+\s*=/m,
  /^\s*(if|for|while|switch|try|class)\s*[\s({]/m,
  /^\s*(import|export)\s+.+from\s+['"]/m,
  /^\s*console\.(log|error|warn|info)\s*\(/m,
  /=>\s*[{(]/,
  /;\s*(\/\/.*)?$/m,
];

const hasMarkdownCodeFence = (value: string) => /(^|\n)\s*(```|~~~)/.test(value);

const getLooseLanguageLabel = (line: string) => {
  const match = line.trim().match(/^([A-Za-z][\w#+.-]*)\s*:?\s*$/);

  if (!match) {
    return null;
  }

  return languageAliases[match[1].toLowerCase()] ?? null;
};

const looksLikeCodeLine = (line: string) => {
  const trimmed = line.trim();

  if (!trimmed) {
    return false;
  }

  return (
    /^(\/\/|\/\*|\*\/|\* |#|import |export |const |let |var |function |class |return |if\s*\(|for\s*\(|while\s*\(|switch\s*\(|try\s*\{|catch\s*\(|console\.|document\.|window\.|navigator\.|def |from |print\(|SELECT |WITH |INSERT |UPDATE |DELETE |graph |flowchart |sequenceDiagram|<[^>]+>|\{|\}|\[|\])/.test(
      trimmed,
    ) ||
    /(;|\{|\}|=>|\))(\s*\/\/.*)?$/.test(trimmed) ||
    /^[\w.$]+\s*=/.test(trimmed)
  );
};

const getNextNonEmptyLineIndex = (lines: string[], startIndex: number) => {
  for (let index = startIndex; index < lines.length; index += 1) {
    if (lines[index].trim()) {
      return index;
    }
  }

  return -1;
};

const fenceLooseLanguageBlocks = (content: string) => {
  const lines = content.replace(/\r\n/g, '\n').split('\n');
  const normalized: string[] = [];
  let converted = false;
  let inFence = false;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];

    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      normalized.push(line);
      continue;
    }

    const language = inFence ? null : getLooseLanguageLabel(line);
    const nextCodeIndex = language ? getNextNonEmptyLineIndex(lines, index + 1) : -1;

    if (language && nextCodeIndex > -1 && looksLikeCodeLine(lines[nextCodeIndex])) {
      const codeLines: string[] = [];

      normalized.push(`\`\`\`${language}`);
      index += 1;

      for (; index < lines.length; index += 1) {
        const codeLine = lines[index];
        const trimmed = codeLine.trim();

        if (!trimmed) {
          const nextNonEmptyIndex = getNextNonEmptyLineIndex(lines, index + 1);

          if (nextNonEmptyIndex > -1 && looksLikeCodeLine(lines[nextNonEmptyIndex])) {
            codeLines.push(codeLine);
            continue;
          }

          break;
        }

        if (!looksLikeCodeLine(codeLine)) {
          break;
        }

        codeLines.push(codeLine);
      }

      while (codeLines.at(-1)?.trim() === '') {
        codeLines.pop();
      }

      normalized.push(codeLines.join('\n').trimEnd());
      normalized.push('```');
      converted = true;
      index -= 1;
      continue;
    }

    normalized.push(line);
  }

  return {
    content: normalized.join('\n'),
    converted,
  };
};

const looksLikeStandaloneCode = (value: string) => {
  const trimmed = value.trim();

  if (!trimmed || hasMarkdownCodeFence(trimmed)) {
    return false;
  }

  const lines = trimmed.split(/\r?\n/);
  const nonEmptyLines = lines.filter((line) => line.trim());

  if (nonEmptyLines.length < 2) {
    return false;
  }

  if (!looksLikeCodeLine(nonEmptyLines[0])) {
    return false;
  }

  const signalCount = codeSignals.reduce((count, pattern) => count + Number(pattern.test(trimmed)), 0);
  const codePunctuationLines = nonEmptyLines.filter((line) => /[{}();=<>.[\]]/.test(line));

  return signalCount >= 1 && codePunctuationLines.length / nonEmptyLines.length >= 0.5;
};

const isMarkdownTableRow = (line: string) => {
  const trimmed = line.trim();

  return trimmed.includes('|') && trimmed.split('|').length >= 3;
};

const isMarkdownTableDivider = (line: string) =>
  /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(line.trim());

const normalizeMarkdownTables = (value: string) => {
  const lines = value.replace(/\r\n/g, '\n').split('\n');
  const normalized: string[] = [];
  let inFence = false;
  let previousWasTable = false;

  lines.forEach((line, index) => {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      normalized.push(line);
      previousWasTable = false;
      return;
    }

    if (inFence) {
      normalized.push(line);
      return;
    }

    const currentIsTableRow = isMarkdownTableRow(line);
    const nextIsDivider = index + 1 < lines.length && isMarkdownTableDivider(lines[index + 1]);
    const currentIsDivider = isMarkdownTableDivider(line);
    const startsTable = currentIsTableRow && nextIsDivider;
    const continuesTable = previousWasTable && (currentIsTableRow || currentIsDivider);
    const isTableLine = startsTable || continuesTable || currentIsDivider;
    const previousLine = normalized.at(-1);

    if (
      startsTable &&
      previousLine !== undefined &&
      previousLine.trim() &&
      !isMarkdownTableRow(previousLine)
    ) {
      normalized.push('');
    }

    if (!isTableLine && previousWasTable && line.trim()) {
      normalized.push('');
    }

    normalized.push(line);
    previousWasTable = isTableLine;
  });

  return normalized.join('\n');
};

const addLinkTitles = (value: string) => {
  const lines = value.replace(/\r\n/g, '\n').split('\n');
  let inFence = false;

  return lines
    .map((line) => {
      if (/^\s*(```|~~~)/.test(line)) {
        inFence = !inFence;
        return line;
      }

      if (inFence) {
        return line;
      }

      return line.replace(/(!?)\[([^\]\n]{1,140})\]\(([^)\n]+)\)/g, (match, imagePrefix, label, target) => {
        if (imagePrefix) {
          return match;
        }

        const trimmedTarget = String(target).trim();

        if (
          !trimmedTarget ||
          /\s+["'][^"']+["']$/.test(trimmedTarget)
        ) {
          return match;
        }

        const cleanLabel = String(label).replace(/[`*_]/g, '').trim();
        const title = `${cleanLabel || '참조 문서'} · ${trimmedTarget}`.replace(/\\/g, '\\\\').replace(/"/g, '\\"');

        return `[${label}](${trimmedTarget} "${title}")`;
      });
    })
    .join('\n');
};

const protectHtmlCodeTags = (value: string) => {
  const segments: ProtectedMarkdownSegment[] = [];
  const content = value.replace(/<(pre|code)\b[^>]*>[\s\S]*?<\/\1>/gi, (match) => {
    const token = `@@STREAMDOWN_CODE_TAG_${segments.length}@@`;

    segments.push({
      token,
      value: match,
    });

    return token;
  });

  return {
    content,
    restore: (nextValue: string) =>
      segments.reduce(
        (restoredValue, segment) => restoredValue.replaceAll(segment.token, segment.value),
        nextValue,
      ),
  };
};

const replaceReferenceHtmlCodeTags = (value: string) => {
  const lines = value.replace(/\r\n/g, '\n').split('\n');
  let inFence = false;

  return lines
    .map((line) => {
      if (/^\s*(```|~~~)/.test(line)) {
        inFence = !inFence;
        return line;
      }

      if (inFence) {
        return line;
      }

      return line.replace(/<code\b[^>]*>([\s\S]*?)<\/code>/gi, (match, rawCodeText) => {
        const referenceText = decodeReferenceText(String(rawCodeText));

        if (!referenceOnlyCitationPattern.test(referenceText)) {
          return match;
        }

        return `\`${referenceText}\``;
      });
    })
    .join('\n');
};

const renderContent = (content: string) => {
  const renderMarkdownText = (value: string) => {
    const referenceLinkedValue = replaceReferenceHtmlCodeTags(value);
    const protectedCodeTags = protectHtmlCodeTags(referenceLinkedValue);

    return protectedCodeTags.restore(addLinkTitles(normalizeMarkdownTables(protectedCodeTags.content)));
  };

  const looseLanguageBlocks = fenceLooseLanguageBlocks(content);

  if (looseLanguageBlocks.converted) {
    return renderMarkdownText(looseLanguageBlocks.content);
  }

  if (looksLikeStandaloneCode(content)) {
    return `\`\`\`javascript\n${content.trim()}\n\`\`\``;
  }

  return renderMarkdownText(content);
};

export const MarkdownContent = ({
  content,
  isStreaming = false,
  referenceLinks,
  onReferenceLinkClick,
}: MarkdownContentProps) => {
  const displayContent = renderContent(content);
  const streamdownComponents = createStreamdownComponents(referenceLinks, Boolean(onReferenceLinkClick));

  const activateReferenceLink = (
    referenceNumberValue: string | null | undefined,
    event: KeyboardEvent<HTMLDivElement> | MouseEvent<HTMLDivElement>,
  ) => {
    const referenceNumber = referenceNumberValue ? Number(referenceNumberValue) : NaN;
    const referenceTarget = Number.isFinite(referenceNumber) ? referenceLinks?.[referenceNumber] : undefined;
    const sourceUrl = getReferenceLinkUrl(referenceTarget);

    if (!referenceTarget && !sourceUrl) {
      return;
    }

    event.preventDefault();

    if (onReferenceLinkClick) {
      onReferenceLinkClick(referenceNumber);
      return;
    }

    if (!sourceUrl) {
      return;
    }

    window.open(sourceUrl, '_blank', 'noopener,noreferrer');
  };

  const handleClick = (event: MouseEvent<HTMLDivElement>) => {
    const target = event.target instanceof Element ? event.target.closest('[data-reference-link="true"]') : null;

    activateReferenceLink(target?.getAttribute('data-reference-number'), event);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Enter') {
      return;
    }

    const target = event.target instanceof Element ? event.target.closest('[data-reference-link="true"]') : null;

    if (!target) {
      return;
    }

    activateReferenceLink(target.getAttribute('data-reference-number'), event);
  };

  return (
    <div onClick={handleClick} onKeyDown={handleKeyDown}>
      <Streamdown
        className="markdown-surface"
        components={streamdownComponents}
        controls={streamdownControls}
        dir="auto"
        isAnimating={isStreaming}
        linkSafety={streamdownLinkSafety}
        lineNumbers={false}
        mode={isStreaming ? 'streaming' : 'static'}
        parseIncompleteMarkdown
        plugins={streamdownPlugins}
        shikiTheme={codeThemes}
        translations={streamdownTranslations}
      >
        {displayContent}
      </Streamdown>
    </div>
  );
};

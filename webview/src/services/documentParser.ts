export type ParsedDocument = {
  text: string;
  detail: string;
  truncated: boolean;
};

const MAX_DOCUMENT_TEXT_CHARS = 18000;
const MAX_PDF_PAGES = 40;
const MAX_EXCEL_SHEETS = 8;
const MAX_EXCEL_ROWS_PER_SHEET = 160;
const MAX_EXCEL_COLUMNS = 30;

/* v8 ignore next */
const getExtension = (fileName: string) => fileName.split('.').pop()?.toLowerCase() || '';

const normalizeText = (value: string) =>
  value
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

const truncateText = (text: string, limit = MAX_DOCUMENT_TEXT_CHARS) => {
  const normalizedText = normalizeText(text);

  if (normalizedText.length <= limit) {
    return {
      text: normalizedText,
      truncated: false,
    };
  }

  return {
    text: `${normalizedText.slice(0, limit)}\n\n[문서가 길어 여기서 일부만 사용했습니다.]`,
    truncated: true,
  };
};

const formatCellValue = (value: unknown) => {
  if (value === null || value === undefined) {
    return '';
  }

  if (value instanceof Date) {
    return value.toISOString().slice(0, 10);
  }

  return String(value).replace(/\s+/g, ' ').trim();
};

const isPdfTextItem = (item: unknown): item is { str: string; hasEOL?: boolean } =>
  typeof item === 'object' && item !== null && 'str' in item && typeof item.str === 'string';

const parsePlainText = async (file: File): Promise<ParsedDocument> => {
  const { text, truncated } = truncateText(await file.text());

  return {
    text,
    detail: '텍스트',
    truncated,
  };
};

const parseExcel = async (file: File): Promise<ParsedDocument> => {
  const { default: readXlsxFile } = await import('read-excel-file/browser');
  const sheets = await readXlsxFile(file);
  const sheetBlocks: string[] = [];
  let truncated = sheets.length > MAX_EXCEL_SHEETS;

  for (const sheet of sheets.slice(0, MAX_EXCEL_SHEETS)) {
    const rows = sheet.data.slice(0, MAX_EXCEL_ROWS_PER_SHEET);
    const rowLines = rows.map((row) =>
      row
        .slice(0, MAX_EXCEL_COLUMNS)
        .map(formatCellValue)
        .join('\t')
        .replace(/\t+$/g, ''),
    );

    if (sheet.data.length > rows.length) {
      truncated = true;
      rowLines.push(`[${sheet.data.length - rows.length}개 행 생략]`);
    }

    sheetBlocks.push(`[시트: ${sheet.sheet}]\n${rowLines.join('\n')}`);
  }

  const result = truncateText(sheetBlocks.join('\n\n'));

  return {
    text: result.text,
    detail: `${sheets.length}개 시트`,
    /* v8 ignore next */
    truncated: truncated || result.truncated,
  };
};

const parsePdf = async (file: File): Promise<ParsedDocument> => {
  const [{ getDocument, GlobalWorkerOptions }, workerSrc] = await Promise.all([
    import('pdfjs-dist'),
    import('pdfjs-dist/build/pdf.worker.min.mjs?url'),
  ]);
  const data = new Uint8Array(await file.arrayBuffer());

  GlobalWorkerOptions.workerSrc = workerSrc.default;

  const loadingTask = getDocument({
    data,
    disableFontFace: true,
    isEvalSupported: false,
    useWorkerFetch: false,
    useWasm: false,
  });
  const pdfDocument = await loadingTask.promise;
  const totalPages = pdfDocument.numPages;
  const pageCount = Math.min(totalPages, MAX_PDF_PAGES);
  const pageTexts: string[] = [];

  try {
    for (let pageNumber = 1; pageNumber <= pageCount; pageNumber += 1) {
      const page = await pdfDocument.getPage(pageNumber);
      const textContent = await page.getTextContent();
      const pageText = textContent.items
        .filter(isPdfTextItem)
        .map((item) => (item.hasEOL ? `${item.str}\n` : item.str))
        .join(' ');

      pageTexts.push(`[${pageNumber}페이지]\n${pageText}`);
    }
  } finally {
    await pdfDocument.destroy();
  }

  const result = truncateText(pageTexts.join('\n\n'));
  const truncated = totalPages > pageCount || result.truncated;

  return {
    text: result.text,
    detail: `${totalPages}페이지`,
    truncated,
  };
};

export const parseReferenceDocument = async (file: File): Promise<ParsedDocument> => {
  const extension = getExtension(file.name);

  if (extension === 'pdf') {
    return parsePdf(file);
  }

  if (extension === 'xlsx') {
    return parseExcel(file);
  }

  if (extension === 'csv' || extension === 'txt') {
    return parsePlainText(file);
  }

  if (extension === 'xls') {
    throw new Error('구형 XLS는 브라우저 단독 분석에서 제외했습니다. XLSX 또는 CSV로 변환해 주세요.');
  }

  throw new Error('지원하지 않는 참조 문서 형식입니다.');
};

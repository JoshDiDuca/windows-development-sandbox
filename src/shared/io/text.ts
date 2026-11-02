// Text files Windows programs write in either UTF-8 or UTF-16LE (the Epic launcher's ini, Unity's files): decoded by
// their byte-order mark, and written back in the encoding they were read in.

export type TextEncoding = 'utf8' | 'utf8bom' | 'utf16le';

export interface DecodedText {
  readonly text: string;
  readonly encoding: TextEncoding;
}

/** The text of a file's bytes: UTF-16LE with its mark, UTF-8 with or without one (the mark is not part of the text). */
export function decodeText(bytes: Buffer): DecodedText {
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe)
    return { text: bytes.subarray(2).toString('utf16le'), encoding: 'utf16le' };
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf)
    return { text: bytes.subarray(3).toString('utf8'), encoding: 'utf8bom' };
  return { text: bytes.toString('utf8'), encoding: 'utf8' };
}

/** The bytes of a text in an encoding (with its mark for UTF-16LE and UTF-8 with a mark). */
export function encodeText(text: string, encoding: TextEncoding): Buffer {
  if (encoding === 'utf16le') return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]);
  if (encoding === 'utf8bom') return Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text, 'utf8')]);
  return Buffer.from(text, 'utf8');
}
